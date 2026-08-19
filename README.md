# DSA Tracker — Striver A2Z

Multi-user daily-assignment tracker for the Striver A2Z sheet (474 problems from `striver_a2z_complete_sheet.csv`). Anyone can sign in with Google and gets their own progress, playlists, settings and API keys, all stored in SQLite.

## Run

1. Create an OAuth 2.0 Client ID (type **Web application**) at [Google Cloud Console → Credentials](https://console.cloud.google.com/apis/credentials) and add an authorized redirect URI:
   - `http://localhost:3210/auth/google/callback` for local use
   - `https://your-domain.com/auth/google/callback` when deployed
2. Copy `.env.example` to `.env` and fill in `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`.

```sh
node --env-file=.env server.js
# open http://localhost:3210
```

Or with Docker: `docker compose up -d` (reads the same `.env`).

## Accounts and data

- **Sign in** — Google OAuth only; sessions are opaque httpOnly cookies stored in SQLite, valid 30 days.
- **Import your TUF progress** — the **Import from TUF** page gives you a console snippet to run on takeuforward.org. It downloads a CSV of your ticked problems, which you upload back; matching is by Problem ID with a title fallback. *Merge* (default) only adds progress; *Mirror TUF exactly* also un-completes anything unticked there.
- **API keys** — each account stores its own AI / Notion / YouTube keys in Settings. The server's environment keys are never used for a user, so nobody spends the host's credit.
- **Migrating the old single-user `db.json`**:
  ```sh
  node scripts/import-legacy-db.js you@gmail.com data/db.json
  ```
  This pre-creates the account; signing in with that Google address claims it along with the imported history.

## Code layout

- `server.js` — express wiring, session → per-user data scope
- `lib/db.js` — SQLite connection and schema (`users`, `sessions`, `user_state`)
- `lib/auth.js` — Google OAuth and session handling
- `lib/catalog.js` — the shared sheet, parsed from the CSV once at boot
- `lib/store.js` — per-user state persistence, statuses
- `lib/tuf-import.js` — takeuforward CSV → progress
- `lib/assignment.js` — daily assignment algorithm
- `lib/chat.js` — conversational updates (LLM + keyword fallback)
- `lib/dashboard.js` — dashboard payload
- `lib/notion.js` — Notion database sync

## How it works

- **Daily assignment** — generated once per day as a budgeted mix (3–8 problems, set in Settings): up to 2 revision slots, 1–2 preferred-topic slots (round-robin across your preferred topics), and the rest from your current topic (falling back to sheet order). Automatic revisions prefer different topics and never repeat the same question within 30 days; explicitly marking **Revision needed** overrides that 30-day limit.
- **Statuses** — Pending, Attempted, Completed, Solved w/ help, and an independent Revision needed flag. Solved-with-help problems become automatic revision candidates after 4 days; explicitly flagged problems return after 2 days.
- **Revision topics** — completed problems from topics you select become revision candidates after 7 days, subject to the 30-day per-question interval.
- **AI coach** — select any sheet problem or click **Ask coach** on today’s cards for four progressive hint levels: nudge, core idea, steps/pseudocode, and deep walkthrough. Open the dedicated `/coach.html` workspace to continue the same side-panel conversation with a larger interface. Coach replies render safe Markdown, including headings, lists, links, tables, inline code, and copyable fenced code blocks. The current problem, hint level, and recent transcript are shared between both interfaces in browser storage. The coach can also process explicit tracker commands such as "completed 1", "add Two Sum", or "remove problem 3". Without an API key, deterministic status commands still work but coaching is unavailable.
- **API keys** — paste your own key in Settings. With provider on `auto` the provider is inferred from the key (`sk-ant-…` → Anthropic, `AIza…` → Gemini). The model name is also configurable in Settings (defaults: `claude-opus-4-8` / `gemini-2.5-flash`).
- **Notion sync** — in Settings, paste a Notion internal-integration secret and the URL of a page you've shared with that integration. The app creates a "DSA Tracker" database under it; "Sync today" / "Sync all history" push rows (one per problem per day), and status changes auto-sync a few seconds later. Build "Today" and history views in Notion by filtering on the Date column.

## Data

Everything lives in `data/dsa.db` (SQLite, created on first run). Each account holds only its own progress — the problem text, links and ordering come from `striver_a2z_complete_sheet.csv`, which is loaded once at boot and shared by every user. Adding rows to that CSV makes the new problems appear for everyone as pending.
