// MongoDB connection (Mongoose). The auth + user-data features use this; if
// MONGODB_URI is absent or the connection fails, the app still runs and falls
// back to the local JSON file store (web/data/*.json), so nothing breaks.
import mongoose from "mongoose";

export async function connectDB() {
  const uri = (process.env.MONGODB_URI || "").trim();
  if (!uri) {
    process.stderr.write("[db] MONGODB_URI not set — accounts disabled, using local file store.\n");
    return false;
  }
  if (mongoose.connection.readyState === 1) return true;
  try {
    mongoose.set("strictQuery", true);
    await mongoose.connect(uri, {
      dbName: process.env.MONGODB_DB || "tickr",
      serverSelectionTimeoutMS: 8000,
      connectTimeoutMS: 8000,
      socketTimeoutMS: 20000,
      // A single small pool is plenty for hundreds of users on M0.
      maxPoolSize: 10,
      // Force IPv4. On networks with broken/half-open IPv6 the driver can stall
      // after auth while probing replica-set members over IPv6; IPv4 avoids it.
      family: 4,
    });
    process.stderr.write(`[db] MongoDB connected (db: ${mongoose.connection.name})\n`);

    mongoose.connection.on("error", (e) =>
      process.stderr.write(`[db] connection error: ${e.message}\n`));
    mongoose.connection.on("disconnected", () =>
      process.stderr.write("[db] MongoDB disconnected\n"));
    return true;
  } catch (e) {
    process.stderr.write(`[db] MongoDB connection FAILED: ${e.message}\n`);
    // MongoServerSelectionError hides the useful detail (per-node errors) in
    // .reason — surface it so the cause (TLS, timeout, auth) is visible.
    if (e.reason) process.stderr.write(`[db] reason: ${String(e.reason).slice(0, 400)}\n`);
    return false;
  }
}

// True only when a live, ready connection exists. Routes use this to decide
// whether to serve account features or fall back to the file store. Reads
// Mongoose's own connection state directly (rather than a separately tracked
// flag), so it self-heals the instant the driver reconnects in the background —
// no restart required after a transient drop (idle timeout, network blip, etc).
export function isDBConnected() {
  return mongoose.connection.readyState === 1;
}
