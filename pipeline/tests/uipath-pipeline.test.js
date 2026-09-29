import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig, monthsToProcess } from "../lib/config.js";
import { runPipeline } from "../lib/pipeline.js";
import { readJson } from "../lib/store.js";
import { UiPathError, createTokenProvider, invokeApiTrigger, parseTriggerUrl, uploadTextAttachment } from "../lib/uipath.js";
import { createServer } from "node:http";
import { startMockTrigger } from "./mock-uipath.js";

const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
const realOutput = JSON.parse(fixture("agent-output-real.json"));
const noSleep = async () => {};
const getToken = async () => "test-token";

test("async polling: 202 -> 200 (running) -> 303 -> output; bearer token on every hop", async () => {
  const mock = await startMockTrigger({ runningPolls: 2, output: realOutput });
  try {
    const out = await invokeApiTrigger({ release_notes_markdown: "x" }, { triggerUrl: mock.url, getToken, sleep: noSleep });
    assert.deepEqual(out, realOutput);
    assert.deepEqual(mock.calls.map((c) => c.path), ["/t/trigger", "/status/1", "/status/1", "/status/1", "/output/1"]);
    assert.ok(mock.calls.every((c) => c.auth === "Bearer test-token"));
    assert.equal(JSON.parse(mock.calls[0].body).$callMode, "AsyncRequestReply");
  } finally {
    await mock.close();
  }
});

test("long polling: follows the 303 redirect loop and returns the final output", async () => {
  const mock = await startMockTrigger({ runningPolls: 2, output: realOutput });
  try {
    const out = await invokeApiTrigger({ a: 1 }, { triggerUrl: mock.url, callMode: "LongPolling", getToken, sleep: noSleep });
    assert.deepEqual(out, realOutput);
    assert.equal(mock.calls.filter((c) => c.path === "/status/1").length, 3);
  } finally {
    await mock.close();
  }
});

test("401 fails fast with a clear hint and no retries", async () => {
  const mock = await startMockTrigger({ output: realOutput });
  try {
    await assert.rejects(
      invokeApiTrigger({ a: 1 }, { triggerUrl: mock.url, getToken: async () => "wrong", sleep: noSleep }),
      (error) => error instanceof UiPathError && error.status === 401 && /token invalid/.test(error.message),
    );
    assert.equal(mock.calls.length, 1);
  } finally {
    await mock.close();
  }
});

test("transient 502 on start and on a status poll are retried", async () => {
  const mock = await startMockTrigger({ runningPolls: 1, output: realOutput, failures: { startStatus: 502, pollStatus: 502 } });
  try {
    const logs = [];
    const out = await invokeApiTrigger({ a: 1 }, { triggerUrl: mock.url, getToken, sleep: noSleep, log: (m) => logs.push(m) });
    assert.deepEqual(out, realOutput);
    assert.ok(logs.some((m) => /duplicate job/.test(m)), "start retry must warn about possible duplicate job");
  } finally {
    await mock.close();
  }
});

test("faulted job and failing output endpoint surface as errors", async () => {
  let mock = await startMockTrigger({ failures: { faultJob: true } });
  try {
    await assert.rejects(invokeApiTrigger({ a: 1 }, { triggerUrl: mock.url, getToken, sleep: noSleep }), /Faulted/);
  } finally {
    await mock.close();
  }
  mock = await startMockTrigger({ runningPolls: 0, failures: { outputStatus: 500 } });
  try {
    await assert.rejects(
      invokeApiTrigger({ a: 1 }, { triggerUrl: mock.url, getToken, sleep: noSleep, requestTimeoutMs: 5000 }),
      (error) => error.phase === "output",
    );
  } finally {
    await mock.close();
  }
});

