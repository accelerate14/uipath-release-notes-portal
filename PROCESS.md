# How The Portal Works

1. Vite serves `index.html`, which contains the root element used by React.
2. `src/main.jsx` mounts the `App` component and imports the shared stylesheet.
3. When `App` mounts, `fetchReleases` requests one UiPath JSON page for each month from January through August 2026.
4. `parseMonthPayload` reads the HTML release tables embedded in each JSON response and keeps the complete month document together with its parsed metadata.
5. React renders the documents as month-by-month sections, with month anchors in the sidebar.
6. The original document body is sanitized before rendering so the release-note HTML can be displayed safely in the app.
7. Loading and error states remain visible while the eight month documents are fetched.
9. The static JSON files remain available as fixtures/reference data, while the app currently uses the live public feed.

## Run it

```bash
npm install
npm run dev
```

Build a production bundle with `npm run build`.
