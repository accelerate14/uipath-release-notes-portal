import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Content-Security-Policy for the production build (GitHub Pages cannot set headers, so a
// meta tag is used). Not applied in dev because Vite's dev server injects inline scripts.
// connect-src 'self': the portal only reads its own static JSON; it never calls UiPath.
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com",
  "img-src 'self' data:",
  "connect-src 'self'",
  "base-uri 'self'",
  "form-action 'none'",
  "object-src 'none'",
].join("; ");

const cspPlugin = {
  name: "release-radar-csp",
  apply: "build",
  transformIndexHtml(html) {
    return html.replace(
      "<head>",
      `<head>\n  <meta http-equiv="Content-Security-Policy" content="${CSP}">\n  <meta name="referrer" content="strict-origin-when-cross-origin">`,
    );
  },
};

export default defineConfig(({ command }) => ({
  plugins: [react(), cspPlugin],
  // Relative paths: the same build works on GitHub Pages (any repo name), UiPath Coded Apps
  // (the platform injects <base href="/<app>/">), Vercel/Netlify or any sub-folder.
  // Override with VITE_BASE (e.g. "/my-path/") only if a host needs an absolute path.
  base: command === "serve" ? "/" : process.env.VITE_BASE || "./",
  build: { sourcemap: false },
}));
