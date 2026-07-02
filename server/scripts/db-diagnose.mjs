// Deep MongoDB connection diagnosis. Run:
//   node server/scripts/db-diagnose.mjs
//
// Prints every internal driver event (heartbeats, server + topology changes) as
// it happens, so we can see precisely where a connection stalls: DNS, TLS, auth,
// or replica-set primary discovery. Hard-exits at 22s no matter what.
import { loadEnv } from "../config.js";
loadEnv();

const t0 = Date.now();
const log = (s) => console.log(`  +${String(Date.now() - t0).padStart(5)}ms  ${s}`);

const uri = (process.env.MONGODB_URI || "").trim();
if (!uri) { console.log("MONGODB_URI not set"); process.exit(1); }

console.log("\nMongoDB deep diagnosis\n");

// Safe fingerprint (no password).
const m = uri.match(/^(mongodb(?:\+srv)?):\/\/([^:]+):[^@]+@([^/?]+)/);
if (m) log(`uri: ${m[1]} · user ${m[2]} · host ${m[3]}`);

const { MongoClient } = await import("mongodb");
const client = new MongoClient(uri, {
  serverSelectionTimeoutMS: 8000,
  connectTimeoutMS: 8000,
});

client.on("serverOpening", (e) => log(`opening       ${e.address}`));
client.on("serverClosed", (e) => log(`closed        ${e.address}`));
client.on("serverHeartbeatSucceeded", (e) => log(`heartbeat OK  ${e.connectionId} (${Math.round(e.duration)}ms)`));
client.on("serverHeartbeatFailed", (e) => log(`heartbeat XX  ${e.connectionId} — ${e.failure?.message || e.failure}`));
client.on("serverDescriptionChanged", (e) => log(`server        ${e.address} → ${e.newDescription.type}`));
client.on("topologyDescriptionChanged", (e) =>
  log(`TOPOLOGY      → ${e.newDescription.type}  [${[...e.newDescription.servers.keys()].join(", ")}]`));

setTimeout(() => {
  log("HARD EXIT at 22s — the connection never became usable.");
  log("If you see TOPOLOGY stuck at 'ReplicaSetNoPrimary', the driver reached the");
  log("cluster and authenticated but could not reach the elected PRIMARY node.");
  process.exit(2);
}, 22000);

log("calling connect() ...");
try {
  await client.connect();
  log("connect() returned");
  const r = await client.db("admin").command({ ping: 1 });
  log(`PING OK — ${JSON.stringify(r)}`);
  await client.close();
  log("SUCCESS — the connection is fully working.");
  process.exit(0);
} catch (e) {
  log(`ERROR — ${e.name}: ${e.message}`);
  if (e.reason) log(`reason: ${JSON.stringify(e.reason).slice(0, 400)}`);
  process.exit(1);
}
