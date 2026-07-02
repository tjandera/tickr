// GET /api/search?q= — ticker symbol search (via Python data tier).
import express from "express";
const { Router } = express;
import { runJson } from "../tools/pythonData.js";

const router = Router();

router.get("/api/search", async (req, res) => {
  const q = (req.query.q || "").toString();
  try {
    const results = await runJson("search", { symbol: q }, { timeoutMs: 20000 });
    res.json(results || []);
  } catch (e) {
    res.json([{ error: String(e.message || e) }]);
  }
});

export default router;
