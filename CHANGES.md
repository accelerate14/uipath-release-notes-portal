# Changes

## v1.2 (September 2026)

Architecture: the browser no longer calls UiPath. A scheduled server-side pipeline (GitHub
Actions, or `start-local.bat` on a PC) runs the agent and publishes validated, static JSON that the
portal reads.

### Fixed
- **Secret exposure:** UiPath PAT removed from the browser bundle (`VITE_` variables are public by
  design). Credentials live only in GitHub Actions secrets, or are typed at run time locally.
- **10,000-character limit:** context-preserving chunker keeps every job's input under
  Orchestrator's 10,000-character JSON limit (budget 8,000), never splits a sentence, never mixes
  sections, and repeats the section header in each chunk.
- **API call failure:** browser `fetch(..., { redirect: "manual" })` hid UiPath's 303 redirect
  (opaque redirect). Replaced by a Node client for the documented async-polling flow
  (202 -> 200 -> 303 -> output) with retries, timeouts and clear 401/403/404 hints.
- **False "success":** Orchestrator job records (`state: Pending`) were shown as agent output.
  Every result is schema-validated; invalid output is retried once, then marked failed.
- **Agent always faulted:** the deployed v1.1 agent required an "Analyze Files" tool that was not
  attached, and expected a File argument (`release_notes_file`) while the portal sent text.
  New agent `ReleaseNotes_Agent_v2` (String input `release_notes_markdown`, no tools, same output
  contract) with its own API trigger `release-radar-v2`. Verified with real jobs on 2026-09-28.
- **Fragile source:** dropped the undocumented `_next/data/docs-build-135` endpoint and the
  hard-coded Jan-Aug list. Months are read from the public `.md` pages.
- **Parser, found on live pages (Jan-Aug 2026):** Dedicated `##### <date>` headings were read as
  products; rows whose Layer is "Product" were read as table headers (whole rows lost); `**bold**`
  names in catalog cells; missing catalog dates when the date is in the heading or is the section's
  only release date. All fixed and covered by tests.
- **Repeated products:** a product listed on several Dedicated dates now shares one analysis and
  shows all its release dates (no false "not analysed" leftovers).
- **Cost:** agent runs only for new or changed content (content-hash cache), not on every page view.

### Added
- `pipeline/` (parser, chunker, UiPath client, merge, store, CLI, local server) with 40 automated tests,
  including real agent output captured from the deployed v2 agent.
- **Publish only complete analysis**; failed chunks are retried next run while the previous version
  stays live. Working state is kept in `data-state/`.
- **Incremental runs:** first run analyses all months; later runs re-check only the latest
  `RR_RECHECK_MONTHS` months.
- `.github/workflows/release-radar.yml`: every Monday 12:30 IST (07:00 UTC), manual re-run, deploy.
- `start-local.bat` / `start-local.sh`: analysis first, then the portal; asks for the token at run
  time (hidden, not saved) when `.env` has none. The portal is served by `pipeline/serve.mjs`
  (no dependencies, this PC only) instead of the Vite dev server, which did not start on the first
  Windows run; the window now stays open and build output goes to `build.log`.
- `open-portal.bat`: open the portal with the published analysis, without a token.
- First full analysis (28 Sep 2026) included: January-August 2026, 36 of 36 chunks, 561 updates.
- `UIPATH_INPUT_TYPE=text|file` (file = job attachment for agents with a File input).
- Release dates are listed in date order.
- Portal redesign: one tab per cloud; one card per product for the whole month (no Early/Late
  split); click a card for all its updates (summary + impact visible, agent analysis and UiPath's
  original wording on click); breaking-change box; search; "breaking only" filter. No status labels.
- Relative build paths: the same `dist/` works on GitHub Pages, UiPath Coded Apps or any host.
- Content-Security-Policy on the production build; pinned dependency versions.
- `RR_STORE_SOURCE=false` option to publish analysis and links only (no UiPath original text).

### Removed
- `script.js` (pre-React legacy), `api-check.json`/`response.json` (old `_next/data` fixtures),
  Vite dev proxy, `gh-pages` deploy script (deployment is done by GitHub Actions).

## v1.1

React migration of the original static page; direct browser call to the agent API trigger.
