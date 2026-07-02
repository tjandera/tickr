// Preflight check for the account system. Run from repo root or server/:
//   node server/scripts/db-check.mjs   (or: npm run db:check)
//
// Verifies env vars, MongoDB connect + read/write, and the Resend key. Every
// step prints immediately and risky calls are wrapped in a hard timeout, so this
// can never hang silently — you always get a definitive result.

const ok = (s) => console.log(`  \x1b[32m✓\x1b[0m ${s}`);
const bad = (s) => console.log(`  \x1b[31m✗\x1b[0m ${s}`);
const info = (s) => console.log(`  \x1b[36m•\x1b[0m ${s}`);

// Reject after `ms` if `p` has not settled — turns a silent hang into a result.
const withTimeout = (p, ms, label) =>
  Promise.race([
    p,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`timed out after ${ms}ms (${label})`)), ms)),
  ]);

let failures = 0;
console.log("\nTickr account-system preflight\n");

// 1. Environment ------------------------------------------------------------
console.log("Loading .env ...");
const { loadEnv } = await import("../config.js");
loadEnv();

console.log("Environment:");
for (const [key, required] of [
  ["MONGODB_URI", true],
  ["JWT_SECRET", true],
  ["ENCRYPTION_KEY", false],
  ["RESEND_API", false],
  ["EMAIL_FROM", false],
  ["APP_URL", false],
]) {
  if ((process.env[key] || "").trim()) ok(`${key} is set`);
  else if (required) { bad(`${key} is MISSING (required)`); failures++; }
  else info(`${key} not set (optional)`);
}

// 2. MongoDB ----------------------------------------------------------------
console.log("\nMongoDB:");
let mongoose;
try {
  console.log("  connecting (max 15s) ...");
  mongoose = (await import("mongoose")).default;
  const { connectDB, isDBConnected } = await import("../lib/db.js");
  const { User } = await import("../models/User.js");

  const connected = await withTimeout(connectDB(), 10000, "mongoose.connect");
  if (!connected || !isDBConnected()) {
    bad("could not connect");
    info("checklist: password has no < > brackets · special chars URL-encoded ·");
    info("           Atlas → Network Access allows your IP (or 0.0.0.0/0 for dev) ·");
    info("           the cluster is not paused");
    failures++;
  } else {
    ok(`connected to database "${mongoose.connection.name}"`);
    const probe = await withTimeout(
      User.collection.insertOne({ _probe: true, at: new Date() }), 8000, "write probe");
    await User.collection.deleteOne({ _id: probe.insertedId });
    ok("read/write access confirmed");
    const count = await withTimeout(User.countDocuments(), 8000, "count");
    info(`${count} account${count === 1 ? "" : "s"} registered`);
  }
} catch (e) {
  bad(e.message);
  failures++;
}

// 3. Encryption self-test ---------------------------------------------------
console.log("\nEncryption (notes at rest):");
try {
  const { encrypt, decrypt, isEncrypted } = await import("../lib/encryption.js");
  const sample = "test note 123";
  const ct = encrypt(sample);
  if (isEncrypted(ct) && decrypt(ct) === sample) ok("AES-256-GCM encrypt/decrypt works");
  else { bad("round-trip mismatch"); failures++; }
} catch (e) {
  bad(e.message);
  failures++;
}

// 4. Email (Resend) — validate the key without sending ----------------------
console.log("\nEmail (Resend):");
const rkey = (process.env.RESEND_API || process.env.RESEND_API_KEY || "").trim();
if (!rkey) {
  info("no RESEND_API key — verification/OTP emails will be logged to console instead");
} else {
  try {
    const { Resend } = await import("resend");
    const resend = new Resend(rkey);
    const { error } = await withTimeout(resend.domains.list(), 10000, "resend");
    if (error && /restricted/i.test(error.message || "")) ok("API key valid (send-only, as expected)");
    else if (error) { bad(`Resend: ${error.message}`); failures++; }
    else ok("API key valid");
  } catch (e) { bad(e.message); failures++; }
}

console.log(
  failures === 0
    ? "\n\x1b[32mAll checks passed — accounts are ready.\x1b[0m\n"
    : `\n\x1b[31m${failures} check(s) failed — see above.\x1b[0m\n`
);

if (mongoose) await mongoose.disconnect().catch(() => {});
process.exit(failures === 0 ? 0 : 1);
