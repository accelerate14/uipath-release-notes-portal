// Data provider: reads the validated JSON published by the pipeline (public/data).
// Only fully analysed months are listed in index.json, so the portal never shows partial work.
const DATA_BASE = `${import.meta.env.BASE_URL}data/`;

async function getJson(path, signal) {
  const response = await fetch(`${DATA_BASE}${path}`, { cache: "no-cache", signal });
  if (!response.ok) throw new Error(`${path} returned HTTP ${response.status}`);
  return response.json();
}

export default {
  loadIndex: (signal) => getJson("index.json", signal),
  loadMonth: (entry, signal) => getJson(entry.file, signal),
};
