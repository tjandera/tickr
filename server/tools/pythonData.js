// Bridge to the Python data tier (scripts/data_cli.py).
//
// runJson(cmd, args)  -> resolves the single JSON object printed on stdout.
// runStream(cmd, args, onEvent) -> calls onEvent(obj) for each NDJSON line,
//   and resolves with the final {"type":"result"} payload (if any).
import { spawn } from "node:child_process";
import { PYTHON, DATA_CLI } from "../config.js";

// Concurrency gate. Each call spawns a Python process that can run for seconds
// (research: minutes), so without a cap a burst of requests fork-bombs the box.
// At most MAX_CHILDREN run at once; a bounded queue absorbs small bursts and
// anything beyond that fails fast instead of piling up.
const MAX_CHILDREN = clampEnvInt("PY_MAX_CONCURRENCY", 4, 1, 32);
const MAX_QUEUE = clampEnvInt("PY_MAX_QUEUE", 16, 0, 200);
let running = 0;
const waiting = [];

function clampEnvInt(name, fallback, min, max) {
  const n = parseInt(process.env[name], 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

function acquireSlot() {
  if (running < MAX_CHILDREN) {
    running += 1;
    return Promise.resolve();
  }
  if (waiting.length >= MAX_QUEUE) {
    return Promise.reject(new Error("server is busy — too many data requests, try again shortly"));
  }
  return new Promise((resolve) => waiting.push(resolve));
}

function releaseSlot() {
  const next = waiting.shift();
  if (next) next(); // hand the slot straight to the next waiter (running stays the same)
  else running -= 1;
}

function buildArgs(cmd, { symbol, days, topic, quick, holdingsStdin } = {}) {
  const args = [DATA_CLI, cmd];
  if (symbol != null) args.push(String(symbol));
  if (days != null) args.push("--days", String(days));
  if (topic) args.push("--topic", String(topic));
  if (quick) args.push("--quick");
  if (holdingsStdin) args.push("--holdings-stdin");
  return args;
}

// Run a command that prints one JSON object on stdout. Pass `input` to write a
// payload (e.g. a user's holdings JSON) to the child's stdin.
export async function runJson(cmd, opts = {}, { timeoutMs = 120000, input = null } = {}) {
  await acquireSlot();
  let released = false;
  const release = () => { if (!released) { released = true; releaseSlot(); } };
  return new Promise((resolve, reject) => {
    const child = spawn(PYTHON, buildArgs(cmd, opts), { cwd: process.cwd() });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`data_cli ${cmd} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    // Feed stdin (the child only reads it when invoked with --holdings-stdin).
    child.stdin.on("error", () => {}); // ignore EPIPE if the child exits early
    child.stdin.end(input != null ? String(input) : undefined);

    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      release();
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      release();
      if (code !== 0 && !out.trim()) {
        return reject(new Error(`data_cli ${cmd} exited ${code}: ${err.slice(0, 400)}`));
      }
      try {
        resolve(JSON.parse(out.trim() || "null"));
      } catch (e) {
        reject(new Error(`data_cli ${cmd} bad JSON: ${(out || err).slice(0, 400)}`));
      }
    });
  });
}

// Run a command that streams NDJSON events (one JSON object per line).
// Returns the final {"type":"result"} object, or null.
export async function runStream(cmd, opts = {}, onEvent, { timeoutMs = 200000 } = {}) {
  await acquireSlot();
  let released = false;
  const release = () => { if (!released) { released = true; releaseSlot(); } };
  return new Promise((resolve, reject) => {
    const child = spawn(PYTHON, buildArgs(cmd, opts), { cwd: process.cwd() });
    let buf = "";
    let err = "";
    let result = null;
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`data_cli ${cmd} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    const handleLine = (line) => {
      const s = line.trim();
      if (!s) return;
      let obj;
      try {
        obj = JSON.parse(s);
      } catch {
        return; // ignore non-JSON noise
      }
      if (obj && obj.type === "result") {
        result = obj.data;
      } else if (onEvent) {
        try {
          onEvent(obj);
        } catch { /* listener errors must not kill the stream */ }
      }
    };

    child.stdout.on("data", (d) => {
      buf += d;
      let nl;
      while ((nl = buf.indexOf("\n")) !== -1) {
        handleLine(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
      }
    });
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      release();
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      release();
      if (buf.trim()) handleLine(buf);
      if (code !== 0 && result == null) {
        return reject(new Error(`data_cli ${cmd} exited ${code}: ${err.slice(0, 400)}`));
      }
      resolve(result);
    });
  });
}
