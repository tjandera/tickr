// GET /api/ticker/:symbol[?days] — price, fundamentals, history.
// GET /api/ticker/:symbol/chart — PNG (unused by the frontend; kept for parity).
import express from "express";
const { Router } = express;
import { runJson } from "../tools/pythonData.js";
import { cached } from "../lib/cache.js";

const router = Router();

const TICKER_TTL_MS = 60_000; // market data is delayed anyway; 60s staleness is invisible

router.get("/api/ticker/:symbol", async (req, res) => {
  const days = parseInt(req.query.days, 10) || 90;
  const symbol = String(req.params.symbol || "").trim().toUpperCase();
  try {
    const data = await cached(`ticker:${symbol}:${days}`, TICKER_TTL_MS, () =>
      runJson("ticker", { symbol, days }));
    if (data && data.error) return res.status(400).json({ detail: data.error });
    res.json(data);
  } catch (e) {
    res.status(400).json({ detail: String(e.message || e) });
  }
});

// The frontend draws its own canvas chart from history, so the PNG endpoint is
// not exercised. Report not-implemented rather than pulling in matplotlib.
router.get("/api/ticker/:symbol/chart", (req, res) => {
  res.status(501).json({ detail: "chart PNG is rendered client-side" });
});

export default router;
