// Release Radar v1.2 - UiPath Orchestrator API-trigger client (server-side only).
//
// Implements the documented call modes:
//   https://docs.uipath.com/orchestrator/automation-cloud/latest/user-guide/call-modes-explained
//   AsyncRequestReply (async polling, recommended): POST -> 202 + Location (status URI);
//     GET status -> 200 while running, 303 + Location (output URI) when done; GET output -> result.
//   LongPolling (sync): POST blocks; on timeout 303 -> status URI (blocks again, may 303 again);
//     final 200 carries the result. Max job duration 15 minutes (UiPath limit).
// Redirects are followed manually so that the Authorization header is sent on every hop and
// every status code is visible. This code runs in Node (GitHub Actions), never in a browser.

export class UiPathError extends Error {
  constructor(message, { status, body, retryable = false, phase } = {}) {
    super(message);
    this.name = "UiPathError";
    this.status = status;
    this.body = body;
    this.retryable = retryable;
    this.phase = phase;
  }
}

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);
const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function readBody(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function describe(body) {
  if (body == null) return "";
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return text.length > 400 ? `${text.slice(0, 400)}...` : text;
}

function statusHint(status) {
  switch (status) {
    case 400:
      return " (input rejected - check argument name/type and the 10,000-character limit)";
    case 401:
      return " (token invalid or expired)";
    case 403:
      return " (identity lacks Jobs Create/View in the trigger's folder, or the OAuth scope is missing)";
    case 404:
      return " (trigger URL/slug not found, or trigger disabled)";
    default:
      return "";
  }
}

/** Token provider: static PAT, or OAuth client credentials (UiPath External Application). */
export function createTokenProvider(config, { fetchImpl = fetch, now = () => Date.now() } = {}) {
  if (config.clientId && config.clientSecret) {
    let cached = null;
    return async function getToken() {
      if (cached && cached.expiresAt - 60_000 > now()) return cached.token;
      const response = await fetchImpl(config.identityUrl, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
        body: new URLSearchParams({
          grant_type: "client_credentials",
          client_id: config.clientId,
          client_secret: config.clientSecret,
          scope: config.scopes,
        }),
        signal: AbortSignal.timeout(30_000),
      });
      const body = await readBody(response);
      if (!response.ok || !body?.access_token) {
        throw new UiPathError(`Token request failed (HTTP ${response.status}): ${describe(body?.error || body)}`, {
          status: response.status,
          phase: "auth",
        });
      }
      cached = { token: body.access_token, expiresAt: now() + (Number(body.expires_in) || 3600) * 1000 };
      return cached.token;
    };
  }
  if (config.pat) return async () => config.pat;
  throw new UiPathError(
    "No UiPath credentials configured (set UIPATH_PAT, or UIPATH_CLIENT_ID + UIPATH_CLIENT_SECRET)",
    { phase: "config" },
  );
}

/**
 * Start a job through an API trigger and return the job's output arguments.
 * @param {object} args input arguments (without $callMode)
 */
