// Shared paths + env loading for the Node server.
import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

export const ROOT = resolve(__dirname, "..");          // repo root
export const SCRIPTS_DIR = resolve(ROOT, "scripts");
export const STATIC_DIR = resolve(ROOT, "web", "static");
export const DEMO_DIR = resolve(STATIC_DIR, "demo");
export const DATA_DIR = resolve(ROOT, "web", "data");
export const DATA_CLI = resolve(SCRIPTS_DIR, "data_cli.py");

// Load repo-root .env into process.env (same rules as web/app.py): existing
// vars win, so anything already set in the shell takes precedence. Called
// immediately below (not just by index.js) because ESM hoists imports: every
// other module that imports config.js runs before index.js's own top-level
// code, so PYTHON below must not depend on index.js calling loadEnv() first.
export function loadEnv() {
  const envPath = resolve(ROOT, ".env");
  if (!existsSync(envPath)) return;
  for (const raw of readFileSync(envPath, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const idx = line.indexOf("=");
    const key = line.slice(0, idx).trim();
    const val = line.slice(idx + 1).trim();
    if (!(key in process.env)) process.env[key] = val;
  }
}
loadEnv();

// Prefer TICKR_PYTHON (set in .env — points outside iCloud, see start.sh),
// then the project venv interpreter, then PATH python3.
export const PYTHON =
  process.env.TICKR_PYTHON ||
  (existsSync(resolve(ROOT, ".venv/bin/python"))
    ? resolve(ROOT, ".venv/bin/python")
    : "python3");

export const PORT = parseInt(process.env.PORT || "3005", 10);
