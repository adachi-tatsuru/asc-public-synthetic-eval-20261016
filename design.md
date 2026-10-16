# Purpose
Synthetic local task management: list and detail form one user-value slice backed by the local HTTP API and SQLite. The Python standard-library server binds only to `127.0.0.1`; `/` serves the bundled screen, `GET /api/tasks` returns the ordered list, and `GET /api/tasks/<id>` returns one task.

# Scenarios
Start with the two seed tasks in a new disposable database, filter them case-insensitively at `#list`, open task 1 at `#task/1`, and set its completion state through `PATCH /api/tasks/1`. Loading, no-match, and request-error states reflect API outcomes. Navigation waits for an in-flight completion update before fetching the destination, so immediately returning to the list cannot render pre-update state. Returning to the list, revisiting detail, reloading, or restarting with the same database fetches and displays the persisted state; an existing table is never reseeded over user changes.

# Limits
Loopback demo with a caller-supplied disposable SQLite path only. PATCH accepts exactly `{completed: boolean}`, uses a bounded body and parameterized SQL, and rejects invalid input without changing the database. Task IDs outside SQLite's positive signed-integer range are treated as missing. There is no legacy database migration, arbitrary file serving, external request, external resource, browser storage, public deployment, or production authentication/authorization.
