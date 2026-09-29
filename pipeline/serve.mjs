// Local portal server with zero dependencies (used by start-local.bat / start-local.sh).
// Serves the built portal from dist/ and the latest published analysis from public/data/,
// on this PC only (127.0.0.1). No Vite, no native modules, nothing to install.
//   node pipeline/serve.mjs            -> http://127.0.0.1:5173 (next free port if busy)
//   RR_PORT=8080 node pipeline/serve.mjs
//   RR_NO_OPEN=true                    -> do not open the browser
import { exec } from "node:child_process";
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const DIST = join(ROOT, "dist");
const DATA = join(ROOT, "public", "data");
const HOST = "127.0.0.1";
const FIRST_PORT = Number(process.env.RR_PORT || 5173);

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

/** Resolve a URL path inside `base`; returns null for anything that escapes it. */
export function safeJoin(base, urlPath) {
  const full = normalize(join(base, urlPath));
  return full === base || full.startsWith(base + sep) ? full : null;
}

async function fileFor(pathname) {
  // Fresh analysis first (public/data), so a new run shows without rebuilding the portal.
  if (pathname.startsWith("/data/")) {
    const fromData = safeJoin(DATA, pathname.slice("/data/".length));
    if (fromData && (await stat(fromData).catch(() => null))?.isFile()) return fromData;
  }
  const candidate = safeJoin(DIST, pathname === "/" ? "index.html" : pathname);
  if (!candidate) return null;
  const info = await stat(candidate).catch(() => null);
  if (info?.isDirectory()) return join(candidate, "index.html");
  return info?.isFile() ? candidate : null;
}

export function createPortalServer() {
  return createServer(async (req, res) => {
    try {
      if (req.method !== "GET" && req.method !== "HEAD") {
        res.writeHead(405, { Allow: "GET, HEAD" }).end();
        return;
      }
      const pathname = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
      const file = await fileFor(pathname);
      if (!file) {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("Not found");
        return;
      }
      const body = await readFile(file);
      const type = TYPES[extname(file).toLowerCase()] || "application/octet-stream";
      const cache = file.includes(`${sep}assets${sep}`) ? "public, max-age=31536000, immutable" : "no-cache";
      res.writeHead(200, { "Content-Type": type, "Cache-Control": cache, "X-Content-Type-Options": "nosniff" });
      res.end(req.method === "HEAD" ? undefined : body);
    } catch {
      res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" }).end("Bad request");
    }
  });
}

function openBrowser(url) {
  if (process.env.RR_NO_OPEN === "true") return;
  const command =
    process.platform === "win32" ? `start "" "${url}"` : process.platform === "darwin" ? `open "${url}"` : `xdg-open "${url}"`;
  exec(command, () => {}); // best effort; the URL is printed anyway
}

async function main() {
  const index = await stat(join(DIST, "index.html")).catch(() => null);
  if (!index) {
    console.error("The portal is not built yet (dist/index.html is missing). Run: npm run build");
    process.exit(1);
  }
  const server = createPortalServer();
  for (let port = FIRST_PORT; port < FIRST_PORT + 20; port += 1) {
    const ok = await new Promise((done) => {
      server.once("error", (error) => done(error.code === "EADDRINUSE" ? false : Promise.reject(error)));
      server.listen(port, HOST, () => done(true));
    });
    if (ok) {
      const url = `http://127.0.0.1:${port}/`;
      console.log(`Release Radar portal is running at ${url} (also http://localhost:${port}/). This PC only; press Ctrl+C to stop.`);
      openBrowser(url);
      return;
    }
  }
  console.error(`No free port between ${FIRST_PORT} and ${FIRST_PORT + 19}. Set RR_PORT to another port.`);
  process.exit(1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`Could not start the portal: ${error.message}`);
    process.exit(1);
  });
}
