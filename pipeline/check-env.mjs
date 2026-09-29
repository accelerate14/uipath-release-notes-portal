// Validates the local .env before a run (used by start-local.bat / start-local.sh).
// Prints what is missing in plain words; never prints secret values.
import { loadConfig } from "./lib/config.js";

try {
  const config = loadConfig(process.env, { argv: [] });
  const identity = config.uipath.clientId ? "External Application (client credentials)" : "Personal Access Token";
  console.log(`Settings OK: trigger ${new URL(config.uipath.triggerUrl).pathname.split("/").slice(0, 3).join("/")}/... using ${identity}.`);
} catch (error) {
  console.error(`Settings problem: ${error.message}`);
  console.error("Open the .env file in this folder, fill in the missing values, save it, and run again.");
  process.exit(1);
}
