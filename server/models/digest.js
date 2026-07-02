// Digest shape + coercion — ported from finance_digest._coerce_digest /
// _fallback_headline / _clean_digest_text. Normalizes raw model JSON into the
// renderable digest the frontend expects, with em/en dashes stripped.
import { stripDashes } from "../thinking/prompts.js";

export const ACTION_SIGNALS = ["ACCUMULATE", "HOLD", "WATCH", "TRIM"];

export function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function normSignal(v) {
  const s = String(v || "").trim().toUpperCase();
  return ACTION_SIGNALS.includes(s) ? s : "HOLD";
}

const money = (n) => Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function fallbackHeadline(snapshot = {}) {
  const sym = snapshot.symbol || "";
  const name = snapshot.name || sym;
  const chg = snapshot.change_pct;
  const price = snapshot.price;
  if (price == null) return `${name}: market snapshot`;
  if (chg == null) return `${name} at $${money(price)}`;
  const word = chg >= 0 ? "up" : "down";
  return `${name} ${word} ${Math.abs(chg).toFixed(1)}% to $${money(price)}`;
}

// raw: parsed model JSON. groundedSnapshot: the Python-computed snapshot (key_levels).
export function coerceDigest(raw, groundedSnapshot) {
  raw = raw && typeof raw === "object" ? raw : {};
  const action = raw.action && typeof raw.action === "object" ? raw.action : {};
  const bull = raw.bull_case && typeof raw.bull_case === "object" ? raw.bull_case : {};
  const bear = raw.bear_case && typeof raw.bear_case === "object" ? raw.bear_case : {};

  const drivers = (raw.drivers || [])
    .slice(0, 5)
    .map((d) => stripDashes(String(d).trim()))
    .filter(Boolean);

  const citations = [];
  for (const c of raw.citations || []) {
    const s = String(c).trim();
    if (s && !s.includes("http") && !citations.includes(s)) citations.push(s);
  }

  return {
    headline: stripDashes(String(raw.headline || "").trim()) || fallbackHeadline(groundedSnapshot),
    tldr: stripDashes(String(raw.tldr || "").trim()),
    action: {
      signal: normSignal(action.signal),
      reasoning: stripDashes(String(action.reasoning || "").trim()),
    },
    drivers,
    bull_case: {
      outlook: stripDashes(String(bull.outlook || "").trim()),
      level_to_watch: num(bull.level_to_watch),
    },
    bear_case: {
      outlook: stripDashes(String(bear.outlook || "").trim()),
      level_to_watch: num(bear.level_to_watch),
    },
    sentiment_quote: stripDashes(String(raw.sentiment_quote || "").trim()).slice(0, 200),
    snapshot: groundedSnapshot || {},
    citations,
  };
}

// Extract a single JSON object from a model response (handles code fences).
export function extractJson(text) {
  if (!text) throw new Error("empty response");
  let s = String(text).trim();
  if (s.startsWith("```")) {
    s = s.split("```")[1] || s;
    if (s.startsWith("json")) s = s.slice(4);
    s = s.trim();
  }
  try {
    return JSON.parse(s);
  } catch { /* fall through to brace slice */ }
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start !== -1 && end !== -1 && end > start) return JSON.parse(s.slice(start, end + 1));
  throw new Error("no JSON object found");
}