test("job timeout is enforced", async () => {
  const mock = await startMockTrigger({ runningPolls: 1000, output: realOutput });
  let clock = 0;
  try {
    await assert.rejects(
      invokeApiTrigger({ a: 1 }, { triggerUrl: mock.url, getToken, sleep: async (ms) => { clock += ms; }, now: () => clock, jobTimeoutMs: 60_000 }),
      (error) => error.phase === "timeout",
    );
  } finally {
    await mock.close();
  }
});

test("OAuth client-credentials token is requested once and cached", async () => {
  let requests = 0;
  const fetchImpl = async (url, init) => {
    requests += 1;
    assert.equal(init.body.get("grant_type"), "client_credentials");
    assert.equal(init.body.get("scope"), "OR.Jobs");
    return new Response(JSON.stringify({ access_token: "abc", expires_in: 3600 }), { status: 200 });
  };
  const provider = createTokenProvider({ clientId: "id", clientSecret: "s", scopes: "OR.Jobs", identityUrl: "https://x/identity_/connect/token" }, { fetchImpl });
  assert.equal(await provider(), "abc");
  assert.equal(await provider(), "abc");
  assert.equal(requests, 1);
});

test("config: secrets required unless dry-run; invalid values rejected", () => {
  assert.throws(() => loadConfig({}, { argv: [] }), /UIPATH_TRIGGER_URL/);
  assert.doesNotThrow(() => loadConfig({}, { argv: ["--dry-run"] }));
  assert.throws(() => loadConfig({ RR_MAX_ARGS_JSON_CHARS: "12000" }, { argv: ["--dry-run"] }), /between/);
  assert.throws(() => loadConfig({ RR_MONTH: "2026-8" }, { argv: ["--dry-run"] }), /2026-08/);
  assert.throws(() => loadConfig({ UIPATH_TRIGGER_URL: "http://insecure", UIPATH_PAT: "x" }), /https/);
  const cfg = loadConfig({ RR_START_MONTH: "2025-11", RR_END_MONTH: "2026-02" }, { argv: ["--dry-run"] });
  assert.deepEqual(monthsToProcess(cfg).map((m) => m.id), ["2025-11", "2025-12", "2026-01", "2026-02"]);
  assert.equal(monthsToProcess(cfg)[3].markdownUrl, "https://docs.uipath.com/release-notes/other/latest/release-notes/cloud-platform-february-2026.md");
});

function pipelineDeps({ dataDir, mock, markdownFor, extraEnv = {}, argv = [], fetchLog = [] }) {
  const config = loadConfig(
    {
      RR_DATA_DIR: join(dataDir, "public"),
      RR_STATE_DIR: join(dataDir, "state"),
      RR_START_MONTH: "2026-07",
      RR_END_MONTH: "2026-09",
      UIPATH_TRIGGER_URL: "https://placeholder",
      UIPATH_PAT: "test-token",
      ...extraEnv,
    },
    { argv },
  );
  const fetchImpl = async (url) => {
    fetchLog.push(String(url));
    const md = markdownFor(String(url));
    if (md === null) return new Response("Not found", { status: 404 });
    return new Response(md, { status: 200, headers: { "Content-Type": "text/markdown" } });
  };
  const invoke = (args) => invokeApiTrigger(args, { triggerUrl: mock.url, getToken, sleep: noSleep });
  return { config, deps: { config, fetchImpl, invoke, sleep: noSleep, log: () => {} } };
}

