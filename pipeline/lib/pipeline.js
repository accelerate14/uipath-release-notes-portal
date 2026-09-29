// Release Radar v1.2 - pipeline orchestration.
// fetch markdown -> parse -> chunk -> (cache | agent) -> validate -> merge -> publish.
//
// Rules:
//   * A month is PUBLISHED only when every chunk has a valid agent answer (or the month has no
//     highlight text at all, in which case only its release dates are published). Readers never
//     see half-finished work: if some chunks fail, the previous published version stays live and
//     the failed chunks are retried on the next run.
//   * First run: every month from RR_START_MONTH is analysed. Later runs: only the most recent
//     RR_RECHECK_MONTHS months are re-checked, and only text that changed is sent to the agent.
// All I/O is injectable so the whole flow is covered by automated tests.

import { buildChunks } from "./chunker.js";
import { describeDocument, parseReleaseNotes } from "./markdown.js";
import { AgentOutputError, mergeMonth, normalizeAgentOutput } from "./merge.js";
import { SCHEMA_VERSION, readMonth, readState, sha256, updateIndex, writeMonth, writeState } from "./store.js";
import { UiPathError } from "./uipath.js";

export class FatalRunError extends Error {}

const FATAL_STATUS = new Set([401, 403, 404]);
const PUBLISHABLE = new Set(["complete", "no-highlights"]);

async function fetchMarkdown(url, { fetchImpl, sleep, log }) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetchImpl(url, { signal: AbortSignal.timeout(30_000), headers: { Accept: "text/markdown, text/plain" } });
      if (response.status === 404) return { notFound: true };
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const text = await response.text();
      if (!text.trim().startsWith("#")) throw new Error("response is not a markdown document");
      return { text };
    } catch (error) {
      if (attempt === 2) throw new Error(`Could not fetch ${url}: ${error.message}`);
      log(`warn: fetch ${url} failed (${error.message}); retrying`);
      await sleep(3000 * (attempt + 1));
    }
  }
  return { notFound: true };
}

async function runPool(items, limit, worker) {
  const queue = [...items];
  const runners = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length) await worker(queue.shift());
  });
  await Promise.all(runners);
}

function summarise(month) {
  return {
    id: month.id,
    label: month.label,
    kind: month.status === "no-highlights" ? "release-dates" : "analysed",
    generatedAt: month.generatedAt,
    sourceSha256: month.source.sha256,
    pageUrl: month.source.pageUrl,
    counts: month.counts,
    file: `analysis/${month.id}.json`,
  };
}

/**
 * Process one month end to end.
 * deps: { config, fetchImpl, invoke(args) -> raw output, sleep, log, now, recent }
 * Returns { summary?, published, unchanged?, skipped?, pendingReason? }.
 */
