# Repository Guidelines

## Project Structure & Module Organization

- `public/` contains the static single-page UI: `index.html`, `app.js`, and `style.css`.
- `functions/api/` is the production Cloudflare Pages Functions API. Shared D1, auth, and rate-limit code lives in `_db.js`, `_auth.js`, and `_ratelimit.js`.
- `migrations/` and `schema.sql` define the Cloudflare D1 SQLite schema.
- `app.py` and `db.py` provide the local Python HTTP/SQLite implementation; keep its behavior aligned with the Pages API where practical.
- `tests/` holds Python `unittest` files (`test_*.py`) and Node tests (`*.test.js`). `scripts/` contains destructive end-to-end smoke and integrity checks.

## Build, Test, and Development Commands

- `npm install` installs the Wrangler development dependency.
- `npm run dev` starts Cloudflare Pages locally with a local D1 database on port 8788.
- `npm test` runs Node's built-in test runner for JavaScript utilities.
- `python3 -m unittest discover -s tests -p "test_*.py" -v` runs Python auth, parsing, and SQLite tests.
- `AUTH_PIN=... AUTH_SECRET=... python3 app.py` starts the Python implementation on port 8080.

Do not run `scripts/integrity_check.py` against persistent data: it is intentionally destructive. Use a disposable local instance and set `CONFIRM_DESTRUCTIVE=1`.

## Coding Style & Naming Conventions

Use 2-space indentation in JavaScript and 4-space indentation in Python. Prefer clear `camelCase` names in JS and `snake_case` in Python. Keep API handlers thin; place shared validation and persistence logic in the corresponding shared module. Amounts are stored as integer cents and must never be calculated with floating-point storage values. There is no configured formatter or linter, so match nearby code and avoid unrelated reformatting.

## Testing Guidelines

Add focused regression tests for every behavior change. Name Python tests `test_<behavior>` inside `test_*.py`; use descriptive `node:test` names in `*.test.js`. Changes to money mutations should cover rejected balances, idempotency, and linked debt transactions. Changes to authentication should cover valid, expired, malformed, and tampered sessions.

## Commit & Pull Request Guidelines

Use concise imperative commit subjects, as in `Add unit tests...` or `Fix auth cookie handling...`. Keep a commit scoped to one logical change. Pull requests should explain user-visible behavior and data/authentication effects, list test commands run, link the relevant issue when available, and include screenshots for UI changes.

## Security & Configuration

`AUTH_PIN` and `AUTH_SECRET` are mandatory; never commit their values. Use a distinct `AUTH_SECRET` of at least 16 characters, preferably generated with `openssl rand -hex 32`. Keep `.dev.vars` and `.env` local only.
