// Minimal mock of an Orchestrator API trigger that follows the documented call-mode
// semantics (202/200/303 for async polling; 303 loop for long polling). Test use only.
import { createServer } from "node:http";

export async function startMockTrigger({ runningPolls = 2, output, token = "test-token", failures = {} } = {}) {
  const calls = [];
  const payloads = new Map(); // job id -> POST body of that job
  let jobs = 0;
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const part of req) body += part;
    const url = new URL(req.url, "http://localhost");
    calls.push({ method: req.method, path: url.pathname, auth: req.headers.authorization, body });

    const count = (key) => calls.filter((c) => c.path.startsWith(key)).length;
    const send = (status, payload, headers = {}) => {
      res.writeHead(status, { "Content-Type": "application/json", ...headers });
      res.end(payload === undefined ? "" : JSON.stringify(payload));
    };

    if (req.headers.authorization !== `Bearer ${token}`) return send(401, { message: "Unauthorized" });

    if (url.pathname === "/t/trigger") {
      if (failures.startStatus && count("/t/trigger") <= (failures.startTimes ?? 1)) return send(failures.startStatus, { message: "gateway" });
      const payload = JSON.parse(body || "{}");
      if (JSON.stringify(payload).length > 10000) return send(400, { message: "Input arguments exceed 10000 characters" });
      jobs += 1;
      const id = jobs;
      payloads.set(String(id), payload);
      if (payload.$callMode === "LongPolling") return send(303, undefined, { Location: `/status/${id}?mode=sync` });
      return send(202, { key: `job-${id}`, state: "Pending" }, { Location: `/status/${id}` });
    }
    if (url.pathname.startsWith("/status/")) {
      const id = url.pathname.split("/")[2];
      if (failures.pollStatus && count("/status/") <= (failures.pollTimes ?? 1)) return send(failures.pollStatus, { message: "gateway" });
      const polls = calls.filter((c) => c.path === url.pathname).length;
      if (url.searchParams.get("mode") === "sync") {
        if (polls <= runningPolls) return send(303, undefined, { Location: `/status/${id}?mode=sync` });
        return send(200, typeof output === "function" ? output(payloads.get(id), calls) : output);
      }
      if (failures.faultJob) return send(200, { key: `job-${id}`, state: "Faulted", info: "agent crashed" });
      if (polls <= runningPolls) return send(200, { key: `job-${id}`, state: "Running" });
      return send(303, undefined, { Location: `/output/${id}` });
    }
    if (url.pathname.startsWith("/output/")) {
      if (failures.outputStatus) return send(failures.outputStatus, { message: "Job faulted" });
      const id = url.pathname.split("/")[2];
      return send(200, typeof output === "function" ? output(payloads.get(id), calls) : output);
    }
    return send(404, { message: "not found" });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}/t/trigger`,
    base: `http://127.0.0.1:${port}`,
    calls,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
