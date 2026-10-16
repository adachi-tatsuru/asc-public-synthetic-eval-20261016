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
        self.assertEqual(self.app.request("/api/tasks/999")[0], 404)
        self.assertEqual(
            self.app.request("/api/tasks/9223372036854775808")[0], 404
        )

        with sqlite3.connect(self.db_path) as connection:
            rows = connection.execute(
                "SELECT id, name, completed FROM tasks ORDER BY id"
            ).fetchall()
        self.assertEqual(rows, [(1, "Review inventory", 0), (2, "Pack order", 0)])

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

    def test_summary_tracks_actual_completion_and_only_exact_route_is_supported(self) -> None:
        self.assertEqual(
            self.app.request("/api/summary"),
            (200, {"total": 2, "completed": 0, "pending": 2}),
        )
        self.assertEqual(self.app.request("/api/summary/unknown")[0], 404)

        self.assertEqual(
            self.app.request("/api/tasks/1", method="PATCH", value={"completed": True})[0],
            200,
        )
        status, summary = self.app.request("/api/summary")
        self.assertEqual(status, 200)
        self.assertEqual(summary, {"total": 2, "completed": 1, "pending": 1})
        self.assertEqual(set(summary), {"total", "completed", "pending"})
        self.assertEqual(summary["total"], summary["completed"] + summary["pending"])

    def test_partial_patch_body_does_not_block_an_independent_request(self) -> None:
        partial = socket.create_connection(("127.0.0.1", self.app.port), timeout=3)
        partial.settimeout(3)
        try:
            partial.sendall(
                b"PATCH /api/tasks/1 HTTP/1.1\r\n"
                b"Host: 127.0.0.1\r\n"
                b"Content-Type: application/json\r\n"
                b"Content-Length: 18\r\n"
                b"Connection: close\r\n"
                b"\r\n"
                b'{"completed":'
            )

            self.assertEqual(
                self.app.request("/api/summary"),
                (200, {"total": 2, "completed": 0, "pending": 2}),
            )

            partial.sendall(b"true}")
            response = bytearray()
            while True:
                chunk = partial.recv(4096)
                if not chunk:
                    break
                response.extend(chunk)
            self.assertIn(b" 200 ", response.partition(b"\r\n")[0])
            self.assertEqual(
                self.app.request("/api/summary"),
                (200, {"total": 2, "completed": 1, "pending": 1}),
            )
        finally:
            partial.close()

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
    async def test_toggle_then_back_waits_for_mutation_before_list_request(self) -> None:
        """A delayed PATCH must settle before the Back route starts its GET."""
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

    async def test_summary_route_has_labelled_navigation_and_confirmed_counts(self) -> None:
        screen = (ROOT / "screen.html").read_text(encoding="utf-8")

        self.assertIn('<a id="summary-link" href="#summary"', screen)
        self.assertIn('<a id="summary-list" href="#list">Back to tasks</a>', screen)
        self.assertIn('<section id="summary" aria-labelledby="summary-heading"', screen)
        self.assertIn("summary.dataset.total = String(result.total)", screen)
        self.assertIn("summary.dataset.completed = String(result.completed)", screen)
        self.assertIn("summary.dataset.pending = String(result.pending)", screen)
        self.assertIn('summaryTotal.textContent = String(result.total)', screen)
        self.assertIn('summaryCompleted.textContent = String(result.completed)', screen)
        self.assertIn('summaryPending.textContent = String(result.pending)', screen)

        summary_start = screen.index("async function showSummary(version)")
        route_start = screen.index("function route()", summary_start)
        summary_source = screen[summary_start:route_start]
        self.assertIn("while (version === routeVersion)", summary_source)
        self.assertIn("catch (requestError)", summary_source)
        self.assertIn("clearSummaryCounts();", summary_source)
        self.assertLess(
            summary_source.index('const result = await request("/api/summary")'),
            summary_source.index("catch (requestError)"),
        )
        self.assertLess(
            summary_source.index("catch (requestError)"),
            summary_source.index("await delay(SUMMARY_REFRESH_INTERVAL)"),
        )
        self.assertIn("if (version !== routeVersion) return", summary_source)

    async def test_reloaded_summary_refetches_after_overlapping_commit(self) -> None:
        """A fresh document must replace a summary captured before commit."""
        persisted_completed = 0
        commit_finished = asyncio.Event()
        observed: list[dict[str, int]] = []

        async def summary_request() -> dict[str, int]:
            return {
                "total": 2,
                "completed": persisted_completed,
                "pending": 2 - persisted_completed,
            }

        async def finish_commit() -> None:
            nonlocal persisted_completed
            for _ in range(5):
                await asyncio.sleep(0)
            persisted_completed = 1
            commit_finished.set()

        async def refresh_while_open() -> None:
            while not commit_finished.is_set() or observed[-1]["completed"] == 0:
                observed.append(await summary_request())
                await asyncio.sleep(0)

        commit = asyncio.create_task(finish_commit())
        observed.append(await summary_request())
        refresh = asyncio.create_task(refresh_while_open())
        await asyncio.gather(commit, refresh)

        self.assertEqual(observed[0], {"total": 2, "completed": 0, "pending": 2})
        self.assertGreaterEqual(
            sum(result["completed"] == 0 for result in observed),
            2,
        )
        self.assertEqual(observed[-1], {"total": 2, "completed": 1, "pending": 1})
        self.assertEqual(
            observed[-1]["total"],
            observed[-1]["completed"] + observed[-1]["pending"],
        )

    async def test_summary_refresh_hides_stale_counts_after_failure_and_recovers(self) -> None:
        """A failed post-commit confirmation cannot leave its old snapshot presented."""
        persisted_completed = 0
        responses: list[dict[str, int] | RuntimeError] = []
        presented: dict[str, int] | None = None
        error_visible = False

        async def summary_request() -> dict[str, int]:
            response = responses.pop(0)
            if isinstance(response, RuntimeError):
                raise response
            return response

        async def refresh_once() -> None:
            nonlocal presented, error_visible
            try:
                presented = await summary_request()
                error_visible = False
            except RuntimeError:
                presented = None
                error_visible = True

        responses.append(
            {"total": 2, "completed": persisted_completed, "pending": 2 - persisted_completed}
        )
        await refresh_once()
        self.assertEqual(presented, {"total": 2, "completed": 0, "pending": 2})
        self.assertFalse(error_visible)

        persisted_completed = 1
        responses.append(RuntimeError("transient summary failure"))
        await refresh_once()
        self.assertIsNone(presented)
        self.assertTrue(error_visible)

        responses.append(
            {"total": 2, "completed": persisted_completed, "pending": 2 - persisted_completed}
        )
        await refresh_once()
        self.assertEqual(presented, {"total": 2, "completed": 1, "pending": 1})
        self.assertFalse(error_visible)


if __name__ == "__main__":
    unittest.main()
