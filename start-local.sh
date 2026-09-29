#!/usr/bin/env sh
# Release Radar v1.2 - run locally on macOS/Linux.
#   1) analyses UiPath release notes with the agent (first run: every month; later: only new updates)
#   2) then opens the portal at http://127.0.0.1:5173 with the finished analysis.
# If .env has no token, you are asked for it; it is used for this run only and never saved.
set -u
cd "$(dirname "$0")"
command -v node >/dev/null 2>&1 || { echo "Node.js was not found. Install Node.js 22 LTS from https://nodejs.org" >&2; exit 1; }
node -e "const [a,b]=process.versions.node.split('.').map(Number); process.exit(a>22||(a===22&&b>=12)?0:1)" || { echo "Node.js 22.12 or newer is required (found $(node -v))." >&2; exit 1; }
if [ ! -f .env ]; then
  cp .env.example .env
  echo "Created .env. Fill in UIPATH_TRIGGER_URL, save it, then run ./start-local.sh again."
  exit 1
fi
[ -d node_modules ] || npm ci || exit 1
if ! node --env-file=.env pipeline/has-credentials.mjs; then
  printf "No UiPath token in .env. Paste your Personal Access Token (hidden, used for this run only): "
  stty -echo 2>/dev/null; read -r UIPATH_PAT; stty echo 2>/dev/null; echo
  export UIPATH_PAT
fi
node --env-file=.env pipeline/check-env.mjs || exit 1
echo "Step 1 of 2: analysing UiPath release notes (first run: all months; later runs: only new updates)."
RR_FAIL_ON_PARTIAL=true node --env-file=.env pipeline/run.js
status=$?
unset UIPATH_PAT
if [ "$status" -eq 1 ]; then echo "The analysis stopped with an error (see above). The portal was not started." >&2; exit 1; fi
[ "$status" -eq 3 ] && echo "Note: some months could not be fully analysed yet; they are not shown and will be retried next run."
echo "Step 2 of 2: starting the portal."
if ! npm run build > build.log 2>&1; then
  if [ -f dist/index.html ]; then
    echo "  Note: the portal could not be rebuilt (details in build.log). Using the existing build."
  else
    echo "  The portal could not be built. Details from build.log:" >&2; cat build.log >&2; exit 1
  fi
fi
node pipeline/serve.mjs
