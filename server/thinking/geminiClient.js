// Gemini client — Google's OpenAI-compatible endpoint. Ported from
// scripts/lib/gemini_client.py. Streaming via Node's global fetch.
const BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai";
const THINK_BLOCK = /<think>.*?<\/think>/gis;

function model() {
  return process.env.GEMINI_MODEL || "gemini-2.5-flash";
}

export function isAvailable() {
  return Boolean((process.env.GEMINI_API_KEY || "").trim());
}

export function modelLabel() {
  return isAvailable() ? `gemini · ${model()}` : "offline";
}

function headers() {
  return {
    Authorization: `Bearer ${(process.env.GEMINI_API_KEY || "").trim()}`,
    "Content-Type": "application/json",
  };
}

// An HTTP error carrying status + parsed API message, so callers can tell a
// depleted-credits 429 from a transient failure (mirrors the Python handling).
export class GeminiHttpError extends Error {
  constructor(status, apiMessage, body) {
    super(`Gemini HTTP ${status}: ${apiMessage || body || ""}`.slice(0, 300));
    this.name = "GeminiHttpError";
    this.status = status;
    this.apiMessage = apiMessage || "";
  }
}

async function raiseForStatus(resp) {
  if (resp.ok) return;
  let body = "";
  let apiMessage = "";
  try {
    body = await resp.text();
    const parsed = JSON.parse(body);
    apiMessage = Array.isArray(parsed)
      ? parsed[0]?.error?.message
      : parsed?.error?.message || "";
  } catch { /* body not JSON */ }
  throw new GeminiHttpError(resp.status, apiMessage, body);
}

// Strip <think>…</think>, including an unclosed block left by a truncated response.
function stripThinking(content) {
  let s = (content || "").replace(THINK_BLOCK, "");
  const open = s.lastIndexOf("<think>");
  if (open !== -1 && !s.slice(open).includes("</think>")) s = s.slice(0, open);
  return s.trim();
}

// Non-streaming completion → full text (used for synthesis JSON). reasoningEffort
// "none" disables Gemini 2.5 thinking so the whole token budget goes to the JSON.
export async function chat(messages, { maxTokens = 8192, temperature = 0.7, timeoutMs = 120000, reasoningEffort = null } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const payload = { model: model(), messages, max_tokens: maxTokens, temperature };
    if (reasoningEffort) payload.reasoning_effort = reasoningEffort;
    const resp = await fetch(`${BASE_URL}/chat/completions`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
    await raiseForStatus(resp);
    const data = await resp.json();
    return stripThinking(data?.choices?.[0]?.message?.content || "");
  } finally {
    clearTimeout(timer);
  }
}

// Streaming completion → async generator of content pieces (used for the essay).
export async function* chatStream(messages, { maxTokens = 1200, temperature = 0.4, timeoutMs = 120000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch(`${BASE_URL}/chat/completions`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ model: model(), messages, max_tokens: maxTokens, temperature, stream: true }),
      signal: ctrl.signal,
    });
    await raiseForStatus(resp);

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) !== -1) {
        let line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        line = line.slice(5).trim();
        if (line === "[DONE]") return;
        try {
          const piece = JSON.parse(line)?.choices?.[0]?.delta?.content;
          if (piece) yield piece;
        } catch { /* skip partial/non-JSON lines */ }
      }
    }
  } finally {
    clearTimeout(timer);
  }
}
