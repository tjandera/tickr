// Tickr Node server — entry point.
// Owns the HTTP server, API, and (Phase B) the AI "thinking" layer. Python is
// the data tier, reached via server/tools/pythonData.js. The existing frontend
// (web/static/index.html) is served unchanged.
import express from "express";
import { resolve } from "node:path";
import { loadEnv, PORT, STATIC_DIR, VIEWS_DIR } from "./config.js";
import { connectDB } from "./lib/db.js";
import { securityHeaders } from "./middleware/securityHeaders.js";
import { apiLimiter } from "./middleware/rateLimit.js";

import health from "./api/health.js";
import auth from "./api/auth.js";
import search from "./api/search.js";
import ticker from "./api/ticker.js";
import portfolio from "./api/portfolio.js";
import notes from "./api/notes.js";
import demo from "./api/demo.js";
import generate from "./api/generate.js";
import home from "./api/home.js";
import markets from "./api/markets.js";

loadEnv();

// Connect to MongoDB up front (for accounts + per-user data). Non-fatal: if the
// DB is unreachable the app still serves briefs and falls back to the file store.
await connectDB();

const app = express();
app.disable("x-powered-by"); // don't advertise the framework
app.set("views", VIEWS_DIR);
app.set("view engine", "ejs");
app.use(securityHeaders);
// Explicit body cap: the largest legitimate payload (a full note) is a few KB.
app.use(express.json({ limit: "100kb" }));

// Behind a reverse proxy (nginx, Railway, Fly, …) the client IP arrives in
// X-Forwarded-For, and rate limiting keys on req.ip — set TRUST_PROXY=1 (or
// the hop count) in that deployment or every visitor shares the proxy's IP.
if (process.env.TRUST_PROXY) {
  const hops = parseInt(process.env.TRUST_PROXY, 10);
  app.set("trust proxy", Number.isFinite(hops) ? hops : 1);
}

// Static assets (same layout as the FastAPI mount).
app.use("/static", express.static(STATIC_DIR));

// General API ceiling; auth + generate add their own tighter limits.
app.use("/api", apiLimiter);

// API routers (each declares its own absolute /api/... paths).
app.use(health);
app.use(auth);
app.use(search);
app.use(ticker);
app.use(portfolio);
app.use(notes);
app.use(demo);
app.use(generate);
app.use(home);
app.use(markets);

const welcomePage = {
  nav: [
    { label: "Product", href: "#product" },
    { label: "How it works", href: "#how" },
    { label: "Try it", href: "#try" },
    { label: "Security", href: "#security" },
  ],
  heroCards: [
    { label: "Portfolio", value: "$24,318.90", meta: "+$412.55 today" },
    { label: "Signal", value: "Hold", meta: "Earnings are the next test" },
    { label: "Sources", value: "7", meta: "News, filings, sentiment, markets" },
  ],
  steps: [
    {
      eyebrow: "Step 01",
      title: "Add the position",
      body: "Save a ticker, shares, and optional cost basis. Tickr keeps the context attached to the brief.",
    },
    {
      eyebrow: "Step 02",
      title: "Generate the brief",
      body: "The app pulls market data, news, filings, community sentiment, and prediction-market context.",
    },
    {
      eyebrow: "Step 03",
      title: "Read the decision layer",
      body: "You get plain-English movement, levels to watch, dates that matter, and a clear next-action signal.",
    },
  ],
  sourceCards: [
    "Market prices",
    "Financial news",
    "SEC filings",
    "Community sentiment",
    "Prediction markets",
    "Peer context",
  ],
  chips: ["AAPL", "NVDA", "MSFT", "BTC-USD"],
  faqs: [
    {
      q: "Is Tickr financial advice?",
      a: "No. Tickr is research and explanation software. It helps summarize information, but investment decisions are still yours.",
    },
    {
      q: "Do I need an account to try it?",
      a: "No. The ticker preview on this page works without signup. Accounts are for saved holdings and full portfolio briefs.",
    },
    {
      q: "What data does it use?",
      a: "Tickr combines price data, fundamentals, headlines, filings, community discussion, and selected market context.",
    },
  ],
};

// Public marketing homepage (logged-out visitors land here).
app.get("/welcome", (req, res) => res.render("welcome", welcomePage));

// Auth / onboarding page (login, signup, email-OTP, first-run onboarding).
app.get("/auth", (req, res) => res.sendFile(resolve(STATIC_DIR, "auth.html")));

// Single-page app. Its own client-side guard sends anonymous visitors to
// /welcome (marketing) when accounts are enabled and no session exists.
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
