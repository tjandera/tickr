// /api/portfolio* — holdings CRUD + enriched overview.
//
// When a user is signed in, holdings live on their MongoDB document. When logged
// out (or the DB is down), the shared local file store is used, so the app keeps
// working exactly as before accounts existed.
import express from "express";
const { Router } = express;
import * as store from "../store/store.js";
import { runJson } from "../tools/pythonData.js";
import { attachUser } from "../middleware/auth.js";

const router = Router();
router.use(attachUser); // sets req.user when a valid session exists, else null

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

router.get("/api/portfolio", (req, res) => {
  if (req.user) return res.json({ holdings: req.user.holdings || [] });
  res.json({ holdings: store.getHoldings() });
});

router.post("/api/portfolio", async (req, res) => {
  const ticker = (req.body?.ticker || "").trim().toUpperCase();
  if (!ticker) return res.status(400).json({ detail: "ticker is required" });
  const shares = num(req.body?.shares) || 0;
  const costBasis = num(req.body?.cost_basis);

  if (req.user) {
    const u = req.user;
    const existing = (u.holdings || []).find((h) => h.ticker === ticker);
    if (existing) {
      existing.shares = shares;
      existing.cost_basis = costBasis;
    } else {
      u.holdings.push({ ticker, shares, cost_basis: costBasis, added_at: new Date() });
    }
    await u.save();
    return res.json({ status: "ok", holding: u.holdings.find((h) => h.ticker === ticker) });
  }

  const holding = store.upsertHolding(ticker, shares, costBasis);
  res.json({ status: "ok", holding });
});

router.delete("/api/portfolio/:ticker", async (req, res) => {
  const t = (req.params.ticker || "").toUpperCase();
  if (req.user) {
    const before = req.user.holdings.length;
    req.user.holdings = req.user.holdings.filter((h) => h.ticker !== t);
    await req.user.save();
    return res.json({ status: "ok", removed: req.user.holdings.length < before });
  }
  const removed = store.removeHolding(req.params.ticker);
  res.json({ status: "ok", removed });
});

// Holdings enriched with live price, P&L, weight, and a quick signal. For a
// signed-in user the holdings are piped to the Python enricher via stdin; logged
// out, Python reads the file store.
router.get("/api/portfolio/overview", async (req, res) => {
  try {
    let data;
    if (req.user) {
      const holdings = (req.user.holdings || []).map((h) => ({
        ticker: h.ticker,
        shares: h.shares,
        cost_basis: h.cost_basis,
      }));
      data = await runJson(
        "portfolio-overview",
        { holdingsStdin: true },
        { timeoutMs: 90000, input: JSON.stringify(holdings) }
      );
    } else {
      data = await runJson("portfolio-overview", {}, { timeoutMs: 90000 });
    }
    res.json(data || { holdings: [], totals: {}, movers: [] });
  } catch (e) {
    res.status(500).json({ detail: String(e.message || e) });
  }
});

export default router;
