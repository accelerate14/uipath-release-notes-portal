# Release Radar v1.2

Internal portal that shows UiPath Automation Cloud release notes, analysed by a UiPath agent for
impact and breaking changes. Full design, root-cause analysis and hosting steps are in `docs/`.

## How it works

`pipeline/run.js` downloads each month's public markdown from docs.uipath.com, splits it into
self-contained chunks under Orchestrator's 10,000-character input limit, sends each chunk to the
agent through its API trigger (server-side, async polling), validates every answer and merges the
results per month. **A month is published to `public/data/` only when its analysis is complete.**
The working state (chunk cache, retries) lives in `data-state/`. The React portal only reads the
published JSON; the browser never calls UiPath and holds no credentials.

- **First run:** analyses every month from `RR_START_MONTH` (default 2026-01).
- **Later runs:** re-check only the latest `RR_RECHECK_MONTHS` months (default 2); only new or
  changed UiPath text goes to the agent. Older published months are frozen.
- **Schedule:** GitHub Actions every Monday 12:30 IST (07:00 UTC), plus a manual "Run workflow".
- Months where UiPath published only release dates (January/February 2026) show released
  products and dates.

## The agent (UiPath side)

| Item | Value |
| --- | --- |
| Solution / process | `Release_Radar_Agent_v1_2` / `ReleaseNotes_Agent_v2` (low-code agent, model gpt-5.4, no tools) |
| Orchestrator folder | `Uipath_ReleaseNotes > Release_Radar_Agent_v1_2` (Cloud - Serverless runtime) |
| API trigger | `release-radar-v2`, POST, default call mode Async polling |
| Trigger URL | `https://cloud.uipath.com/accelirateuipcl/Spyro/orchestrator_/t/270ed9a5-9e3a-44cb-a751-882ab3952d40/release-radar-v2` |
| Input | `release_notes_markdown` (String, one chunk, always under 10,000 JSON characters) |
| Output | `{ "changes_by_product": { "<product>": { "summary", "overall_analysis", "changes": [ { "name", "summary", "analysis", "impact", "breaking_change" } ] } } }` |

The v1.1 agent (`release-notes` trigger) is left untouched. `UIPATH_INPUT_TYPE=file` is also
supported (chunk uploaded as a job attachment) if an agent with a File input is used instead.
After changing the agent prompt or model, set `RR_CACHE_KEY` to a new value once to re-analyse.

## Run it locally (Windows)

1. Install Node.js 22 LTS (https://nodejs.org).
2. Get a UiPath token: Automation Cloud > your user icon > **Preferences** > **Personal Access
   Token** > **Generate new token**, scope **Orchestrator API Access > OR.Jobs**, short expiry.
   Your user needs **Jobs: Create + View** in the agent's folder.
3. Double-click `start-local.bat`. Paste the token when asked (hidden, used for that run only, not
   saved). It installs packages (first time only), runs the analysis (first run about 10-20
   minutes; later runs only new UiPath updates), then starts the portal at http://127.0.0.1:5173
   and opens it. If the analysis stops with an error, the portal is not started and the error is
   shown. The window stays open until you close it.
4. To just look at the portal later (no token, no agent calls): double-click `open-portal.bat`.

The portal is served by `pipeline/serve.mjs`, a small server with no dependencies that only
listens on this PC (127.0.0.1). It serves the built portal (`dist/`) and the latest analysis
(`public/data/`). Build output is saved to `build.log`.

macOS/Linux: `./start-local.sh` does the same. You may put the token in `.env` (`UIPATH_PAT=`)
instead of pasting it; `.env` is git-ignored and must never be shared.

## Host it (step-by-step: `docs/Release_Radar_v1.2_Handover_and_Hosting_Guide.docx`)

- **GitHub Pages (recommended):** push this folder to a repo, Settings > Pages > Source =
  **GitHub Actions**, add secrets `UIPATH_TRIGGER_URL` + `UIPATH_PAT` (or `UIPATH_CLIENT_ID` +
  `UIPATH_CLIENT_SECRET` with variable `UIPATH_ORG`), then Actions > **Release Radar** > **Run
  workflow** once. The workflow analyses, commits `public/data` + `data-state`, and deploys.
- **UiPath Coded Apps:** `npm run build`, then `uip codedapp pack ./dist --name release-radar`,
  `uip codedapp publish`, `uip codedapp deploy`. Served at `https://<org>.uipath.host/<app>`;
  only members of the UiPath organisation can sign in. Re-deploy after each data refresh.
- **Any static host** (Vercel, Netlify, IIS, a file share web server): serve `dist/`. The build
  uses relative paths, so any folder or repo name works.

## Commands

| Command | What it does |
| --- | --- |
| `npm ci` | Install exact dependencies |
| `npm test` | Run the 40 automated tests (parser, chunker, UiPath client, merge, publishing, local server, UI view model) |
| `npm run dev` | Developer mode with live reload (Vite) on http://localhost:5173 |
| `npm run serve` | Serve the built portal + latest data on http://127.0.0.1:5173 (no dependencies) |
| `npm run build` | Production build to `dist/` (with Content-Security-Policy) |
| `npm run analyze:dry` | Parse + chunk all months, no UiPath calls, no credentials |
| `npm run analyze:local` | Full run using a local `.env` |
| `node --env-file=.env pipeline/run.js --month 2026-08 --force` | Re-analyse one month, ignoring the cache |

Exit codes of `pipeline/run.js`: `0` OK, `1` stopped (settings, 401/403/404 or network),
`3` some months not complete yet (only with `RR_FAIL_ON_PARTIAL=true`; retried next run).

## Configuration

All settings are environment variables; see `.env.example`. Nothing client-specific is hard-coded,
so the same code can be deployed for another tenant or client by changing secrets/variables only.

## Troubleshooting

| Message | Fix |
| --- | --- |
| `401` | Token wrong or expired: create a new one. |
| `403` | Your user or app lacks **Jobs: Create + View** in the agent's folder. |
| `404` | Trigger URL wrong, or the trigger is disabled/deleted. |
| Month missing in the portal | Its analysis is not complete yet; the next run retries only the failed chunks. |
