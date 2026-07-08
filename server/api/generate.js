// GET /api/generate (SSE) — the brief pipeline.
//
// Node owns the orchestration + AI "thinking"; Python (data_cli research)
// provides the snapshot, research, deterministic panels, and the offline
// fallback. Emits the exact frame contract the frontend's handleFrame expects:
// start, phase, snapshot, search_*, status, digest, essay_*, done.
import express from "express";
const { Router } = express;
import { runStream } from "../tools/pythonData.js";
import { isAvailable, modelLabel } from "../thinking/geminiClient.js";
import { synthesize } from "../thinking/synthesize.js";
import { streamEssay } from "../thinking/essay.js";
import { stripDashes } from "../thinking/prompts.js";
import { getCached, setCached } from "../lib/cache.js";
import { attachUser, requireUserIfAccounts } from "../middleware/auth.js";
import { generateLimiter } from "../middleware/rateLimit.js";
import { cleanSymbol, clampInt, capString } from "../lib/validate.js";
import { logError } from "../lib/log.js";

// Research (snapshot + the 7-source fan-out) is the slowest phase, and its
// output changes on the minute scale. A short cache makes a repeat brief of the
// same ticker skip straight to AI synthesis; the recorded progress frames are
// replayed so the UI experience is identical, just immediate.
const RESEARCH_TTL_MS = 60_000;

const router = Router();
const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache",
  "X-Accel-Buffering": "no",
  Connection: "keep-alive",
};

// Gated: a brief is the most expensive call in the app (research subprocess +
// paid AI tokens), so it is rate-limited per IP, and with accounts enabled it
// requires a login — anonymous visitors get the free /api/ticker teaser instead.
router.get("/api/generate", generateLimiter, attachUser, requireUserIfAccounts, async (req, res) => {
  const symbol = cleanSymbol(req.query.symbol);
  const days = clampInt(req.query.days, { min: 1, max: 365, fallback: 30 });
  const topic = capString(req.query.topic, 120);
  const quick = req.query.quick === "true";

  res.writeHead(200, SSE_HEADERS);

  // Guard every write: once the client disconnects (or the response ends), the
  // socket is dead and writing to it throws an unhandled 'error' that would
  // crash the server. Track closure and become a no-op.
  let closed = false;
  let keepalive = null;
  const onClose = () => { closed = true; if (keepalive) clearInterval(keepalive); };
  res.on("error", onClose);
  req.on("close", onClose);
  const send = (obj) => { if (!closed && !res.writableEnded) res.write(`data: ${JSON.stringify(obj)}\n\n`); };

  if (!symbol) {
    send({ type: "error", message: "Please enter a valid ticker symbol (e.g. AAPL, BTC-USD).", fatal: true });
    send({ type: "done" });
    return res.end();
  }

  // Keepalive so idle proxies do not drop the connection during long calls.
  keepalive = setInterval(() => { if (!closed && !res.writableEnded) res.write(": keepalive\n\n"); }, 15000);
  const finish = () => { if (keepalive) clearInterval(keepalive); send({ type: "done" }); if (!res.writableEnded) res.end(); };

  send({ type: "start", symbol, days, topic });

  try {
    // 1. Snapshot + research + panels + offline fallback (one Python call),
    //    with a short-lived cache keyed on the exact request shape.
    send({ type: "phase", key: "snapshot", label: "Fetching market data" });
    const cacheKey = `research:${symbol}:${days}:${topic || ""}:${quick}`;
    let data;
    const hit = getCached(cacheKey);
    if (hit) {
      // Replay the recorded progress frames so the live-sources UI fills in.
      send({ type: "phase", key: "research", label: "Reading the news" });
      for (const ev of hit.events) send(ev);
      data = hit.data;
    } else {
      const events = [];
      let researchEmitted = false;
      data = await runStream("research", { symbol, days, topic, quick }, (ev) => {
        // Forward the Python progress frames verbatim (snapshot, search_*, status).
        if (ev.type === "search_start" && !researchEmitted) {
          researchEmitted = true;
          send({ type: "phase", key: "research", label: "Reading the news" });
        }
        events.push(ev);
        send(ev);
        if (ev.type === "error" && ev.fatal) throw new Error(ev.message || "snapshot failed");
      });
      if (data) setCached(cacheKey, { data, events }, RESEARCH_TTL_MS);
    }

    if (!data) throw new Error("no research result");
    const { real, grounded_snapshot, research, position, panels, window, asset_type,
            offline_digest, offline_essay } = data;

    // 2. Synthesis — Gemini (Node) with the Python offline digest as fallback.
    send({ type: "phase", key: "synthesis", label: "Writing your brief" });
    let digest;
    let live = false;
    let fallback = false;
    if (isAvailable()) {
      try {
        digest = await synthesize({ real, research, groundedSnapshot: grounded_snapshot, position, days, quick });
        live = true;
        if (!digest.tldr) throw new Error("empty tldr");
      } catch (e) {
        logError("generate.synthesis", e);
        send({ type: "status", message: "Synthesis fell back to offline mode." });
        digest = offline_digest;
        fallback = true;
      }
    } else {
      digest = offline_digest;
    }

    // 3. Assemble the full digest the frontend renders (mirrors build_digest).
    Object.assign(digest, {
      news: panels.news || [],
      feed: panels.feed || [],
      watch_this_week: panels.watch_this_week || [],
      risk: panels.risk || null,
      income: panels.income || null,
      finnhub: panels.finnhub || {},
      market: panels.market || null,
      video: panels.video || null,
      peers: panels.peers || [],
      next_earnings: panels.next_earnings || null,
      history: real.history || [],
      meta: {
        generated_at: new Date().toISOString(),
        model: live ? modelLabel() : "offline",
        live,
        grounded: true,
        fallback,
        days,
        window,
        asset_type,
      },
    });
    if (position) digest.position = position;
    send({ type: "digest", data: digest });

    // 4. The essay — streamed from Gemini, or the Python offline essay.
    send({ type: "essay_start" });
    let full = "";
    let streamed = false;
    if (isAvailable()) {
      try {
        for await (const piece of streamEssay({ real, digest, research, position, days })) {
          full += piece;
          send({ type: "essay_chunk", text: piece });
          streamed = true;
        }
      } catch (e) {
        const note = essayNote(e);
        full = "";
        send({ type: "status", message: note });
        send({ type: "essay_note", text: note });
      }
    } else {
      const note = "No AI backend configured. Showing data-driven offline summary.";
      send({ type: "essay_note", text: note });
    }

    if (streamed && full.trim()) {
      full = stripDashes(full);
    } else {
      full = offline_essay || "";
      send({ type: "essay_chunk", text: full });
    }
    send({ type: "essay_done", text: full });

    finish();
  } catch (e) {
    logError("generate", e);
    send({ type: "error", message: "The brief could not be generated. Please try again.", fatal: true });
    finish();
  }
});

// Map a Gemini failure to the same user-facing note the Python stack shows.
function essayNote(e) {
  const status = e?.status;
  const msg = (e?.apiMessage || "").toLowerCase();
  if (msg.includes("depleted") || msg.includes("billing")) {
    return "AI credits depleted. This summary uses verified market data only. Top up at aistudio.google.com to restore AI-written essays.";
  }
  if (status === 429) return "AI rate limit hit. This summary uses verified market data only. Try again in a minute.";
  if (status) return `AI unavailable (HTTP ${status}). Showing data-driven offline summary.`;
  return "AI unavailable. Showing data-driven offline summary.";
}

export default router;
