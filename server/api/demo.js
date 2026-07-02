// /api/demo* — cached demo digests served from web/static/demo/.
import express from "express";
const { Router } = express;
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { DEMO_DIR } from "../config.js";

const router = Router();

const safeKey = (k) => (k || "").toLowerCase().replace(/[^a-z0-9-]/g, "");

router.get("/api/demo", (req, res) => {
  const path = resolve(DEMO_DIR, "index.json");
  if (!existsSync(path)) return res.json([]);
  try {
    res.json(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    res.json([]);
  }
});

router.get("/api/demo/:key", (req, res) => {
  const key = safeKey(req.params.key);
  const path = resolve(DEMO_DIR, `${key}.json`);
  if (!key || !existsSync(path)) return res.status(404).json({ detail: "demo not found" });
  try {
    res.json(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    res.status(404).json({ detail: "demo not found" });
  }
});

// Live build-and-cache is an admin action the frontend does not call in normal
// use; the brief pipeline (Phase B) supersedes it. Report not-implemented.
router.post("/api/demo/build", (req, res) => {
  res.status(501).json({ status: "error", message: "demo build runs via the Python tooling" });
});

export default router;
