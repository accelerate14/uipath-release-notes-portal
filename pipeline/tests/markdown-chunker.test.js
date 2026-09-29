import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { buildChunks, measurePayload } from "../lib/chunker.js";
import { parseReleaseNotes } from "../lib/markdown.js";

const sample = readFileSync(new URL("./fixtures/sample-month.md", import.meta.url), "utf8");
const opts = { monthLabel: "August 2026", argName: "release_notes_markdown", callMode: "AsyncRequestReply" };

test("parser: environments, timeframes and section metadata", () => {
  const doc = parseReleaseNotes(sample);
  assert.equal(doc.title, "August 2026");
  assert.deepEqual(
    doc.sections.map((s) => `${s.environment} | ${s.timeframe}`),
    [
      "Automation Cloud and Test Cloud | Late August 2026",
      "Automation Cloud and Test Cloud | Early August 2026",
      "Automation Cloud Public Sector and Test Cloud Public Sector | Late August 2026",
      "Automation Cloud Dedicated and Test Cloud Dedicated | Late August 2026",
      "Automation Cloud Dedicated and Test Cloud Dedicated | Early August 2026",
    ],
  );
  const late = doc.sections[0];
  assert.equal(late.publishingDate, "August 31, 2026");
  assert.equal(late.range, "August 16, 2026 – August 31, 2026");
  assert.match(doc.sections[4].note, /No Automation Cloud Dedicated/);
  assert.equal(doc.sections[4].products.length, 0);
  assert.deepEqual(doc.warnings, []);
});

test("parser: both product heading styles (**bold** and #####) and intro text dropped", () => {
  const doc = parseReleaseNotes(sample);
  assert.deepEqual(
    doc.sections[0].products.map((p) => p.name),
    ["Automation Cloud Administration and Test Cloud Administration", "Test Manager"],
  );
  assert.deepEqual(doc.sections[1].products.map((p) => p.name), ["Agents", "Orchestrator"]);
  for (const section of doc.sections) {
    for (const product of section.products) assert.doesNotMatch(product.text, /The following section/);
  }
  assert.match(doc.sections[1].products[1].text, /OpenAPI 3\.0/);
});

test("parser: Dedicated highlights keep their release date", () => {
  const dedicated = parseReleaseNotes(sample).sections[3];
  assert.deepEqual(
    dedicated.products.map((p) => [p.name, p.releaseDate]),
    [
      ["Agents", "August 21, 2026"],
      ["Test Manager", "August 25, 2026"],
    ],
  );
});

test("parser: flattened HTML catalog incl. multi-date continuation rows", () => {
  const catalog = parseReleaseNotes(sample).sections[0].catalog;
  assert.deepEqual(catalog.map((c) => [c.product, c.available, c.dates]), [
    ["Automation Cloud Admin", true, ["August 18, 2026", "August 21, 2026"]],
    ["AI Center", false, []],
    ["Test Manager", true, ["August 20, 2026"]],
  ]);
  assert.equal(catalog[0].layer, "Platform");
});

test("parser: pipe-table catalog with links, merged across release-date groups", () => {
  const catalog = parseReleaseNotes(sample).sections[3].catalog;
  const agents = catalog.find((c) => c.product === "Agents");
  const testManager = catalog.find((c) => c.product === "Test Manager");
  assert.equal(agents.available, true);
  assert.deepEqual(agents.dates, ["August 21, 2026"]);
  assert.equal(agents.links[0].url.startsWith("https://docs.uipath.com/agents/"), true);
  assert.deepEqual(testManager.dates, ["August 25, 2026"]);
  assert.equal(catalog.length, 2);
});

test("parser: catalog-only months (Jan/Feb 2026 layout) with padded cells and per-line headers", () => {
  // Layout observed on the live January 2026 page: multi-line <colgroup>, header cells on
  // separate lines, padded cells, continuation rows that repeat the layer cell.
  const md = [
    "# January 2026",
    "## Automation Cloud and Test Cloud",
    "### Release notes catalog",
    "#### Automation Cloud and Test Cloud release notes catalog: 27 January, 2026 - January 30, 2026",
    "**Legend:**",
    " <colgroup>",
    "  <col/>",
    " </colgroup>",
    " ",
    "  ",
    "    Layer ",
    "    Product ",
    "    Release status ",
    "    Release date(s) ",
    "    Release notes ",
    "  ",
    " ",
    "  ",
    "    Product ",
    "    Agents ",
    "     ✅  ",
    "    January 30, 2026 ",
    "     Agents release notes  ",
    "  ",
    "  ",
    "    Product ",
    "    January 29, 2026 ",
    "     Agents release notes  ",
    "  ",
    "  ",
    "    Product ",
    "    AI Center ",
    "     ❌  ",
    "    N/A ",
    "    N/A ",
    "  ",
    " ",
  ].join("\n");
  const doc = parseReleaseNotes(md);
  assert.equal(doc.sections.length, 1);
  assert.equal(doc.sections[0].products.length, 0, "catalog-only month has no highlights");
  assert.deepEqual(doc.sections[0].catalog.map((c) => [c.product, c.layer, c.available, c.dates]), [
    ["Agents", "Product", true, ["January 30, 2026", "January 29, 2026"]],
    ["AI Center", "Product", false, []],
  ]);
  assert.deepEqual(doc.warnings, []);
  assert.equal(buildChunks(doc, opts).chunks.length, 0, "nothing is sent to the agent");
});

