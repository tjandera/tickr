// Live synthesis — build the grounded facts, call Gemini, return a coerced
// digest. Ported from finance_digest.live_synthesis (+ _trim_research_for_model).
// On any failure the caller falls back to the Python offline digest.
import { chat } from "./geminiClient.js";
import { SYNTHESIS_PROMPT } from "./prompts.js";
import { coerceDigest, extractJson } from "../models/digest.js";

const normTitle = (t) => String(t || "").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 60);

function slimResearch(research, quick) {
  const newsLimit = quick ? 5 : 10;
  const webLimit = quick ? 3 : 6;
  const redditLimit = quick ? 3 : 5;

  const slimNews = (items) =>
    (items || []).filter((n) => n.title).slice(0, newsLimit).map((n) => {
      const e = { title: String(n.title).slice(0, 160), age: n.age || "" };
      if (n.summary) e.summary = String(n.summary).slice(0, 220);
      if (n.publisher) e.publisher = n.publisher;
      return e;
    });

  // Merge Yahoo + Google news, de-duped by normalized title (mirrors Python).
  const merged = [...(research.news || [])];
  const seen = new Set(merged.map((n) => normTitle(n.title)));
  for (const g of research.google_news || []) {
    if (!seen.has(normTitle(g.title))) { merged.push(g); seen.add(normTitle(g.title)); }
  }

  const st = research.stocktwits || [];
  const sentiment = st.length ? stSentiment(st) : null;

  const finnhub = research.finnhub || {};
  return {
    news: slimNews(merged),
    web: (research.web || []).filter((w) => w.title).slice(0, webLimit).map((w) => ({
      title: String(w.title || "").slice(0, 140),
      description: String(w.description || "").slice(0, 240),
      site_name: w.site_name || "",
    })),
    reddit: (research.reddit || []).filter((r) => r.title).slice(0, redditLimit).map((r) => ({
      title: String(r.title || "").slice(0, 140),
      subreddit: r.subreddit || "",
      upvotes: r.upvotes || 0,
    })),
    stocktwits_sentiment: sentiment,
    sec_filings: (research.sec || []).slice(0, 4).map((f) => f.title).filter(Boolean),
    analyst_consensus: finnhub.analyst,
    price_target: finnhub.price_target,
    earnings_history: finnhub.earnings,
    insider_sentiment: finnhub.insider,
    financial_ratios: finnhub.ratios,
  };
}

// Lightweight StockTwits tally (bullish/bearish) to match the Python summary.
function stSentiment(items) {
  let bull = 0, bear = 0;
  for (const m of items) {
    const s = String(m.sentiment || "").toLowerCase();
    if (s === "bullish") bull++;
    else if (s === "bearish") bear++;
  }
  const total = bull + bear;
  return { bullish: bull, bearish: bear, total };
}

function buildFacts(real, research, groundedSnapshot, position) {
  const kl = groundedSnapshot?.key_levels || {};
  const finnhub = research.finnhub || {};
  const facts = {
    symbol: real.symbol,
    name: real.name,
    asset_type: real.asset_type,
    price: real.price,
    change_pct: real.change_pct,
    week52_high: real["52w_high"],
    week52_low: real["52w_low"],
    support: kl.support,
    resistance: kl.resistance,
    volume: real.volume,
    avg_volume: real.avg_volume,
    market_cap: real.market_cap,
    pe_ratio: real.pe_ratio,
    forward_pe: real.forward_pe,
    sector: real.sector,
    recent_closes: (real.history || []).slice(-30).map((h) => h.close),
  };
  if (position) {
    facts.your_position = {
      shares: position.shares,
      avg_buy_price: position.cost_basis,
      current_value: position.value,
      gain_pct: position.gain_pct,
    };
  }
  if (finnhub.analyst) facts.analyst_consensus = finnhub.analyst;
  if (finnhub.price_target) facts.analyst_price_target = finnhub.price_target;
  if (finnhub.earnings) {
    facts.earnings_beat_rate_pct = finnhub.earnings.beat_rate;
    facts.earnings_quarters = finnhub.earnings.quarters;
  }
  if (finnhub.insider) facts.insider_activity = finnhub.insider;
  if (finnhub.ratios) facts.financial_ratios = finnhub.ratios;
  if (finnhub.rec_trend) facts.analyst_trend = finnhub.rec_trend.direction;
  if (research.market) facts.market_context = research.market;
  if (finnhub.peers) facts.peer_tickers = finnhub.peers;
  if (research.next_earnings) facts.next_earnings = research.next_earnings;
  return facts;
}

export async function synthesize({ real, research, groundedSnapshot, position, days, quick }) {
  const facts = buildFacts(real, research, groundedSnapshot, position);
  const slim = slimResearch(research, quick);
  const posNote = position
    ? "\nThe reader OWNS this stock (see your_position). Make the action and reasoning speak to their actual position and gain/loss.\n"
    : "\n";
  const today = new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });

  const user =
    `Asset: ${real.name} (${real.symbol})\n` +
    `As of ${today}, ${days}-day window.\n\n` +
    `VERIFIED MARKET NUMBERS (use these exactly, do not change them):\n` +
    `${JSON.stringify(facts)}\n\n` +
    `RESEARCH DATA:\n${JSON.stringify(slim)}\n` +
    `${posNote}\n` +
    `Write the JSON digest now. Plain English. Short sentences. Real numbers only.`;

  const messages = [
    { role: "system", content: SYNTHESIS_PROMPT },
    { role: "user", content: user },
  ];

  // Two attempts with a corrective nudge on bad JSON (mirrors live_synthesis).
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    const content = await chat(messages, { maxTokens: 2560, temperature: 0.4, timeoutMs: 90000, reasoningEffort: "none" });
    try {
      return coerceDigest(extractJson(content), groundedSnapshot);
    } catch (e) {
      lastErr = e;
      messages.push({
        role: "user",
        content: "That was not valid. Return ONLY a single JSON object matching the schema, no prose and no code fences.",
      });
    }
  }
  throw new Error(`synthesis returned unparseable JSON: ${lastErr?.message || lastErr}`);
}
