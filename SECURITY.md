# Security

## Credentials and secrets

- **BOT_TOKEN** — Set via environment (e.g. `.env`). Never commit it. Used for the Telegram Bot API.
- **GOLF_CLUB** — Optional. Club subdomain for Intelligent Golf (default: `kilspindie`). No secrets.
- **DATA_DIR** — Optional. Directory for JSON data files. Default: current working directory.

## Stored credentials (logins.json)

- The bot stores **member ID and PIN** in `logins.json` (or under `DATA_DIR` if set) so users do not re-enter them for every command.
- This file is **plaintext** and must be protected by the host:
  - **File permissions:** Restrict read/write to the process user only (e.g. `chmod 600 logins.json`).
  - **.gitignore:** `logins.json` is listed in `.gitignore` and must never be committed.
  - Prefer a dedicated data directory (e.g. `DATA_DIR=/var/lib/golf-bot`) on a volume with restricted access.

## Logging and PII

- User-facing error messages are generic where possible (see `shared/errorHandling.ts`).
- Server logs do not include passwords, tokens, or HTML/response bodies that could contain session data.
- Telegram user IDs may appear in logs in development; production logging is kept minimal.

## Input validation

- Login: username and password length are limited to reduce abuse.
- Date/time inputs are parsed by `chrono-node`; very long strings are not accepted.

## Dependencies

- Keep dependencies up to date (`yarn audit` / `npm audit`) and address critical issues.
- No credentials or secrets in code; use environment variables and the data directory for persistence.
