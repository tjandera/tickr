// Minimal error logging. Routes send users a generic message and put the real
// detail here (stderr), so internals (driver errors, file paths, stack info)
// never travel to the client.
export function logError(scope, e) {
  const msg = e && e.stack ? e.stack.split("\n").slice(0, 3).join(" | ") : String(e);
  process.stderr.write(`[${scope}] ${msg}\n`);
}
