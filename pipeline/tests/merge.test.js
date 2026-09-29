import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parseReleaseNotes } from "../lib/markdown.js";
import { AgentOutputError, mergeMonth, normalizeAgentOutput } from "../lib/merge.js";

const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
const realOutput = JSON.parse(fixture("agent-output-real.json")); // real agent output captured in v1.1
const pendingJob = JSON.parse(fixture("pending-job-real.json")); // what v1.1 displayed as "output"

test("normalizes a real agent response from the deployed agent", () => {
  const { products } = normalizeAgentOutput(realOutput);
  const admin = products["Automation Cloud Administration and Test Cloud Administration"];
  assert.ok(admin);
  assert.ok(admin.changes.length >= 1);
  for (const change of admin.changes) {
    assert.equal(typeof change.name, "string");
    assert.equal(typeof change.breaking_change, "boolean");
  }
});

test("accepts output wrapped as a JSON string or nested under an output key", () => {
  assert.ok(normalizeAgentOutput(JSON.stringify(realOutput)).products);
  assert.ok(normalizeAgentOutput({ output: JSON.stringify(realOutput) }).products);
  assert.ok(normalizeAgentOutput({ changes_by_product: JSON.stringify(realOutput.changes_by_product) }).products);
});

test("rejects an Orchestrator job record (the v1.1 'Pending' false success)", () => {
  assert.throws(() => normalizeAgentOutput(pendingJob), (error) => error instanceof AgentOutputError && /job record/.test(error.message));
});

test("rejects empty or malformed output", () => {
  assert.throws(() => normalizeAgentOutput(null), AgentOutputError);
  assert.throws(() => normalizeAgentOutput({ foo: 1 }), AgentOutputError);
  assert.throws(() => normalizeAgentOutput({ changes_by_product: {} }), AgentOutputError);
});

test("merges chunk results into sections; split parts are combined; statuses are honest", () => {
  const doc = parseReleaseNotes(fixture("sample-month.md"));
  const late = doc.sections[0];
  const early = doc.sections[1];
  const records = [
    {
      id: "c1",
      sectionId: late.id,
      status: "ok",
      products: [{ name: "Test Manager", part: 1, parts: 2 }],
      result: { products: { "Test Manager": { summary: "A.", overall_analysis: "", changes: [{ name: "x", summary: "", analysis: "", impact: "", breaking_change: true }] } } },
    },
    {
      id: "c2",
      sectionId: late.id,
      status: "ok",
      products: [{ name: "Test Manager", part: 2, parts: 2 }, { name: "Automation Cloud Administration and Test Cloud Administration" }],
      result: {
        products: {
          "Test Manager": { summary: "B.", overall_analysis: "", changes: [{ name: "y", summary: "", analysis: "", impact: "", breaking_change: false }] },
          // agent shortened the name: tolerated because it came from the chunk that carried it
          "Automation Cloud Administration": { summary: "Admin.", overall_analysis: "", changes: [] },
        },
      },
    },
    { id: "c3", sectionId: early.id, status: "failed", error: "boom", products: [{ name: "Agents" }, { name: "Orchestrator" }], result: null },
  ];
  const merged = mergeMonth(doc, records);
  const lateOut = merged.sections[0];
  const tm = lateOut.products.find((p) => p.name === "Test Manager");
  assert.equal(tm.analysis.changes.length, 2);
  assert.equal(tm.analysis.summary, "A. B.");
  assert.equal(tm.analysisStatus, "ok");
  assert.equal(tm.sourceMentionsBreaking, true);
  const admin = lateOut.products.find((p) => p.name.startsWith("Automation Cloud Administration"));
  assert.equal(admin.analysis.summary, "Admin.");
  assert.equal(lateOut.products.some((p) => p.unmatched), false);
  assert.equal(merged.sections[1].products.every((p) => p.analysisStatus === "failed"), true);
  assert.equal(merged.status, "partial");
  assert.deepEqual(merged.counts.chunks, { total: 3, ok: 2, failed: 1, pending: 0 });
  assert.equal(merged.counts.breakingChanges, 1);
});

test("a product listed on several Dedicated dates shares one agent analysis (no false 'pending')", () => {
  // Real structure from August 2026 Dedicated: Test Manager x3, Orchestrator x2, Studio Web x2 in one chunk.
  // The agent returns one key per product name (verified with the deployed v2 agent on 2026-09-28).
  const doc = parseReleaseNotes(fixture("dedicated-repeated.md"));
  const section = doc.sections[0];
  const change = (name) => ({ name, summary: `${name} summary`, analysis: "a", impact: "i", breaking_change: false });
  const result = normalizeAgentOutput({
    changes_by_product: {
      Agents: { summary: "s", overall_analysis: "o", changes: [change("Escalation routing")] },
      Orchestrator: { summary: "s", overall_analysis: "o", changes: [change("Disabled triggers"), change("Continuity note")] },
      Solutions: { summary: "s", overall_analysis: "o", changes: [change("Resource explorer")] },
      "Studio Web": { summary: "s", overall_analysis: "o", changes: [change("Empty repo clone"), change("Local setup")] },
      "Test Manager": { summary: "s", overall_analysis: "o", changes: [change("Autopilot Chat GA")] },
      "Automation Cloud Dedicated Admin / Test Cloud Dedicated Admin": { summary: "s", overall_analysis: "o", changes: [change("Consumables key hidden")] },
    },
  });
  const merged = mergeMonth(doc, [
    { id: "d1", sectionId: section.id, status: "ok", products: section.products.map((p) => ({ name: p.name, releaseDate: p.releaseDate })), result },
  ]);
  assert.equal(merged.status, "complete");
  const products = merged.sections[0].products;
  assert.equal(products.length, 10);
  assert.ok(products.every((p) => p.analysisStatus === "ok"), "no occurrence is left pending");
  const tm = products.filter((p) => p.name === "Test Manager");
  assert.equal(tm.length, 3);
  assert.equal(tm[0].analysis.changes.length, 1);
  assert.deepEqual(tm[0].releaseDates, ["August 21, 2026", "August 25, 2026", "August 26, 2026"]);
  assert.ok(tm.slice(1).every((p) => p.sharedAnalysis === true && p.analysis === null));
  assert.equal(merged.counts.changes, 8, "changes are counted once");
  assert.equal(products.some((p) => p.unmatched), false);
});

test("real output of the deployed v2 agent (String input) merges completely", () => {
  // Captured from ReleaseNotes_Agent_v2 on 2026-09-28 for the real Public Sector Late August 2026 chunk.
  const doc = parseReleaseNotes(fixture("public-sector-late-aug.md"));
  const section = doc.sections[0];
  const result = normalizeAgentOutput(JSON.parse(fixture("agent-output-v2-real.json")));
  assert.deepEqual(result.warnings, []);
  const merged = mergeMonth(doc, [
    { id: "p1", sectionId: section.id, status: "ok", products: section.products.map((p) => ({ name: p.name })), result },
  ]);
  assert.equal(merged.status, "complete");
  assert.deepEqual(merged.counts, {
    sections: 1,
    products: 3,
    analysedProducts: 3,
    changes: 7,
    breakingChanges: 3,
    chunks: { total: 1, ok: 1, failed: 0, pending: 0 },
  });
});