export async function processMonth(monthRef, deps) {
  const { config, fetchImpl, invoke, sleep, log, now = () => new Date(), recent = true } = deps;
  const tag = `[${monthRef.id}]`;
  const published = await readMonth(config.dataDir, monthRef.id);

  // Older months that are already published are frozen: not even downloaded again.
  if (published && !recent && !config.force && !config.onlyMonth) {
    return { summary: summarise(published), published: true, unchanged: true, frozen: true };
  }

  const fetched = await fetchMarkdown(monthRef.markdownUrl, { fetchImpl, sleep, log });
  if (fetched.notFound) {
    log(`${tag} not published by UiPath yet (404) - skipped`);
    return { skipped: true, published: false };
  }

  const markdown = fetched.text;
  const sourceSha = sha256(markdown);
  const state = await readState(config.stateDir, monthRef.id);
  const cacheKey = config.cacheKey || "v1";

  if (
    !config.force &&
    published &&
    published.source?.sha256 === sourceSha &&
    published.cacheKey === cacheKey
  ) {
    log(`${tag} unchanged since ${published.generatedAt} - nothing to do`);
    return { summary: summarise(published), published: true, unchanged: true };
  }

  const doc = parseReleaseNotes(markdown);
  const { chunks, warnings: chunkWarnings } = buildChunks(doc, {
    monthLabel: monthRef.label,
    argName: config.chunking.argName,
    callMode: config.uipath.callMode,
    extraArgs: config.uipath.extraArgs,
    maxArgsJsonChars: config.chunking.maxArgsJsonChars,
  });
  const stats = describeDocument(doc);
  log(`${tag} ${stats.sections} sections, ${stats.products} product blocks, ${chunks.length} chunks (max payload ${Math.max(0, ...chunks.map((c) => c.payloadChars))} chars)`);

  // Reuse every answer we already have (from the working state or the published month).
  const cache = new Map();
  for (const source of [published?.chunks, state?.chunks]) {
    for (const c of source || []) if (c.status === "ok" && c.result) cache.set(c.sha256, c.result);
  }

  const agentWarnings = [];
  let fatal = null;
  const records = chunks.map((chunk) => ({
    id: chunk.id,
    sectionId: chunk.sectionId,
    sha256: sha256(`${cacheKey}\n${config.chunking.argName}\n${chunk.text}`),
    chars: chunk.chars,
    payloadChars: chunk.payloadChars,
    products: chunk.products,
    status: "pending",
    reused: false,
    error: null,
    result: null,
    durationMs: null,
    _text: chunk.text,
  }));

  const toRun = [];
  for (const record of records) {
    if (!config.force && cache.has(record.sha256)) {
      record.status = "ok";
      record.reused = true;
      record.result = cache.get(record.sha256);
    } else if (!config.dryRun) {
      toRun.push(record);
    }
  }
  log(`${tag} ${records.length - toRun.length} chunk(s) already analysed, ${toRun.length} to analyse${config.dryRun ? " (dry run: agent not called)" : ""}`);

  let done = 0;
  await runPool(toRun, config.concurrency, async (record) => {
    if (fatal) return;
    const started = Date.now();
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        const raw = await invoke({ ...config.uipath.extraArgs, [config.chunking.argName]: record._text });
        const { products, warnings } = normalizeAgentOutput(raw);
        agentWarnings.push(...warnings.map((w) => `${record.id}: ${w}`));
        record.status = "ok";
        record.result = { products };
        record.error = null;
        break;
      } catch (error) {
        record.status = "failed";
        record.error = error.message;
        if (error instanceof UiPathError && FATAL_STATUS.has(error.status)) {
          fatal = error;
          break;
        }
        const retry = attempt < 2 && (error instanceof AgentOutputError || error.retryable);
        log(`${tag} chunk ${record.id} failed (attempt ${attempt}): ${error.message}${retry ? " - retrying" : ""}`);
        if (!retry) break;
      }
    }
    record.durationMs = Date.now() - started;
    done += 1;
    if (record.status === "ok") log(`${tag} analysed ${done}/${toRun.length} (${Math.round(record.durationMs / 1000)} s)`);
  });

  const merged = mergeMonth(doc, records);
  if (config.storeSource === false) {
    for (const section of merged.sections) for (const product of section.products) product.source = "";
  }
  const chunkState = records.map(({ _text, ...rest }) => rest);
  const month = {
    schemaVersion: SCHEMA_VERSION,
    id: monthRef.id,
    label: monthRef.label,
    title: doc.title,
    cacheKey,
    generatedAt: now().toISOString(),
    source: { pageUrl: monthRef.pageUrl, markdownUrl: monthRef.markdownUrl, sha256: sourceSha, chars: markdown.length },
    ...merged,
    chunks: chunkState,
    warnings: [...doc.warnings, ...chunkWarnings, ...agentWarnings],
  };

  // Working state is always saved, so the next run only retries what is missing.
  await writeState(config.stateDir, { id: month.id, cacheKey, sourceSha256: sourceSha, status: month.status, updatedAt: month.generatedAt, chunks: chunkState, warnings: month.warnings });

  let result;
  if (PUBLISHABLE.has(month.status) && !config.dryRun) {
    await writeMonth(config.dataDir, month);
    log(`${tag} PUBLISHED: ${month.counts.products} products, ${month.counts.changes} updates, ${month.counts.breakingChanges} breaking`);
    result = { summary: summarise(month), published: true };
  } else {
    const missing = month.counts.chunks.total - month.counts.chunks.ok;
    const reason = config.dryRun ? "dry run" : `${missing} of ${month.counts.chunks.total} chunks not analysed yet`;
    log(`${tag} not published (${reason})${published ? "; the previous complete version stays live" : ""}`);
    result = { summary: published ? summarise(published) : null, published: Boolean(published), pendingReason: reason };
  }

  if (fatal) throw new FatalRunError(`${tag} stopping: ${fatal.message}`);
  return result;
}

/** Process all configured months and update index.json (published months only). */
export async function runPipeline(monthRefs, deps) {
  const { config, log } = deps;
  const summaries = [];
  const problems = [];
  const recentIds = new Set(monthRefs.slice(-Math.max(1, config.recheckMonths || 2)).map((m) => m.id));
  let fatal = null;
  let checked = 0;

  for (const monthRef of monthRefs) {
    try {
      const result = await processMonth(monthRef, { ...deps, recent: recentIds.has(monthRef.id) });
      if (!result.frozen) checked += 1;
      if (result.summary) summaries.push(result.summary);
      if (result.pendingReason && !config.dryRun) problems.push(`${monthRef.id}: ${result.pendingReason}`);
    } catch (error) {
      if (error instanceof FatalRunError) {
        fatal = error;
        break;
      }
      problems.push(`${monthRef.id}: ${error.message}`);
      log(`[${monthRef.id}] ERROR ${error.message}`);
    }
  }
  log(`checked ${checked} month(s); ${monthRefs.length - checked} older published month(s) left unchanged`);

  const index = config.dryRun ? null : await updateIndex(config.dataDir, summaries, { source: config.source.baseUrl });
  return { index, summaries, problems, fatal };
}