// Echo back the products that were actually sent, like a real agent would.
const echoAgent = (payload) => {
  const names = [...payload.release_notes_markdown.matchAll(/^\*\*(.+?)\*\*/gm)].map((m) => m[1].replace(/ \((part|released).*$/, ""));
  return {
    changes_by_product: Object.fromEntries(
      names.map((n) => [n, { summary: `S ${n}`, changes: [{ name: n, summary: "", analysis: "", impact: "", breaking_change: false }], overall_analysis: "" }]),
    ),
  };
};

test("pipeline: first run publishes complete months; unchanged run = 0 agent jobs; only changed text re-analysed", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "rr-"));
  const sample = fixture("sample-month.md");
  let august = sample;
  const markdownFor = (url) => (url.includes("august-2026") ? august : url.includes("july-2026") ? sample.replace(/August/g, "July") : null);
  const mock = await startMockTrigger({ runningPolls: 0, output: echoAgent });
  try {
    const jobs = () => mock.calls.filter((c) => c.path === "/t/trigger").length;
    const first = pipelineDeps({ dataDir, mock, markdownFor });
    const months = monthsToProcess(first.config);
    const run1 = await runPipeline(months, first.deps);
    assert.deepEqual(run1.problems, []);
    const index = await readJson(join(dataDir, "public", "index.json"));
    assert.deepEqual(index.months.map((m) => [m.id, m.kind]), [["2026-08", "analysed"], ["2026-07", "analysed"]]);
    const aug = await readJson(join(dataDir, "public", "analysis", "2026-08.json"));
    assert.equal(aug.status, "complete");
    assert.equal(aug.counts.analysedProducts, aug.counts.products);
    assert.ok(await readJson(join(dataDir, "state", "2026-08.json")), "working state saved");
    const jobsAfterRun1 = jobs();
    assert.equal(jobsAfterRun1, aug.counts.chunks.total * 2);

    // Unchanged source -> no agent calls at all.
    await runPipeline(months, pipelineDeps({ dataDir, mock, markdownFor }).deps);
    assert.equal(jobs(), jobsAfterRun1);

    // UiPath adds a bullet to one section -> only that section's chunk is re-analysed.
    august = sample.replace("* Side panels now render", "* A brand-new Public Sector change.\n* Side panels now render");
    await runPipeline(months, pipelineDeps({ dataDir, mock, markdownFor }).deps);
    assert.equal(jobs(), jobsAfterRun1 + 1);
    const aug2 = await readJson(join(dataDir, "public", "analysis", "2026-08.json"));
    assert.equal(aug2.chunks.filter((c) => !c.reused).length, 1);
  } finally {
    await mock.close();
  }
});

test("pipeline: incomplete month is NOT published; next run retries only the failed chunk, then publishes", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "rr-"));
  const sample = fixture("sample-month.md");
  const pending = JSON.parse(fixture("pending-job-real.json"));
  let failFirst = 2; // first chunk: attempt 1 and its retry return a job record (invalid)
  const mock = await startMockTrigger({ runningPolls: 0, output: (payload) => (failFirst-- > 0 ? pending : echoAgent(payload)) });
  try {
    const opts = { dataDir, mock, markdownFor: (u) => (u.includes("august-2026") ? sample : null), extraEnv: { RR_CONCURRENCY: "1" } };
    const run1 = await runPipeline(monthsToProcess(pipelineDeps(opts).config), pipelineDeps(opts).deps);
    assert.ok(run1.problems.some((p) => p.startsWith("2026-08") && /not analysed yet/.test(p)));
    assert.equal(await readJson(join(dataDir, "public", "analysis", "2026-08.json")), null, "nothing half-finished is published");
    const index1 = await readJson(join(dataDir, "public", "index.json"));
    assert.deepEqual(index1.months, []);
    const state = await readJson(join(dataDir, "state", "2026-08.json"));
    assert.equal(state.chunks[0].status, "failed");
    assert.match(state.chunks[0].error, /job record/);
    const jobsBefore = mock.calls.filter((c) => c.path === "/t/trigger").length;

    const run2 = await runPipeline(monthsToProcess(pipelineDeps(opts).config), pipelineDeps(opts).deps);
    assert.deepEqual(run2.problems, []);
    assert.equal(mock.calls.filter((c) => c.path === "/t/trigger").length, jobsBefore + 1, "only the failed chunk is retried");
    const published = await readJson(join(dataDir, "public", "analysis", "2026-08.json"));
    assert.equal(published.status, "complete");
  } finally {
    await mock.close();
  }
});

