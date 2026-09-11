# Changes

## React migration

- Added a Vite + React app with `npm run dev`, `npm run build`, and `npm run preview` scripts.
- Added `src/main.jsx` as the React entry point.
- Added `src/App.jsx` with the Release Radar experience.
- Reused the existing `styles.css` so the visual direction and responsive layout stay consistent.
- Kept `api-check.json` and `response.json` in the project as the existing release-note fixtures.

## Behavior preserved

- Loads January through August 2026 release notes from the UiPath public feed.
- Parses release tables into product, deployment, date, status, and source-link records.
- Supports search, status, month, deployment, product, and sort controls.
- Supports bookmarks through browser `localStorage`.
- Supports refresh, empty states, loading/error states, keyboard `/` search focus, toast feedback, and release detail dialogs.
- Keeps the original UiPath note body and displays it in the release detail dialog instead of showing only a summary row.
- Replaced the release summary list, filters, and detail dialog with month-by-month document sections.

## Original files

The original `index.html` and `script.js` remain in the workspace as migration references. The Vite entry point now uses `index.html` and `src/main.jsx`.
