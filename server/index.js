// Tickr Node server — entry point.
// Owns the HTTP server, API, and (Phase B) the AI "thinking" layer. Python is
// the data tier, reached via server/tools/pythonData.js. The existing frontend
// (web/static/index.html) is served unchanged.
import express from "express";
import { resolve } from "node:path";
import { loadEnv, PORT, STATIC_DIR } from "./config.js";
import { connectDB } from "./lib/db.js";

import health from "./api/health.js";
import auth from "./api/auth.js";
import search from "./api/search.js";
import ticker from "./api/ticker.js";
import portfolio from "./api/portfolio.js";
import notes from "./api/notes.js";
import demo from "./api/demo.js";
import generate from "./api/generate.js";

loadEnv();

// Connect to MongoDB up front (for accounts + per-user data). Non-fatal: if the
// DB is unreachable the app still serves briefs and falls back to the file store.
await connectDB();

const app = express();
app.use(express.json());

// Static assets (same layout as the FastAPI mount).
app.use("/static", express.static(STATIC_DIR));

// API routers (each declares its own absolute /api/... paths).
app.use(health);
app.use(auth);
app.use(search);
app.use(ticker);
app.use(portfolio);
app.use(notes);
app.use(demo);
app.use(generate);

// Auth / onboarding page (login, signup, email-OTP, first-run onboarding).
app.get("/auth", (req, res) => res.sendFile(resolve(STATIC_DIR, "auth.html")));

// Single-page frontend. Its own client-side guard redirects to /auth when the
// visitor has no valid session.
app.get("/", (req, res) => res.sendFile(resolve(STATIC_DIR, "index.html")));

const server = app.listen(PORT, "0.0.0.0", () => {
  process.stderr.write(`Tickr Node server on http://localhost:${PORT}\n`);
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    process.stderr.write(`Port ${PORT} is already in use. Stop the other server or set a different PORT.\n`);
  } else {
    process.stderr.write(`Server error: ${err.message}\n`);
  }
  process.exit(1);
});