test("pipeline: after the first run, older published months are frozen (not even downloaded)", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "rr-"));
  const sample = fixture("sample-month.md");
  const mock = await startMockTrigger({ runningPolls: 0, output: echoAgent });
  try {
    const markdownFor = (u) => (u.includes("2026.md") ? sample.replace(/August/g, u.match(/platform-(\w+)-2026/)[1].replace(/^./, (c) => c.toUpperCase())) : null);
    const env = { RR_START_MONTH: "2026-05", RR_END_MONTH: "2026-08", RR_RECHECK_MONTHS: "2" };
    const first = pipelineDeps({ dataDir, mock, markdownFor, extraEnv: env });
    await runPipeline(monthsToProcess(first.config), first.deps);
    const fetchLog = [];
    const second = pipelineDeps({ dataDir, mock, markdownFor, extraEnv: env, fetchLog });
    const run2 = await runPipeline(monthsToProcess(second.config), second.deps);
    assert.deepEqual(fetchLog.map((u) => u.match(/platform-(\w+)-2026/)[1]), ["july", "august"], "only the 2 latest months are checked");
    assert.equal(run2.index.months.length, 4, "frozen months stay published");
  } finally {
    await mock.close();
  }
});

test("pipeline: a month without highlight text is published as release dates only (no agent calls)", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "rr-"));
  const catalogOnly = [
    "# January 2026",
    "## Automation Cloud and Test Cloud",
    "### Release notes catalog",
    "#### Release notes catalog",
    " <colgroup><col/></colgroup>",
    " ",
    "   Product",
    "   Agents",
    "   ✅",
    "   January 30, 2026",
    "   Agents release notes",
    "  ",
  ].join("\n");
  const mock = await startMockTrigger({ output: echoAgent });
  try {
    const { config, deps } = pipelineDeps({ dataDir, mock, markdownFor: (u) => (u.includes("january-2026") ? catalogOnly : null), extraEnv: { RR_START_MONTH: "2026-01", RR_END_MONTH: "2026-01" } });
    const run = await runPipeline(monthsToProcess(config), deps);
    assert.deepEqual(run.index.months.map((m) => [m.id, m.kind]), [["2026-01", "release-dates"]]);
    assert.equal(mock.calls.length, 0);
  } finally {
    await mock.close();
  }
});

test("pipeline: 401 stops the run early (no wasted jobs) and reports fatal", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "rr-"));
  const mock = await startMockTrigger({ output: realOutput, token: "other-token" });
  try {
    const { config, deps } = pipelineDeps({ dataDir, mock, markdownFor: (u) => (u.includes("2026") ? fixture("sample-month.md") : null), extraEnv: { RR_CONCURRENCY: "1" } });
    const result = await runPipeline(monthsToProcess(config), deps);
    assert.ok(result.fatal);
    assert.equal(mock.calls.length, 1, "only one request before stopping");
  } finally {
    await mock.close();
  }
});

test("pipeline: dry run needs no credentials, never calls the agent and publishes nothing", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "rr-"));
  const config = loadConfig({ RR_DATA_DIR: join(dataDir, "public"), RR_STATE_DIR: join(dataDir, "state"), RR_MONTH: "2026-08" }, { argv: ["--dry-run"] });
  let invoked = 0;
  const deps = {
    config,
    fetchImpl: async () => new Response(fixture("sample-month.md"), { status: 200 }),
    invoke: async () => {
      invoked += 1;
    },
    sleep: noSleep,
    log: () => {},
  };
  await runPipeline(monthsToProcess(config), deps);
  assert.equal(invoked, 0);
  assert.equal(await readJson(join(dataDir, "public", "analysis", "2026-08.json")), null);
  assert.ok((await readJson(join(dataDir, "state", "2026-08.json"))).chunks.length > 0);
});

