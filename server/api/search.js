// GET /api/search?q= — ticker symbol search (via Python data tier).
import express from "express";
const { Router } = express;
import { runJson } from "../tools/pythonData.js";
import { capString } from "../lib/validate.js";

const router = Router();

router.get("/api/search", async (req, res) => {
  // Free text (company names are fine), just capped so junk can't reach Yahoo.
  const q = capString(req.query.q, 60);
  if (!q) return res.json([]);
  try {
    const results = await runJson("search", { symbol: q }, { timeoutMs: 20000 });
    res.json(results || []);
  } catch (e) {
    res.json([{ error: "search is unavailable right now" }]);
  }
});

export default router;
