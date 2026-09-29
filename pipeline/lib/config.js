// Release Radar v1.2 - configuration (environment variables only; no secrets in code).
// Every client-specific value is here, so the pipeline can be reused per client/tenant
// by changing environment variables / GitHub secrets only.

import { ORCHESTRATOR_ARGS_LIMIT } from "./chunker.js";

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

function intEnv(env, name, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max} (got "${raw}")`);
  }
  return value;
}

function currentMonth(now = new Date()) {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function loadConfig(env = process.env, { argv = [], now = new Date() } = {}) {
  const flag = (name) => argv.includes(`--${name}`);
  const option = (name) => {
    const index = argv.indexOf(`--${name}`);
    return index >= 0 ? argv[index + 1] : undefined;
  };

  const dryRun = flag("dry-run") || env.RR_DRY_RUN === "true";
  const onlyMonth = option("month") || env.RR_MONTH || "";
  const startMonth = env.RR_START_MONTH || "2026-01";
  const endMonth = env.RR_END_MONTH || currentMonth(now);

  for (const [name, value] of [
    ["RR_START_MONTH", startMonth],
    ["RR_END_MONTH", endMonth],
  ]) {
    if (!MONTH_RE.test(value)) throw new Error(`${name} must look like 2026-08 (got "${value}")`);
  }
  if (onlyMonth && !MONTH_RE.test(onlyMonth)) throw new Error(`--month / RR_MONTH must look like 2026-08 (got "${onlyMonth}")`);

  const org = env.UIPATH_ORG || "";
  const cloudUrl = (env.UIPATH_CLOUD_URL || "https://cloud.uipath.com").replace(/\/+$/, "");

  const config = {
    dryRun,
    force: flag("force") || env.RR_FORCE === "true",
    onlyMonth,
    startMonth,
    endMonth,
    dataDir: env.RR_DATA_DIR || "public/data",
    stateDir: env.RR_STATE_DIR || "data-state",
    // After the first full run, only the most recent N months are re-checked for UiPath edits.
    recheckMonths: intEnv(env, "RR_RECHECK_MONTHS", 2, { min: 1, max: 36 }),
    // Change this (e.g. "agent-v3") after changing the agent prompt/model to re-analyse everything once.
    cacheKey: env.RR_CACHE_KEY || "v1",
    // false = do not store UiPath's original highlight text in public/data (analysis + links only).
    storeSource: env.RR_STORE_SOURCE !== "false",
    source: {
      baseUrl: (env.RR_SOURCE_BASE_URL || "https://docs.uipath.com/release-notes/other/latest/release-notes").replace(/\/+$/, ""),
      slugTemplate: env.RR_SLUG_TEMPLATE || "cloud-platform-{month}-{year}",
    },
    chunking: {
      argName: env.UIPATH_INPUT_ARG || "release_notes_markdown",
      maxArgsJsonChars: intEnv(env, "RR_MAX_ARGS_JSON_CHARS", 8000, { min: 2000, max: ORCHESTRATOR_ARGS_LIMIT }),
    },
    concurrency: intEnv(env, "RR_CONCURRENCY", 2, { min: 1, max: 5 }),
    failOnPartial: env.RR_FAIL_ON_PARTIAL === "true",
    uipath: {
      triggerUrl: env.UIPATH_TRIGGER_URL || "",
      method: (env.UIPATH_TRIGGER_METHOD || "POST").toUpperCase(),
      callMode: env.UIPATH_CALL_MODE || "AsyncRequestReply",
      // "text": send the chunk as a String argument (recommended).
      // "file": upload the chunk as a job attachment and pass a File reference (agents with a File input).
      inputType: (env.UIPATH_INPUT_TYPE || "text").toLowerCase(),
      pat: env.UIPATH_PAT || "",
      clientId: env.UIPATH_CLIENT_ID || "",
      clientSecret: env.UIPATH_CLIENT_SECRET || "",
      scopes: env.UIPATH_SCOPES || "OR.Jobs",
      identityUrl: env.UIPATH_IDENTITY_URL || (org ? `${cloudUrl}/${org}/identity_/connect/token` : ""),
      extraArgs: {},
      pollIntervalMs: intEnv(env, "RR_POLL_INTERVAL_MS", 5000, { min: 1000 }),
      jobTimeoutMs: intEnv(env, "RR_JOB_TIMEOUT_MS", 20 * 60 * 1000, { min: 60_000 }),
    },
  };

  if (env.UIPATH_EXTRA_ARGS) {
    try {
      config.uipath.extraArgs = JSON.parse(env.UIPATH_EXTRA_ARGS);
    } catch {
      throw new Error("UIPATH_EXTRA_ARGS must be a JSON object");
    }
  }
  if (!["POST", "PUT"].includes(config.uipath.method)) {
    throw new Error("UIPATH_TRIGGER_METHOD must be POST or PUT (the input is sent as a JSON body)");
  }
  if (!["text", "file"].includes(config.uipath.inputType)) {
    throw new Error("UIPATH_INPUT_TYPE must be text or file");
  }
  if (!["AsyncRequestReply", "LongPolling"].includes(config.uipath.callMode)) {
    throw new Error("UIPATH_CALL_MODE must be AsyncRequestReply or LongPolling");
  }

  if (!dryRun) {
    const missing = [];
    if (!config.uipath.triggerUrl) missing.push("UIPATH_TRIGGER_URL");
    const oauth = config.uipath.clientId || config.uipath.clientSecret;
    if (oauth) {
      if (!config.uipath.clientId) missing.push("UIPATH_CLIENT_ID");
      if (!config.uipath.clientSecret) missing.push("UIPATH_CLIENT_SECRET");
      if (!config.uipath.identityUrl) missing.push("UIPATH_ORG (or UIPATH_IDENTITY_URL)");
    } else if (!config.uipath.pat) {
      missing.push("UIPATH_PAT (or UIPATH_CLIENT_ID + UIPATH_CLIENT_SECRET)");
    }
    if (missing.length) throw new Error(`Missing configuration: ${missing.join(", ")}`);
    if (!/^https:\/\//.test(config.uipath.triggerUrl)) throw new Error("UIPATH_TRIGGER_URL must be an https URL");
  }

  return config;
}

const MONTH_NAMES = [
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
];

/** List of months to process, e.g. [{ id: "2026-08", name: "august", year: 2026, label: "August 2026" }]. */
export function monthsToProcess(config) {
  const ids = [];
  if (config.onlyMonth) ids.push(config.onlyMonth);
  else {
    let [year, month] = config.startMonth.split("-").map(Number);
    const [endYear, endMonth] = config.endMonth.split("-").map(Number);
    while (year < endYear || (year === endYear && month <= endMonth)) {
      ids.push(`${year}-${String(month).padStart(2, "0")}`);
      month += 1;
      if (month > 12) {
        month = 1;
        year += 1;
      }
    }
  }
  return ids.map((id) => {
    const [year, month] = id.split("-").map(Number);
    const name = MONTH_NAMES[month - 1];
    const slug = config.source.slugTemplate.replace("{month}", name).replace("{year}", String(year));
    return {
      id,
      year,
      name,
      label: `${name[0].toUpperCase()}${name.slice(1)} ${year}`,
      slug,
      markdownUrl: `${config.source.baseUrl}/${slug}.md`,
      pageUrl: `${config.source.baseUrl}/${slug}`,
    };
  });
}
