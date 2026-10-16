#!/usr/bin/env python3
"""Executable unittest coverage for the synthetic task demo."""

from __future__ import annotations

import asyncio
import json
import selectors
import socket
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from pathlib import Path


ROOT = Path(__file__).resolve().parent


class RunningApp:
    def __init__(self, db_path: Path) -> None:
        self.process = subprocess.Popen(
            [sys.executable, str(ROOT / "app.py"), "--port", "0", "--db", str(db_path)],
            cwd=ROOT,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        assert self.process.stdout is not None
        selector = selectors.DefaultSelector()
        selector.register(self.process.stdout, selectors.EVENT_READ)
        if not selector.select(timeout=5):
            self.stop()
            raise RuntimeError("server did not report readiness")
        line = self.process.stdout.readline()
        selector.close()
        if not line:
            stderr = self.process.stderr.read() if self.process.stderr else ""
            self.stop()
            raise RuntimeError(f"server exited before readiness: {stderr}")
        ready = json.loads(line)
        self.port = ready["port"]
        self.base_url = f"http://127.0.0.1:{self.port}"

    def request(
        self, path: str, *, method: str = "GET", value: object | None = None, raw: bytes | None = None
    ) -> tuple[int, object]:
        data = raw if raw is not None else (json.dumps(value).encode() if value is not None else None)
        headers = {"Content-Type": "application/json"} if data is not None else {}
        request = urllib.request.Request(
            self.base_url + path, data=data, headers=headers, method=method
        )
        try:
            response = urllib.request.urlopen(request, timeout=3)
        except urllib.error.HTTPError as error:
            return error.code, json.loads(error.read())
        with response:
            return response.status, json.loads(response.read())

    def stop(self) -> None:
        if self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(timeout=3)
        if self.process.stdout:
            self.process.stdout.close()
        if self.process.stderr:
            self.process.stderr.close()


class TaskApiTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.db_path = Path(self.temporary_directory.name) / "tasks.sqlite3"
        self.app = RunningApp(self.db_path)

    def tearDown(self) -> None:
        self.app.stop()
        self.temporary_directory.cleanup()

    def test_new_database_has_exact_seed_rows_and_api_shapes(self) -> None:
        status, tasks = self.app.request("/api/tasks")
        self.assertEqual(status, 200)
        self.assertEqual(
            tasks,
            [
                {"id": 1, "name": "Review inventory", "completed": False},
                {"id": 2, "name": "Pack order", "completed": False},
            ],
        )
        self.assertEqual(
            self.app.request("/api/tasks/1"),
            (200, {"id": 1, "name": "Review inventory", "completed": False}),
        )
        self.assertEqual(
            self.app.request("/api/summary"),
            (200, {"total": 2, "completed": 0, "pending": 2}),
        )
        self.assertEqual(self.app.request("/api/tasks/999")[0], 404)
        self.assertEqual(
            self.app.request("/api/tasks/9223372036854775808")[0], 404
        )

        with sqlite3.connect(self.db_path) as connection:
            rows = connection.execute(
                "SELECT id, name, completed FROM tasks ORDER BY id"
            ).fetchall()
        self.assertEqual(rows, [(1, "Review inventory", 0), (2, "Pack order", 0)])

    def test_summary_tracks_completion_and_survives_restart(self) -> None:
        self.assertEqual(
            self.app.request("/api/summary"),
            (200, {"total": 2, "completed": 0, "pending": 2}),
        )
        self.assertEqual(
            self.app.request("/api/tasks/1", method="PATCH", value={"completed": True})[0],
            200,
        )
        self.assertEqual(
            self.app.request("/api/summary"),
            (200, {"total": 2, "completed": 1, "pending": 1}),
        )

        self.app.stop()
        self.app = RunningApp(self.db_path)
        self.assertEqual(
            self.app.request("/api/summary"),
            (200, {"total": 2, "completed": 1, "pending": 1}),
        )

    def test_summary_route_is_exact(self) -> None:
        self.assertEqual(self.app.request("/api/summary/unknown")[0], 404)

    def test_slow_valid_patch_body_does_not_block_summary(self) -> None:
        body = b'{"completed":true}'
        request_head = (
            "PATCH /api/tasks/1 HTTP/1.0\r\n"
            "Host: 127.0.0.1\r\n"
            "Content-Type: application/json\r\n"
            f"Content-Length: {len(body)}\r\n"
            "\r\n"
        ).encode("ascii")

        summary_result: list[tuple[int, object]] = []
        summary_started = threading.Event()
        summary_done = threading.Event()

        def fetch_summary() -> None:
            try:
                summary_started.set()
                summary_result.append(self.app.request("/api/summary"))
            finally:
                summary_done.set()

        with socket.create_connection(("127.0.0.1", self.app.port), timeout=3) as stalled:
            stalled.settimeout(3)
            stalled.sendall(request_head + body[:1])
            summary_thread = threading.Thread(target=fetch_summary)
            summary_thread.start()
            self.assertTrue(summary_started.wait(timeout=1))
            self.assertTrue(summary_done.wait(timeout=1))
            time.sleep(1.1)
            stalled.sendall(body[1:])
            response = stalled.recv(4096)

        summary_thread.join(timeout=3)

        self.assertFalse(summary_thread.is_alive())
        self.assertEqual(
            summary_result,
            [(200, {"total": 2, "completed": 0, "pending": 2})],
        )
        self.assertIn(b"200 OK", response)
        self.assertEqual(
            self.app.request("/api/tasks/1"),
            (200, {"id": 1, "name": "Review inventory", "completed": True}),
        )
        self.assertEqual(
            self.app.request("/api/summary"),
            (200, {"total": 2, "completed": 1, "pending": 1}),
        )

    def test_patch_is_boolean_only_idempotent_and_invalid_input_is_unchanged(self) -> None:
        expected = {"id": 1, "name": "Review inventory", "completed": True}
        self.assertEqual(
            self.app.request("/api/tasks/1", method="PATCH", value={"completed": True}),
            (200, expected),
        )
        self.assertEqual(
            self.app.request("/api/tasks/1", method="PATCH", value={"completed": True}),
            (200, expected),
        )

        invalid_values = [
            {"completed": 1},
            {"completed": "true"},
            {"completed": False, "name": "changed"},
            {},
            [],
        ]
        for invalid in invalid_values:
            with self.subTest(invalid=invalid):
                self.assertEqual(
                    self.app.request("/api/tasks/1", method="PATCH", value=invalid)[0], 400
                )
                self.assertEqual(self.app.request("/api/tasks/1"), (200, expected))

        self.assertEqual(
            self.app.request("/api/tasks/1", method="PATCH", raw=b"not json")[0], 400
        )
        self.assertEqual(
            self.app.request(
                "/api/tasks/1",
                method="PATCH",
                raw=b'{"completed":true,"completed":false}',
            )[0],
            400,
        )
        self.assertEqual(
            self.app.request("/api/tasks/1", method="PATCH", raw=b" " * 1025)[0], 400
        )
        self.assertEqual(self.app.request("/api/tasks/1"), (200, expected))
        self.assertEqual(
            self.app.request("/api/tasks/999", method="PATCH", value={"completed": True})[0],
            404,
        )
        self.assertEqual(
            self.app.request(
                "/api/tasks/9223372036854775808",
                method="PATCH",
                value={"completed": True},
            )[0],
            404,
        )
        self.assertEqual(self.app.request("/api/tasks/1"), (200, expected))

        reset = {"id": 1, "name": "Review inventory", "completed": False}
        self.assertEqual(
            self.app.request("/api/tasks/1", method="PATCH", value={"completed": False}),
            (200, reset),
        )
        self.assertEqual(
            self.app.request("/api/tasks/1", method="PATCH", value={"completed": False}),
            (200, reset),
        )

    def test_restart_preserves_state_and_does_not_reseed(self) -> None:
        self.assertEqual(
            self.app.request("/api/tasks/2", method="PATCH", value={"completed": True})[0], 200
        )
        self.app.stop()
        with sqlite3.connect(self.db_path) as connection:
            connection.execute("DELETE FROM tasks WHERE id = ?", (1,))

        self.app = RunningApp(self.db_path)
        self.assertEqual(
            self.app.request("/api/tasks"),
            (200, [{"id": 2, "name": "Pack order", "completed": True}]),
        )
        self.assertEqual(
            self.app.request("/api/summary"),
            (200, {"total": 1, "completed": 1, "pending": 0}),
        )

    def test_only_root_page_is_served(self) -> None:
        with urllib.request.urlopen(self.app.base_url + "/", timeout=3) as response:
            page = response.read().decode()
        self.assertIn("Synthetic demo", page)
        self.assertEqual(self.app.request("/screen.html")[0], 404)
        self.assertEqual(self.app.request("/../OWNER_RULES.md")[0], 404)


class ScreenBehaviorTests(unittest.IsolatedAsyncioTestCase):
    async def test_navigation_waits_for_toggle_before_destination_request(self) -> None:
        """A delayed PATCH must settle before list or summary starts its GET."""
        screen = (ROOT / "screen.html").read_text(encoding="utf-8")

        wait_start = screen.index("async function waitForMutation(version)")
        list_start = screen.index("async function showList(version)")
        detail_start = screen.index("async function showDetail(id, version)")
        summary_start = screen.index("async function showSummary(version)")
        route_start = screen.index("function route()")
        toggle_start = screen.index('toggle.addEventListener("click"')
        script_end = screen.index("window.addEventListener", toggle_start)

        wait_source = screen[wait_start:list_start]
        list_source = screen[list_start:detail_start]
        detail_source = screen[detail_start:summary_start]
        summary_source = screen[summary_start:route_start]
        toggle_source = screen[toggle_start:script_end]

        self.assertIn("const mutation = mutationInFlight", wait_source)
        self.assertIn("await mutation", wait_source)
        self.assertLess(
            list_source.index("await waitForMutation(version)"),
            list_source.index('request("/api/tasks")'),
        )
        self.assertLess(
            detail_source.index("await waitForMutation(version)"),
            detail_source.index("request(`/api/tasks/${id}`)"),
        )
        self.assertLess(
            summary_source.index("await waitForMutation(version)"),
            summary_source.index('request("/api/summary")'),
        )
        self.assertLess(
            toggle_source.index("mutationInFlight = mutation"),
            toggle_source.index("const updated = await mutation"),
        )
        self.assertIn("keepalive: true", toggle_source)

        patch_can_finish = asyncio.Event()
        calls: list[str] = []
        persisted_completed = False
        mutation_in_flight: asyncio.Task[dict[str, object]] | None = None
        rendered_tasks: list[dict[str, object]] = []

        async def delayed_request(path: str, method: str = "GET") -> object:
            nonlocal persisted_completed
            calls.append(f"{method} {path}")
            if method == "PATCH":
                await patch_can_finish.wait()
                persisted_completed = True
                return {"id": 1, "name": "Review inventory", "completed": True}
            return [
                {"id": 1, "name": "Review inventory", "completed": persisted_completed}
            ]

        async def click_toggle() -> None:
            nonlocal mutation_in_flight
            mutation_in_flight = asyncio.create_task(
                delayed_request("/api/tasks/1", "PATCH")
            )
            await mutation_in_flight
            mutation_in_flight = None

        async def follow_back_link() -> None:
            mutation = mutation_in_flight
            if mutation is not None:
                await mutation
            rendered_tasks.extend(await delayed_request("/api/tasks"))

        toggle_action = asyncio.create_task(click_toggle())
        await asyncio.sleep(0)
        back_navigation = asyncio.create_task(follow_back_link())
        await asyncio.sleep(0)
        self.assertEqual(calls, ["PATCH /api/tasks/1"])

        patch_can_finish.set()
        await asyncio.gather(toggle_action, back_navigation)
        self.assertEqual(calls, ["PATCH /api/tasks/1", "GET /api/tasks"])
        self.assertTrue(rendered_tasks[0]["completed"])

    async def test_reloaded_summary_converges_after_competing_toggle(self) -> None:
        """A summary GET that wins the reload race must refresh after the PATCH."""
        screen = (ROOT / "screen.html").read_text(encoding="utf-8")
        summary_start = screen.index("async function showSummary(version)")
        route_start = screen.index("function route()", summary_start)
        summary_source = screen[summary_start:route_start]

        self.assertIn("while (version === routeVersion)", summary_source)
        self.assertIn('request("/api/summary")', summary_source)
        self.assertIn("await delay(SUMMARY_REFRESH_MS)", summary_source)
        self.assertLess(
            summary_source.index('request("/api/summary")'),
            summary_source.index("await delay(SUMMARY_REFRESH_MS)"),
        )

        patch_can_finish = asyncio.Event()
        first_summary_rendered = asyncio.Event()
        refresh_can_start = asyncio.Event()
        persisted_completed = False
        rendered_counts: list[dict[str, int]] = []

        async def delayed_patch() -> None:
            nonlocal persisted_completed
            await patch_can_finish.wait()
            persisted_completed = True

        async def request_summary() -> dict[str, int]:
            completed = int(persisted_completed)
            return {"total": 2, "completed": completed, "pending": 2 - completed}

        async def reloaded_summary() -> None:
            rendered_counts.append(await request_summary())
            first_summary_rendered.set()
            await refresh_can_start.wait()
            rendered_counts.append(await request_summary())

        toggle = asyncio.create_task(delayed_patch())
        reload = asyncio.create_task(reloaded_summary())
        await first_summary_rendered.wait()
        self.assertEqual(
            rendered_counts,
            [{"total": 2, "completed": 0, "pending": 2}],
        )

        patch_can_finish.set()
        await toggle
        refresh_can_start.set()
        await reload

        self.assertEqual(
            rendered_counts[-1],
            {"total": 2, "completed": 1, "pending": 1},
        )

    async def test_summary_success_preserves_toggle_failure_feedback(self) -> None:
        """A summary refresh clears its own error, not a failed mutation."""
        screen = (ROOT / "screen.html").read_text(encoding="utf-8")
        errors_start = screen.index('const errorMessages = { view: "", mutation: "" }')
        request_start = screen.index("async function request(path", errors_start)
        summary_start = screen.index("async function showSummary(version)")
        route_start = screen.index("function route()", summary_start)
        toggle_start = screen.index('toggle.addEventListener("click"')
        script_end = screen.index("window.addEventListener", toggle_start)

        errors_source = screen[errors_start:request_start]
        summary_source = screen[summary_start:route_start]
        toggle_source = screen[toggle_start:script_end]

        self.assertIn("errorMessages[source] = message", errors_source)
        self.assertIn('clearError("view")', summary_source)
        self.assertIn(
            'showError("Could not update this task. Its state was not changed here.", "mutation")',
            toggle_source,
        )

        errors = {"view": "", "mutation": ""}

        def visible_error() -> str:
            return " ".join(
                message for message in (errors["mutation"], errors["view"]) if message
            )

        mutation_can_fail = asyncio.Event()

        async def failed_mutation() -> None:
            await mutation_can_fail.wait()
            raise RuntimeError("PATCH failed")

        mutation = asyncio.create_task(failed_mutation())

        async def toggle_action() -> None:
            try:
                await mutation
            except RuntimeError:
                errors["mutation"] = "Could not update this task."

        async def summary_action() -> None:
            errors["view"] = ""
            try:
                await mutation
            except RuntimeError:
                pass
            errors["view"] = ""

        toggle = asyncio.create_task(toggle_action())
        summary = asyncio.create_task(summary_action())
        mutation_can_fail.set()
        await asyncio.gather(toggle, summary)
        self.assertEqual(visible_error(), "Could not update this task.")

        errors["view"] = "Could not load the task summary."
        self.assertIn("Could not load the task summary.", visible_error())
        errors["view"] = ""
        self.assertEqual(visible_error(), "Could not update this task.")


if __name__ == "__main__":
    unittest.main()
