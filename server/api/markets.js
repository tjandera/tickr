// GET /api/markets — public index quotes (S&P, Nasdaq, Dow, BTC) for the
// landing page's live market strip. No auth, no holdings, cached 60s.
import express from "express";
const { Router } = express;
import { runJson } from "../tools/pythonData.js";
import { cached } from "../lib/cache.js";
import { logError } from "../lib/log.js";

const router = Router();

router.get("/api/markets", async (req, res) => {
  try {
    const data = await cached("markets", 60_000, () =>
      runJson("markets", {}, { timeoutMs: 20000 }));
    res.json(data || { indices: [] });
  } catch (e) {
    logError("markets", e);
    res.status(500).json({ detail: "Market data is unavailable right now." });
  }
});

export default router;
