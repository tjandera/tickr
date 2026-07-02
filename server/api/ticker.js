// GET /api/ticker/:symbol[?days] — price, fundamentals, history.
// GET /api/ticker/:symbol/chart — PNG (unused by the frontend; kept for parity).
import express from "express";
const { Router } = express;
import { runJson } from "../tools/pythonData.js";

const router = Router();

router.get("/api/ticker/:symbol", async (req, res) => {
  const days = parseInt(req.query.days, 10) || 90;
  try {
    const data = await runJson("ticker", { symbol: req.params.symbol, days });
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
