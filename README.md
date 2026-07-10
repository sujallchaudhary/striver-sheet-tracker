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

- **Daily assignment** — generated once per day as a budgeted mix (3–8 problems, set in Settings): up to 2 revision slots, 1–2 preferred-topic slots (round-robin across your preferred topics), and the rest from your current topic (falling back to sheet order). If nothing is due for revision yet but you flagged revision topics, the oldest finished problems from those topics are pulled in early so revision always appears.
- **Statuses** — Pending, Attempted (couldn't solve — comes back soon), Completed, Solved w/ help (auto-returns for revision after 4 days), Revision needed (returns after 2 days).
- **Revision topics** — completed problems from topics you flag cycle back every ~7 days.
- **Chat updates** — type things like "completed 1 and 2, couldn't solve 3". With an API key it uses an LLM (Claude or Gemini) and understands natural phrasing / problem names; without one it falls back to keyword parsing.
- **API keys** — paste one in Settings, or set `ANTHROPIC_API_KEY` / `GEMINI_API_KEY` before starting the server. The model name is also configurable in Settings (defaults: `claude-opus-4-8` / `gemini-2.5-flash`).
- **Notion sync** — in Settings, paste a Notion internal-integration secret and the URL of a page you've shared with that integration. The app creates a "DSA Tracker" database under it; "Sync today" / "Sync all history" push rows (one per problem per day), and status changes auto-sync a few seconds later. Build "Today" and history views in Notion by filtering on the Date column.

## Data

Everything lives in `data/db.json` (created on first run from the CSV; `Completed`/`Revision` columns in the CSV seed the initial statuses). Delete it to re-import from scratch.