test("parser: ordinal dates ('February 4th, 2026') and dash-only lines seen on live pages", () => {
  const md = [
    "# February 2026",
    "## Automation Cloud and Test Cloud",
    "### Release notes catalog",
    "#### Release notes catalog",
    " <colgroup><col/><col/><col/><col/><col/></colgroup>",
    " ",
    "  LayerProductRelease statusRelease date(s)Release notes",
    " ",
    "   Product",
    "   Test Manager",
    "   ✅",
    "   February 2nd, 2026",
    "   Test Manager release notes",
    "  ",
    "   Product",
    "   February 4th, 2026",
    "   Test Manager release notes",
    "  ",
    "   ------",
    "  ",
  ].join("\n");
  const doc = parseReleaseNotes(md);
  assert.deepEqual(doc.warnings, []);
  assert.deepEqual(doc.sections[0].catalog[0].dates, ["February 2nd, 2026", "February 4th, 2026"]);
});

test("chunker: every chunk fits the Orchestrator argument budget (measured as sent)", () => {
  const doc = parseReleaseNotes(sample);
  for (const budget of [2500, 8000, 10000]) {
    const { chunks } = buildChunks(doc, { ...opts, maxArgsJsonChars: budget });
    assert.ok(chunks.length > 0);
    for (const chunk of chunks) {
      assert.ok(chunk.payloadChars <= budget, `${chunk.id} = ${chunk.payloadChars} > ${budget}`);
      assert.equal(chunk.payloadChars, measurePayload(chunk.text, opts));
    }
  }
});

test("chunker: no section mixing, section header repeated, no content lost or duplicated", () => {
  const doc = parseReleaseNotes(sample);
  const { chunks } = buildChunks(doc, { ...opts, maxArgsJsonChars: 8000 });
  for (const chunk of chunks) {
    const section = doc.sections.find((s) => s.id === chunk.sectionId);
    assert.ok(chunk.text.includes(`## ${section.environment}\n### ${section.timeframe}`));
  }
  const bullets = doc.sections.flatMap((s) => s.products.flatMap((p) => p.text.split("\n").filter((l) => l.startsWith("* "))));
  const all = chunks.map((c) => c.text).join("\n");
  for (const bullet of bullets) {
    assert.equal(all.split(bullet).length - 1, 1, `bullet must appear exactly once: ${bullet.slice(0, 60)}`);
  }
  assert.equal(chunks.filter((c) => c.sectionId.includes("dedicated--early")).length, 0);
});

test("chunker: rejects budgets above the 10,000-character Orchestrator limit", () => {
  assert.throws(() => buildChunks(parseReleaseNotes(sample), { ...opts, maxArgsJsonChars: 10001 }), /exceeds/);
});

test("chunker: oversized product is split only at bullet boundaries, with part labels", () => {
  const bullets = Array.from(
    { length: 40 },
    (_, i) => `* Change ${i + 1}: "quoted" text with \\ backslashes and a long explanation that keeps going for a while to add size.`,
  );
  const md = [
    "# August 2026",
    "## Automation Cloud and Test Cloud",
    "### Early August 2026",
    "| Publishing date | Release timeframe |",
    "| --- | --- |",
    "| August 15, 2026 | August 1, 2026 – August 15, 2026 |",
    "#### Release highlights",
    "##### Orchestrator",
    ...bullets,
    "##### Agents",
    "* Small change.",
  ].join("\n");
  const doc = parseReleaseNotes(md);
  const { chunks, warnings } = buildChunks(doc, { ...opts, maxArgsJsonChars: 2500 });
  const parts = chunks.filter((c) => c.products.some((p) => p.name === "Orchestrator"));
  assert.ok(parts.length >= 2, "should be split into several parts");
  parts.forEach((chunk, index) => {
    assert.ok(chunk.payloadChars <= 2500);
    assert.match(chunk.text, new RegExp(`\\*\\*Orchestrator\\*\\* \\(part ${index + 1} of ${parts.length}\\)`));
    for (const line of chunk.text.split("\n").filter((l) => l.startsWith("* Change"))) {
      assert.ok(bullets.includes(line), "bullets must be intact");
    }
  });
  const agentsChunk = chunks.find((c) => c.products.some((p) => p.name === "Agents"));
  assert.ok(!agentsChunk.products.some((p) => p.name === "Orchestrator"), "no product appended after a split part");
  assert.deepEqual(warnings, []);
});

test("Dedicated '##### <date>' headings are date groups, not products; catalog dates and bold cells are clean", () => {
  const doc = parseReleaseNotes(readFileSync(new URL("./fixtures/dedicated-h5.md", import.meta.url), "utf8"));
  const [mid, early, jan] = doc.sections;
  assert.deepEqual(
    mid.products.map((p) => [p.name, p.releaseDate]),
    [
      ["Orchestrator", "March 19, 2026"],
      ["Orchestrator", "March 12, 2026"],
      ["Test Manager", "March 12, 2026"],
    ],
  );
  assert.ok(mid.products.every((p) => !/following section outlines/.test(p.text)), "intro boilerplate is not product text");
  const admin = mid.catalog.find((c) => c.product === "Automation Cloud Dedicated Admin");
  assert.ok(admin, "bold markers are stripped from catalog cells");
  assert.equal(admin.layer, "Platform");
  assert.deepEqual(admin.dates, ["March 19, 2026"]);
  assert.deepEqual(mid.catalog.find((c) => c.product === "Orchestrator").dates, ["March 19, 2026"]);
  assert.deepEqual(early.catalog[0].dates, ["March 5, 2026"], "single release date of the section is used");
  assert.deepEqual(jan.catalog[0].dates, ["January 19, 2026"], "date taken from the catalog heading");
  assert.deepEqual(doc.warnings, []);
});
