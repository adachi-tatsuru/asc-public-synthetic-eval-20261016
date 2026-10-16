#!/usr/bin/env python3
"""Loopback-only synthetic task-management demo."""

from __future__ import annotations

import argparse
import json
import re
import sqlite3
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any


MAX_REQUEST_BODY = 1024
MAX_SQLITE_INTEGER = 9_223_372_036_854_775_807
TASK_PATH = re.compile(r"^/api/tasks/([1-9][0-9]*)$")
SEED_TASKS = ((1, "Review inventory", 0), (2, "Pack order", 0))


def initialize_database(db_path: Path) -> None:
    """Create and seed the tasks table only when it does not already exist."""
    with sqlite3.connect(db_path) as connection:
        exists = connection.execute(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
            ("tasks",),
        ).fetchone()
        if exists is None:
            connection.execute(
                """
                CREATE TABLE tasks (
                    id INTEGER PRIMARY KEY,
                    name TEXT NOT NULL,
                    completed INTEGER NOT NULL CHECK(completed IN (0, 1))
                )
                """
            )
            connection.executemany(
                "INSERT INTO tasks (id, name, completed) VALUES (?, ?, ?)",
                SEED_TASKS,
            )


def task_object(row: tuple[int, str, int]) -> dict[str, object]:
    return {"id": row[0], "name": row[1], "completed": bool(row[2])}


def parse_task_id(value: str) -> int | None:
    """Return a SQLite-safe positive task ID, or None when it cannot exist."""
    maximum = str(MAX_SQLITE_INTEGER)
    if len(value) > len(maximum) or (len(value) == len(maximum) and value > maximum):
        return None
    return int(value)


class TaskServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(
        self,
        server_address: tuple[str, int],
        handler_class: type[BaseHTTPRequestHandler],
        db_path: Path,
        screen: bytes,
    ) -> None:
        self.db_path = db_path
        self.screen = screen
        super().__init__(server_address, handler_class)


class TaskHandler(BaseHTTPRequestHandler):
    server: TaskServer
    server_version = "SyntheticTaskDemo"
    sys_version = ""

    def do_GET(self) -> None:
        try:
            self._do_get()
        except Exception as error:  # Keep implementation details out of responses.
            self._internal_error(error)

    def _do_get(self) -> None:
        if self.path == "/":
            self._send_bytes(200, self.server.screen, "text/html; charset=utf-8")
            return

        if self.path == "/api/tasks":
            with self._connection() as connection:
                rows = connection.execute(
                    "SELECT id, name, completed FROM tasks ORDER BY id"
                ).fetchall()
            self._send_json(200, [task_object(row) for row in rows])
            return

        match = TASK_PATH.fullmatch(self.path)
        if match:
            task_id = parse_task_id(match.group(1))
            if task_id is None:
                self._send_error_json(404, "Task not found")
                return
            with self._connection() as connection:
                row = connection.execute(
                    "SELECT id, name, completed FROM tasks WHERE id = ?",
                    (task_id,),
                ).fetchone()
            if row is None:
                self._send_error_json(404, "Task not found")
            else:
                self._send_json(200, task_object(row))
            return

        self._send_error_json(404, "Not found")

    def do_PATCH(self) -> None:
        try:
            self._do_patch()
        except Exception as error:  # Keep implementation details out of responses.
            self._internal_error(error)

    def _do_patch(self) -> None:
        match = TASK_PATH.fullmatch(self.path)
        if match is None:
            self._send_error_json(404, "Not found")
            return

        task_id = parse_task_id(match.group(1))
        if task_id is None:
            self._send_error_json(404, "Task not found")
            return

        payload = self._read_json_object()
        if payload is None:
            return
        if set(payload) != {"completed"} or type(payload["completed"]) is not bool:
            self._send_error_json(400, "Expected exactly one boolean completed field")
            return

        completed = int(payload["completed"])
        with self._connection() as connection:
            update = connection.execute(
                "UPDATE tasks SET completed = ? WHERE id = ?",
                (completed, task_id),
            )
            if update.rowcount == 0:
                self._send_error_json(404, "Task not found")
                return
            updated = connection.execute(
                "SELECT id, name, completed FROM tasks WHERE id = ?",
                (task_id,),
            ).fetchone()

        self._send_json(200, task_object(updated))

    def _read_json_object(self) -> dict[str, Any] | None:
        if self.headers.get("Transfer-Encoding") is not None:
            self.close_connection = True
            self._send_error_json(400, "A bounded Content-Length is required")
            return None

        raw_length = self.headers.get("Content-Length")
        try:
            length = int(raw_length) if raw_length is not None else -1
        except ValueError:
            length = -1
        if length < 0 or length > MAX_REQUEST_BODY:
            self.close_connection = True
            self._send_error_json(400, "Invalid request body size")
            return None

        body = self.rfile.read(length)

        def reject_duplicate_keys(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
            result: dict[str, Any] = {}
            for key, value in pairs:
                if key in result:
                    raise ValueError("duplicate key")
                result[key] = value
            return result

        try:
            payload = json.loads(body.decode("utf-8"), object_pairs_hook=reject_duplicate_keys)
        except (UnicodeDecodeError, json.JSONDecodeError, ValueError):
            self._send_error_json(400, "Invalid JSON object")
            return None
        if not isinstance(payload, dict):
            self._send_error_json(400, "Invalid JSON object")
            return None
        return payload

    def _connection(self) -> sqlite3.Connection:
        return sqlite3.connect(self.server.db_path, timeout=5)

    def _send_json(self, status: int, value: object) -> None:
        body = json.dumps(value, separators=(",", ":")).encode("utf-8")
        self._send_bytes(status, body, "application/json; charset=utf-8")

    def _send_error_json(self, status: int, message: str) -> None:
        self._send_json(status, {"error": message})

    def _send_bytes(self, status: int, body: bytes, content_type: str) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(body)

    def _internal_error(self, error: Exception) -> None:
        print(f"request failed: {type(error).__name__}", file=sys.stderr, flush=True)
        try:
            self._send_error_json(500, "Internal server error")
        except (BrokenPipeError, ConnectionError):
            pass


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--db", type=Path, required=True)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    server: TaskServer | None = None
    try:
        initialize_database(args.db)
        screen = Path(__file__).with_name("screen.html").read_bytes()
        server = TaskServer(("127.0.0.1", args.port), TaskHandler, args.db, screen)
        actual_port = server.server_address[1]
        print(json.dumps({"port": actual_port}, separators=(",", ":")), flush=True)
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    except Exception as error:
        print(f"startup failed: {type(error).__name__}", file=sys.stderr, flush=True)
        return 1
    finally:
        if server is not None:
            server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
