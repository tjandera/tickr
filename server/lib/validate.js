// Input validation shared by the API routes. Every value that reaches the
// Python data tier, the database, or a cache key passes through one of these,
// so limits live in one place instead of being re-invented per route.

// Ticker symbols: Yahoo-style — letters/digits plus . - ^ = (BRK.B, BTC-USD,
// ^GSPC, EURUSD=X). Anything else (or anything over 15 chars) is rejected so
// junk can't reach the subprocess or mint unbounded cache keys.
const SYMBOL_RE = /^[A-Z0-9.\-^=]{1,15}$/;

// Normalize + validate a ticker symbol. Returns the clean symbol or null.
export function cleanSymbol(raw) {
  const s = String(raw || "").trim().toUpperCase();
  return SYMBOL_RE.test(s) ? s : null;
}

// Parse an integer query param and clamp it into [min, max].
export function clampInt(raw, { min, max, fallback }) {
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

// Finite number within [min, max], else null. For user-entered amounts
// (shares, cost basis) where negatives / Infinity / 1e300 make no sense.
export function cleanNumber(raw, { min, max }) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min || n > max) return null;
  return n;
}

// Trim a free-text field and cap its length. Empty → null.
export function capString(raw, max) {
  const s = String(raw == null ? "" : raw).trim();
  if (!s) return null;
  return s.length > max ? s.slice(0, max) : s;
}

// Accept only absolute http(s) URLs (capped length); everything else → null.
// This is what keeps a stored "javascript:..." URL from ever reaching an href.
export function cleanUrl(raw, maxLen = 2048) {
  const s = String(raw || "").trim();
  if (!s || s.length > maxLen) return null;
  try {
    const u = new URL(s);
    return u.protocol === "http:" || u.protocol === "https:" ? s : null;
  } catch {
    return null;
  }
}

// Calendar dates as the app stores them (YYYY-MM-DD), else null.
export function cleanDate(raw) {
  const s = String(raw || "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}
