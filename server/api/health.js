// GET /api/health — which synthesis backend is live (mirrors web/app.py::health).
import express from "express";
const { Router } = express;
import { isDBConnected } from "../lib/db.js";

const router = Router();

router.get("/api/health", (req, res) => {
  const backend = (process.env.LLM_BACKEND || "").trim().toLowerCase();
  const geminiUp = backend !== "agnes" && Boolean((process.env.GEMINI_API_KEY || "").trim());
  const hasAgnes = backend !== "gemini" && Boolean(process.env.AGNES_API_KEY);

  let active = null;
  let model = null;
  if (geminiUp) {
    active = "gemini";
    model = process.env.GEMINI_MODEL || "gemini-2.5-flash";
  } else if (hasAgnes) {
    active = "agnes";
    model = "agnes-2.0-flash";
  }

  const webKey = ["BRAVE_API_KEY", "SERPER_API_KEY", "TAVILY_API_KEY"].find((k) => process.env[k]);
  res.json({
    live: Boolean(active),
    backend: active,
    model,
    agnes: Boolean(active), // back-compat: the masthead lamp reads this
    web_search: webKey || false,
    accounts: isDBConnected(), // when true, the app requires a login
  });
});

export default router;
