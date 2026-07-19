# DSA Tracker — Striver A2Z

Personal daily-assignment tracker for the Striver A2Z sheet (474 problems imported from `striver_a2z_complete_sheet.csv`).

## Run

```sh
node server.js
# open http://localhost:3210
```

## Code layout

- `server.js` — express routes only
- `lib/store.js` — db.json persistence, CSV import, statuses
- `lib/assignment.js` — daily assignment algorithm
- `lib/chat.js` — conversational updates (LLM + keyword fallback)
- `lib/dashboard.js` — dashboard payload
- `lib/notion.js` — Notion database sync

## How it works

- **Daily assignment** — generated once per day as a budgeted mix (3–8 problems, set in Settings): up to 2 revision slots, 1–2 preferred-topic slots (round-robin across your preferred topics), and the rest from your current topic (falling back to sheet order). Automatic revisions prefer different topics and never repeat the same question within 30 days; explicitly marking **Revision needed** overrides that 30-day limit.
- **Statuses** — Pending, Attempted, Completed, Solved w/ help, and an independent Revision needed flag. Solved-with-help problems become automatic revision candidates after 4 days; explicitly flagged problems return after 2 days.
- **Revision topics** — completed problems from topics you select become revision candidates after 7 days, subject to the 30-day per-question interval.
- **AI coach** — select any sheet problem or click **Ask coach** on today’s cards for four progressive hint levels: nudge, core idea, steps/pseudocode, and deep walkthrough. Open the dedicated `/coach.html` workspace to continue the same side-panel conversation with a larger interface. Coach replies render safe Markdown, including headings, lists, links, tables, inline code, and copyable fenced code blocks. The current problem, hint level, and recent transcript are shared between both interfaces in browser storage. The coach can also process explicit tracker commands such as "completed 1", "add Two Sum", or "remove problem 3". Without an API key, deterministic status commands still work but coaching is unavailable.
- **API keys** — paste one in Settings, or set `ANTHROPIC_API_KEY` / `GEMINI_API_KEY` before starting the server. The model name is also configurable in Settings (defaults: `claude-opus-4-8` / `gemini-2.5-flash`).
- **Notion sync** — in Settings, paste a Notion internal-integration secret and the URL of a page you've shared with that integration. The app creates a "DSA Tracker" database under it; "Sync today" / "Sync all history" push rows (one per problem per day), and status changes auto-sync a few seconds later. Build "Today" and history views in Notion by filtering on the Date column.

## Data

Everything lives in `data/db.json` (created on first run from the CSV; `Completed`/`Revision` columns in the CSV seed the initial statuses). Delete it to re-import from scratch.
