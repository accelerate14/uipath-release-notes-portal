#!/usr/bin/env node
// Release Radar v1.2 - CLI entry point.
//   node pipeline/run.js                 analyse all months (only changed content hits the agent)
//   node pipeline/run.js --month 2026-08 analyse one month
//   node pipeline/run.js --force         ignore the cache and re-run the agent
//   node pipeline/run.js --dry-run       parse + chunk only; no UiPath calls, no credentials needed
// Exit codes: 0 = all months published, 1 = fatal/config error,
//             3 = some months still incomplete (only when RR_FAIL_ON_PARTIAL=true; used by start-local).

import { appendFile } from "node:fs/promises";
import { loadConfig, monthsToProcess } from "./lib/config.js";
import { runPipeline } from "./lib/pipeline.js";
import { createTokenProvider, invokeApiTrigger, uploadTextAttachment } from "./lib/uipath.js";

const inActions = process.env.GITHUB_ACTIONS === "true";
const log = (message) => {
  const line = `${new Date().toISOString()} ${message}`;
  if (inActions && /(warn:|ERROR|failed)/.test(message)) console.log(`::warning::${message}`);
  console.log(line);
};

async function main() {
  const config = loadConfig(process.env, { argv: process.argv.slice(2) });
  const months = monthsToProcess(config);
  log(`Release Radar pipeline: ${months.length} month(s) ${months[0]?.id} .. ${months.at(-1)?.id}; mode=${config.dryRun ? "dry-run" : config.uipath.callMode}; force=${config.force}; budget=${config.chunking.maxArgsJsonChars} chars/job`);

  let invoke = async () => {
    throw new Error("Agent calls are disabled in dry-run mode");
  };
  if (!config.dryRun) {
    const getToken = createTokenProvider(config.uipath);
    let uploads = 0;
    invoke = async (args) => {
      let finalArgs = args;
      if (config.uipath.inputType === "file") {
        // Agent expects a File input: upload the chunk as an Orchestrator job attachment first.
        uploads += 1;
        const reference = await uploadTextAttachment(args[config.chunking.argName], {
          triggerUrl: config.uipath.triggerUrl,
          name: `release-radar-chunk-${Date.now()}-${uploads}.txt`,
          getToken,
        });
        finalArgs = { ...args, [config.chunking.argName]: reference };
      }
      return invokeApiTrigger(finalArgs, {
        triggerUrl: config.uipath.triggerUrl,
        method: config.uipath.method,
        callMode: config.uipath.callMode,
        getToken,
        pollIntervalMs: config.uipath.pollIntervalMs,
        jobTimeoutMs: config.uipath.jobTimeoutMs,
        log,
      });
    };
  }

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const result = await runPipeline(months, { config, fetchImpl: fetch, invoke, sleep, log });

  const rows = [...result.summaries]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((s) => `| ${s.id} | ${s.kind === "release-dates" ? "release dates only" : "analysed"} | ${s.counts.products} | ${s.counts.changes} | ${s.counts.breakingChanges} |`)
    .join("\n");
  const summary = `### Release Radar run\n\nPublished months:\n\n| Month | Content | Products | Updates | Breaking |\n|---|---|---|---|---|\n${rows || "| - | - | - | - | - |"}\n\n${
    result.problems.length
      ? `**Not published yet (retried automatically on the next run):**\n${result.problems.map((p) => `- ${p}`).join("\n")}\n`
      : config.dryRun ? "Dry run: nothing published." : "All months are fully analysed and published."
  }\n`;
  console.log(`\n${summary}`);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, summary);

  if (result.fatal) {
    console.error(`FATAL: ${result.fatal.message}`);
    process.exitCode = 1;
  } else if (result.problems.length && config.failOnPartial) {
    process.exitCode = 3;
  }
}

main().catch((error) => {
  console.error(`FATAL: ${error.message}`);
  process.exitCode = 1;
});
