import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parseReleaseNotes } from "../lib/markdown.js";
import { mergeMonth } from "../lib/merge.js";
import { buildMonthView, canonicalProduct, productMatches, shortDate, shortRange } from "../../src/lib/view-model.js";

const sample = readFileSync(new URL("./fixtures/sample-month.md", import.meta.url), "utf8");

function monthWith(extraMarkdown = "") {
  const doc = parseReleaseNotes(sample + extraMarkdown);
  const late = doc.sections[0];
  const records = [
    {
      id: "c1",
      sectionId: late.id,
      status: "ok",
      products: late.products.map((p) => ({ name: p.name })),
      result: {
        products: {
          "Test Manager": { summary: "TM summary.", overall_analysis: "Not stated in the release notes.", changes: [{ name: "iText removed", summary: "s", analysis: "a", impact: "i", breaking_change: true }] },
          "Automation Cloud Administration and Test Cloud Administration": { summary: "Admin summary.", overall_analysis: "", changes: [{ name: "Retention", summary: "s", analysis: "", impact: "", breaking_change: false }] },
        },
      },
    },
  ];
  return mergeMonth(doc, records);
}

test("view model: one tab per cloud, one entry per product for the whole month", () => {
  const view = buildMonthView(monthWith());
  assert.deepEqual(view.envs.map((e) => e.short), ["Automation Cloud", "Public Sector", "Dedicated"]);
  const cloud = view.envs[0];
  // Late (Admin, Test Manager) + Early (Agents, Orchestrator) are merged into one product list.
  assert.deepEqual(cloud.products.map((p) => p.name), ["Agents", "Orchestrator", "Platform administration", "Test Manager"]);
  const tm = cloud.products.find((p) => p.name === "Test Manager");
  assert.equal(tm.breaking, 1);
  assert.equal(tm.status, "ok");
  assert.equal(tm.updates[0].when, "Aug 16 – 31");
  assert.deepEqual(tm.dates, ["Aug 20"]);
  assert.deepEqual(tm.overall, [], "'Not stated' filler is dropped");
  const agents = cloud.products.find((p) => p.name === "Agents");
  assert.equal(agents.status, "pending");
  assert.equal(agents.updateCount, 2);
  assert.match(agents.summary, /coded functions/);
  // Catalog "Automation Cloud Admin" merges into "Platform administration" dates.
  assert.deepEqual(cloud.products.find((p) => p.name === "Platform administration").dates, ["Aug 18", "Aug 21"]);
  assert.equal(cloud.stats.breaking, 1);
});

test("view model: same product released on two Dedicated dates is one entry with dated updates", () => {
  const dedicated = buildMonthView(monthWith()).envs[2];
  assert.deepEqual(dedicated.products.map((p) => [p.name, p.pendingItems[0].when]), [
    ["Agents", "Released Aug 21"],
    ["Test Manager", "Released Aug 25"],
  ]);
});

test("view model helpers and filtering", () => {
  assert.equal(shortDate("February 4th, 2026"), "Feb 4");
  assert.equal(shortRange("July 27, 2026 – August 2, 2026"), "Jul 27 – Aug 2");
  assert.equal(canonicalProduct("Automation Cloud Dedicated Admin / Test Cloud Dedicated Admin").key, "platform-administration");
  const cloud = buildMonthView(monthWith()).envs[0];
  assert.deepEqual(cloud.products.filter((p) => productMatches(p, "", true)).map((p) => p.name), ["Test Manager"]);
  assert.deepEqual(cloud.products.filter((p) => productMatches(p, "storage bucket", false)).map((p) => p.name), ["Orchestrator"]);
  assert.deepEqual(buildMonthView(null).envs, []);
});

test("view model: shared Dedicated analysis shows every release date and no raw leftovers", () => {
  const doc = parseReleaseNotes(readFileSync(new URL("./fixtures/dedicated-repeated.md", import.meta.url), "utf8"));
  const section = doc.sections[0];
  const change = (name) => ({ name, summary: `${name} summary`, analysis: "a", impact: "i", breaking_change: false });
  const month = mergeMonth(doc, [
    {
      id: "d1",
      sectionId: section.id,
      status: "ok",
      products: section.products.map((p) => ({ name: p.name })),
      result: {
        products: {
          "Test Manager": { summary: "TM", overall_analysis: "", changes: [change("Autopilot Chat GA")] },
          "Studio Web": { summary: "SW", overall_analysis: "", changes: [change("Empty repo clone"), change("Local setup")] },
        },
      },
    },
  ]);
  const dedicated = buildMonthView(month).envs[0];
  const tm = dedicated.products.find((p) => p.name === "Test Manager");
  assert.equal(tm.updates[0].when, "Released Aug 21, Aug 25, Aug 26");
  assert.equal(tm.pendingItems.length, 0);
  assert.equal(tm.sources.length, 3, "UiPath's original wording is kept per date");
  const sw = dedicated.products.find((p) => p.name === "Studio Web");
  assert.equal(sw.updates.length, 2);
  assert.equal(sw.pendingItems.length, 0);
});