test("pipeline: RR_STORE_SOURCE=false keeps UiPath's original text out of the published data", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "rr-"));
  const mock = await startMockTrigger({ runningPolls: 0, output: echoAgent });
  try {
    const { config, deps } = pipelineDeps({ dataDir, mock, markdownFor: (u) => (u.includes("august-2026") ? fixture("sample-month.md") : null), extraEnv: { RR_STORE_SOURCE: "false" } });
    await runPipeline(monthsToProcess(config), deps);
    const aug = await readJson(join(dataDir, "public", "analysis", "2026-08.json"));
    assert.ok(aug.sections.every((s) => s.products.every((p) => p.source === "")));
    assert.equal(aug.sections[0].products.find((p) => p.name === "Test Manager").sourceMentionsBreaking, true);
  } finally {
    await mock.close();
  }
});

test("file input mode: chunk uploaded as an Orchestrator job attachment, File reference returned", async () => {
  const seen = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const part of req) body += part;
    seen.push({ method: req.method, url: req.url, headers: req.headers, body });
    if (req.method === "POST" && req.url === "/org/tenant/orchestrator_/odata/Attachments") {
      res.writeHead(201, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ Id: "505e370b-baa0-47dd-4062-08df1a47b7de", BlobFileAccess: { Uri: `http://127.0.0.1:${server.address().port}/blob/abc?sig=x`, Verb: "PUT", RequiresAuth: false, Headers: { Keys: ["x-ms-blob-type"], Values: ["BlockBlob"] } } }));
    }
    if (req.method === "PUT" && req.url.startsWith("/blob/abc")) {
      res.writeHead(201);
      return res.end();
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const triggerUrl = `${base}/org/tenant/orchestrator_/t/83cba7df-a87d-4bf7-9830-452d29fa3f01/release-notes`;
    assert.deepEqual(parseTriggerUrl(triggerUrl), { orchestratorUrl: `${base}/org/tenant/orchestrator_`, folderKey: "83cba7df-a87d-4bf7-9830-452d29fa3f01" });
    const ref = await uploadTextAttachment("# chunk text", { triggerUrl, name: "chunk.txt", getToken });
    assert.deepEqual(ref, { ID: "505e370b-baa0-47dd-4062-08df1a47b7de", FullName: "chunk.txt", MimeType: "text/plain" });
    assert.equal(seen[0].headers["x-uipath-folderkey"], "83cba7df-a87d-4bf7-9830-452d29fa3f01");
    assert.equal(seen[0].headers.authorization, "Bearer test-token");
    assert.equal(JSON.parse(seen[0].body).Name, "chunk.txt");
    assert.equal(seen[1].headers["x-ms-blob-type"], "BlockBlob");
    assert.equal(seen[1].headers.authorization, undefined, "SAS upload must not carry the bearer token");
    assert.equal(seen[1].body, "# chunk text");
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test("local portal server: serves published data, blocks path traversal, 404 for missing files", async () => {
  const { createPortalServer, safeJoin } = await import("../serve.mjs");
  assert.equal(safeJoin("/base", "../etc/passwd"), null);
  assert.equal(safeJoin("/base", "a/../../x"), null);
  assert.equal(safeJoin("/base", "data/index.json"), "/base/data/index.json");
  const server = createPortalServer();
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const index = await fetch(`${base}/data/index.json`);
    assert.equal(index.status, 200);
    assert.match(index.headers.get("content-type"), /application\/json/);
    assert.equal((await index.json()).schemaVersion, "1.2");
    assert.equal((await fetch(`${base}/data/..%2F..%2Fpackage.json`)).status, 404);
    assert.equal((await fetch(`${base}/..%2Fpackage.json`)).status, 404);
    assert.equal((await fetch(`${base}/no-such-file.js`)).status, 404);
    assert.equal((await fetch(`${base}/data/index.json`, { method: "POST" })).status, 405);
  } finally {
    await new Promise((done) => server.close(done));
  }
});