export async function invokeApiTrigger(args, options) {
  const {
    triggerUrl,
    method = "POST",
    callMode = "AsyncRequestReply",
    getToken,
    fetchImpl = fetch,
    sleep = defaultSleep,
    pollIntervalMs = 5000,
    maxPollIntervalMs = 15000,
    jobTimeoutMs = 20 * 60 * 1000,
    requestTimeoutMs = 120_000,
    postRetries = 1,
    pollRetries = 5,
    log = () => {},
    now = () => Date.now(),
  } = options;

  if (!["AsyncRequestReply", "LongPolling"].includes(callMode)) {
    throw new UiPathError(`Unsupported call mode "${callMode}" (use AsyncRequestReply or LongPolling)`, {
      phase: "config",
    });
  }

  const deadline = now() + jobTimeoutMs;
  const authHeaders = async () => ({ Authorization: `Bearer ${await getToken()}`, Accept: "application/json" });

  const backoff = (attempt, response) => {
    const retryAfter = Number(response?.headers?.get("retry-after"));
    if (Number.isFinite(retryAfter) && retryAfter > 0) return Math.min(retryAfter * 1000, 60_000);
    return Math.min(2000 * 2 ** attempt, 30_000);
  };

  const fail = async (response, phase) => {
    const body = await readBody(response);
    throw new UiPathError(`${phase} returned HTTP ${response.status}${statusHint(response.status)}: ${describe(body)}`, {
      status: response.status,
      body,
      retryable: RETRYABLE_STATUS.has(response.status),
      phase,
    });
  };

  const nextUrl = (response, baseUrl) => {
    const value = response.headers.get("location");
    if (!value) {
      throw new UiPathError(`HTTP ${response.status} without a Location header`, { phase: "redirect" });
    }
    return new URL(value, baseUrl).toString();
  };

  /** One HTTP call with retries for transient failures. Returns a non-retryable response. */
  const request = async (url, init, phase, retries) => {
    for (let attempt = 0; ; attempt += 1) {
      let response;
      let reason;
      try {
        response = await fetchImpl(url, { ...init, redirect: "manual", signal: AbortSignal.timeout(requestTimeoutMs) });
        if (!RETRYABLE_STATUS.has(response.status)) return response;
        reason = `HTTP ${response.status}`;
      } catch (error) {
        reason = error.message;
      }
      if (attempt >= retries) {
        if (response) await fail(response, phase);
        throw new UiPathError(`${phase} request failed: ${reason}`, { phase, retryable: true });
      }
      if (response) await response.text().catch(() => ""); // release the connection
      if (phase === "start") {
        // Known UiPath issue: a 502 can be returned even though the job was created.
        log(`warn: start failed (${reason}); retrying once - check Orchestrator for a duplicate job`);
      } else {
        log(`warn: ${phase} failed (${reason}); retry ${attempt + 1}/${retries}`);
      }
      await sleep(backoff(attempt, response));
    }
  };

  const get = async (url, phase) => request(url, { method: "GET", headers: await authHeaders() }, phase, pollRetries);

  // 1. Start the job.
  let response = await request(
    triggerUrl,
    {
      method,
      headers: { ...(await authHeaders()), "Content-Type": "application/json" },
      body: JSON.stringify({ ...args, $callMode: callMode }),
    },
    "start",
    postRetries,
  );

  if (callMode === "LongPolling") {
    let url = triggerUrl;
    for (;;) {
      if (response.ok) return readBody(response); // 200: job finished, body = output
      if (!REDIRECT_STATUS.has(response.status)) await fail(response, url === triggerUrl ? "start" : "status");
      if (now() > deadline) throw new UiPathError("Job did not finish in time", { phase: "timeout" });
      url = nextUrl(response, url);
      response = await get(url, "status"); // blocks server-side until done or timeout
    }
  }

  // AsyncRequestReply
  if (response.status === 200) return readBody(response); // trigger answered synchronously
  if (response.status !== 202) await fail(response, "start");
  const statusUrl = nextUrl(response, triggerUrl);
  log(`job accepted; polling status`);

  let interval = pollIntervalMs;
  for (;;) {
    if (now() > deadline) {
      throw new UiPathError(`Job did not finish within ${Math.round(jobTimeoutMs / 60000)} minutes`, {
        phase: "timeout",
      });
    }
    await sleep(interval);
    interval = Math.min(Math.round(interval * 1.5), maxPollIntervalMs);

    const status = await get(statusUrl, "status");
    if (status.status === 200) {
      const job = await readBody(status); // job record while Pending/Running
      if (job && typeof job === "object" && /^(faulted|stopped)$/i.test(String(job.state || ""))) {
        throw new UiPathError(`Job ended in state ${job.state}: ${describe(job.info ?? job)}`, {
          phase: "job",
          body: job,
        });
      }
      continue;
    }
    if (REDIRECT_STATUS.has(status.status)) {
      const outputUrl = nextUrl(status, statusUrl);
      const output = await get(outputUrl, "output");
      if (output.ok) return readBody(output);
      await fail(output, "output");
    }
    await fail(status, "status");
  }
}

/**
 * Split an API-trigger URL into the Orchestrator base URL and the folder key.
 * https://cloud.uipath.com/{org}/{tenant}/orchestrator_/t/{folderKey}/{slug}
 */
export function parseTriggerUrl(triggerUrl) {
  const match = /^(https?:\/\/[^/]+\/[^/]+\/[^/]+\/orchestrator_)\/t\/([0-9a-fA-F-]{36})\/[^/?#]+/.exec(String(triggerUrl));
  if (!match) throw new UiPathError("UIPATH_TRIGGER_URL does not look like an Orchestrator API trigger URL", { phase: "config" });
  return { orchestratorUrl: match[1], folderKey: match[2] };
}

/**
 * Upload text as an Orchestrator job attachment and return the reference an agent "File" input expects:
 *   { ID, FullName, MimeType }.
 * Same flow the Orchestrator UI and UiPath's Python SDK use:
 *   POST {orchestrator}/odata/Attachments {"Name"} -> { Id, BlobFileAccess: { Uri, Headers, RequiresAuth } }
 *   PUT  BlobFileAccess.Uri with the returned headers and the file bytes.
 */
export async function uploadTextAttachment(text, { triggerUrl, name, getToken, fetchImpl = fetch, folderKey, orchestratorUrl }) {
  const parsed = orchestratorUrl && folderKey ? { orchestratorUrl, folderKey } : parseTriggerUrl(triggerUrl);
  const token = await getToken();
  const create = await fetchImpl(`${parsed.orchestratorUrl}/odata/Attachments`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json", "x-uipath-folderkey": parsed.folderKey },
    body: JSON.stringify({ Name: name }),
    signal: AbortSignal.timeout(60_000),
  });
  const created = await readBody(create);
  if (!create.ok || !created?.Id || !created?.BlobFileAccess?.Uri) {
    throw new UiPathError(`attachment create returned HTTP ${create.status}${statusHint(create.status)}: ${describe(created)}`, {
      status: create.status,
      phase: "attachment",
      retryable: RETRYABLE_STATUS.has(create.status),
    });
  }
  const access = created.BlobFileAccess;
  const headers = {};
  (access.Headers?.Keys || []).forEach((key, i) => {
    headers[key] = access.Headers.Values[i];
  });
  if (access.RequiresAuth) headers.Authorization = `Bearer ${token}`;
  headers["Content-Type"] = "text/plain; charset=utf-8";
  const put = await fetchImpl(access.Uri, {
    method: access.Verb || "PUT",
    headers,
    body: new TextEncoder().encode(text),
    signal: AbortSignal.timeout(60_000),
  });
  if (!put.ok) {
    throw new UiPathError(`attachment upload returned HTTP ${put.status}`, { status: put.status, phase: "attachment", retryable: true });
  }
  return { ID: created.Id, FullName: name, MimeType: "text/plain" };
}
