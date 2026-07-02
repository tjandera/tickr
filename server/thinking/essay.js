// Live essay — build facts and stream the narrative from Gemini. Ported from
// finance_digest.stream_essay. Yields raw text pieces; the caller accumulates,
// strips dashes, and emits essay_* frames. Falls back to the Python offline essay.
import { chatStream } from "./geminiClient.js";
import { ESSAY_PROMPT } from "./prompts.js";

function newsItems(items, limit) {
  return (items || []).filter((n) => n.title).slice(0, limit).map((n) => {
    const e = { title: n.title };
    if (n.summary) e.summary = n.summary;
    if (n.age) e.age = n.age;
    if (n.publisher) e.publisher = n.publisher;
    return e;
  });
}

function webItems(items, limit) {
  return (items || []).filter((w) => w.title).slice(0, limit).map((w) => {
    const e = { title: w.title };
    if (w.description) e.snippet = w.description;
    return e;
  });
}

function stSentiment(items) {
  let bull = 0, bear = 0;
  for (const m of items || []) {
    const s = String(m.sentiment || "").toLowerCase();
    if (s === "bullish") bull++;
    else if (s === "bearish") bear++;
  }
  const total = bull + bear;
  return total ? { bullish: bull, bearish: bear, total } : null;
}

export async function* streamEssay({ real, digest, research, position, days }) {
  const finnhub = research.finnhub || {};
  const facts = {
    name: real.name,
    symbol: real.symbol,
    price: real.price,
    change_pct: real.change_pct,
    week52_high: real["52w_high"],
    week52_low: real["52w_low"],
    sector: real.sector,
    market_cap: real.market_cap,
    tldr: digest.tldr,
    signal: digest.action?.signal,
    signal_reason: digest.action?.reasoning,
    drivers: digest.drivers,
    bull_case: digest.bull_case?.outlook,
    bear_case: digest.bear_case?.outlook,
    yahoo_news: newsItems(research.news, 12),
    google_news: newsItems(research.google_news, 10),
    web_search_results: webItems(research.web, 8),
    sec_filings: (research.sec || []).filter((f) => f.title).slice(0, 6)
      .map((f) => ({ title: f.title, form: f.form, age: f.age })),
    retail_sentiment: stSentiment(research.stocktwits),
    analyst_consensus: finnhub.analyst,
    analyst_price_target: finnhub.price_target,
    earnings_history: finnhub.earnings,
    insider_activity: finnhub.insider,
    financial_ratios: finnhub.ratios,
    your_position: position
      ? { shares: position.shares, avg_buy_price: position.cost_basis, current_value: position.value, gain_pct: position.gain_pct }
      : null,
    market_context: research.market,
    analyst_trend: finnhub.rec_trend?.direction,
    peer_tickers: finnhub.peers,
    next_earnings: research.next_earnings,
  };

  const windowLabel = days === 1 ? "today only (past 24 hours)" : `the past ${days} days`;
  const posLine = position
    ? "The reader OWNS this stock (see your_position). Speak directly to what their gain or loss and the news mean for them specifically. "
    : "";
  const today = new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });

  const user =
    `Write the full essay for ${real.name} (${real.symbol}).\n` +
    `Date: ${today}. Research window: ${windowLabel}.\n` +
    `${posLine}\n\n` +
    `Use ALL of the following research to write a deep, detailed essay. ` +
    `The yahoo_news, google_news, and web_search_results fields contain real ` +
    `headlines and summaries. Cite specific articles and their key facts.\n\n` +
    `VERIFIED DATA:\n${JSON.stringify(facts, null, 2)}`;

  const messages = [
    { role: "system", content: ESSAY_PROMPT },
    { role: "user", content: user },
  ];

  yield* chatStream(messages, { maxTokens: 2500, temperature: 0.4, timeoutMs: 120000 });
}
