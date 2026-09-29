// Release Radar v1.2 - data store.
//
// Two separate areas, so readers only ever see finished work:
//   <stateDir>/<YYYY-MM>.json          working state per month (chunk cache, errors, retries).
//                                      Committed to the repo, never deployed.
//   <dataDir>/index.json               PUBLISHED months only (read by the portal first)
//   <dataDir>/analysis/<YYYY-MM>.json  PUBLISHED month: written only when its analysis is complete.

import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export const SCHEMA_VERSION = "1.2";

export const sha256 = (text) => createHash("sha256").update(String(text), "utf8").digest("hex");

export async function readJson(path, fallback = null) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw new Error(`Cannot read ${path}: ${error.message}`);
  }
}

/** Atomic write: write to a temp file, then rename (no half-written JSON on failure). */
export async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temp, path);
}

export const monthPath = (dataDir, monthId) => join(dataDir, "analysis", `${monthId}.json`);
export const indexPath = (dataDir) => join(dataDir, "index.json");
export const statePath = (stateDir, monthId) => join(stateDir, `${monthId}.json`);

/** Published month (what the portal shows). */
export const readMonth = (dataDir, monthId) => readJson(monthPath(dataDir, monthId));
export const writeMonth = (dataDir, month) => writeJson(monthPath(dataDir, month.id), month);

/** Working state (chunk cache and retry information). */
export const readState = (stateDir, monthId) => readJson(statePath(stateDir, monthId));
export const writeState = (stateDir, state) => writeJson(statePath(stateDir, state.id), state);

/** Rebuild index.json from published month summaries (sorted newest first). */
export async function updateIndex(dataDir, monthSummaries, meta = {}) {
  const current = (await readJson(indexPath(dataDir))) || { months: [] };
  const byId = new Map((current.months || []).map((m) => [m.id, m]));
  for (const summary of monthSummaries) byId.set(summary.id, summary);
  const months = [...byId.values()].sort((a, b) => b.id.localeCompare(a.id));
  const candidate = { schemaVersion: SCHEMA_VERSION, ...meta, months };
  const existing = { schemaVersion: current.schemaVersion, ...meta, months: current.months || [] };
  // Skip the write when nothing changed, so scheduled runs do not create empty commits.
  if (JSON.stringify(candidate) === JSON.stringify(existing)) return current;
  const index = { schemaVersion: SCHEMA_VERSION, updatedAt: new Date().toISOString(), ...meta, months };
  await writeJson(indexPath(dataDir), index);
  return index;
}
