# Tickr

A personal dashboard for everyday investors. Save the stocks you hold,
then get a plain-English read on each one — what's happening, what it means for
your position, and the latest news from every source — all in one place.

- **My Portfolio** — save your holdings (shares + buy price) and see live prices,
  profit/loss in $ and %, weight, and an at-a-glance signal for each, plus
  portfolio totals and today's movers.
- **Holding-aware briefs** — open any stock for a grounded brief: a price
  snapshot, **your position** P&L, a **risk read** (volatility, 52-week position,
  key levels), **income** (dividend yield, ex-dividend, your income), a
  plain-English "what to do for you," a streamed **"full story"** essay, and a
  unified **news feed badged by source** (Yahoo, Google News, Web, Reddit,
  StockTwits, SEC EDGAR). Pick the news window: Today / 7 / 15 / 30 days.
- **Notes** — jot a note on any headline; browse them by day in a calendar journal.

Every number comes from live market data (yfinance). The brief is written by a
**local LLM** (Ollama + Qwen3 14B by default) — no API key, runs entirely on your
machine. With no model reachable it still works using deterministic offline
synthesis. Your holdings and notes are saved locally under `web/data/`.

---

## Setup

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

### Local LLM (default synthesis backend)

The brief is written by a **local LLM** served by [Ollama](https://ollama.com) —
no API key, runs fully on your machine. Install Ollama, then start it and pull
the model:

```bash
ollama serve              # start the local server (leave running)
ollama pull qwen3:14b     # ~9 GB; the default synthesis model
```

The app auto-detects the running model. Until a model is pulled, the app still
works using the deterministic offline synthesis. To use a different model, set
`LOCAL_MODEL` in `.env` (e.g. `gpt-oss:20b`, `llama3.1:8b`).

**Recommended models by machine (Apple Silicon, unified memory):**

| RAM | Model | Pull |
|---|---|---|
| 16 GB | `llama3.1:8b` or `qwen3:8b` | `ollama pull qwen3:8b` |
| 24 GB | `qwen3:14b` (default) | `ollama pull qwen3:14b` |
| 32 GB+ | `gpt-oss:20b` or `qwen3:30b-a3b` | `ollama pull gpt-oss:20b` |

---

## Running the web app

The easiest way — one command that starts Ollama (tuned for speed), makes sure
the model is pulled and **warm**, then launches the app. Safe to re-run; it skips
anything already running (no more "address already in use"):

```bash
./run.sh
```

Override the model or port with env vars: `LOCAL_MODEL=qwen3:8b PORT=8080 ./run.sh`.

Or start it manually:

```bash
python web/app.py        # add --port 8080 if 3005 is taken
```

Then open http://localhost:3005 in your browser. Enter a symbol such as `AAPL`,
`BTC-USD`, or `NVDA` and the digest streams in as it is built: the price snapshot
first, then research across every source, then the synthesized brief, then a
streamed "The full story" essay.

**Speed:** the app keeps the model resident (`OLLAMA_KEEP_ALIVE`) so repeat briefs
don't pay a model-reload stall. The first brief after launch is warmed by `run.sh`.

**If the first brief seems to hang for a minute:** that's `yfinance`'s first
network call on a flaky connection — the app itself starts instantly and the
stall, if any, only affects the first data fetch (it's cached afterward). Just
wait or retry; a stable network makes it instant.

---

## Environment variables

Copy the template and fill in what you have:

```bash
cp .env.example .env
```

| Variable | Required | Purpose |
|---|---|---|
| `LLM_BACKEND` | Optional | `ollama` (default) or `agnes`. Forces a specific synthesis backend. |
| `OLLAMA_BASE_URL` | Optional | Local server URL. Defaults to `http://localhost:11434/v1`. |
| `LOCAL_MODEL` | Optional | Local model name. Defaults to `qwen3:14b`. |
| `AGNES_API_KEY` | Optional | Cloud fallback for synthesis. Only used if `LLM_BACKEND=agnes` or no local model is reachable. |
| `BRAVE_API_KEY` | Optional | Improves web and Reddit results. Falls back to keyless sources when empty. |

The web app reads `.env` from the project root on startup. Values are injected
only into the running app process. With no backend reachable at all, the app
still serves grounded digests via deterministic offline synthesis.

---

## Demo mode

Three digests ship pre built and cached so the product is instant with no live
API call:

- `BTC-USD` over 30 days
- `AAPL` over 90 days
- `ETH-USD` over 30 days

They live in `web/static/demo/` as `<key>.json` (the full digest) and
`<key>.png` (the locally drawn poster), with `index.json` listing them. The UI
reads `index.json` and shows one demo chip per seed. Clicking a chip loads the
cached digest straight from disk through `/api/demo/{key}`, so it renders
immediately and uses no quota.

These seeds are grounded real data digests built offline. Rebuild them anytime:

```bash
.venv/bin/python scripts/cache_demo.py
```

That writes the three JSON digests, the three posters, and `index.json`. It runs
fully offline with no key, which is expected.

When a key is present in the running app, the live build route can regenerate a
seed with real Agnes media (hero image plus recap video) and cache the result in
the same `web/static/demo/` folder.

---

## Architecture

```
agnes-investor-desk/
├── requirements.txt
├── run.sh                     One-command launcher (Ollama + app)
├── web/
│   ├── app.py                 FastAPI: SSE briefs, portfolio + notes APIs
│   ├── data/                  Your saved holdings + notes (git-ignored)
│   └── static/
│       └── index.html         Single-page UI: portfolio, briefs, notes
└── scripts/
    ├── finance_digest.py      Orchestrator: build_digest end to end
    └── lib/
        ├── local_client.py    Local LLM client (Ollama, OpenAI-compatible)
        ├── store.py           JSON persistence for holdings + notes
        ├── yahoo_finance.py   Live prices, fundamentals, OHLCV history
        ├── yahoo_news.py · google_news_search.py · web_search.py
        ├── reddit_search.py · stocktwits_search.py · sec_edgar_search.py
        └── chart_gen.py       PNG price chart
```

### How it works

1. Snapshot. `build_digest` pulls live market data from `yahoo_finance`: price,
   daily change, 52-week range, volume, and fundamentals.
2. Research. It fans out in parallel across seven sources — Yahoo Finance news,
   Google News, the web (Brave), Reddit, StockTwits, SEC EDGAR filings, and the
   Yahoo earnings calendar — then merges them into one ranked, de-duplicated feed
   badged by platform.
3. Synthesis. A local LLM writes a structured JSON brief grounded in the verified
   numbers, then streams a plain-English "full story" essay. If the stock is in
   your portfolio, the brief is personalized to your position and gain/loss. With
   no model reachable, a deterministic offline synthesis produces the same shape.
   Real numbers always win over model output.
4. Decision panels. Your position P&L, a risk read (volatility, 52-week position,
   support/resistance), and income (yield, ex-dividend, your income) are computed
   from the live data and shown with the brief.

### Models

| Model | Role |
|---|---|
| `qwen3:14b` (local, default) | Brief synthesis + "full story" essay |

No image or video models — the dashboard is data and text only. See the Local LLM
section above for model alternatives by RAM.

### Connectors (wired into the brief)

| Source | What it adds | Auth |
|---|---|---|
| Yahoo Finance | Headlines + earnings/ex-div calendar | None |
| Google News | Broad headline coverage (RSS) | None |
| Web | Brave search results | `BRAVE_API_KEY` optional, keyless fallback |
| Reddit | Community threads | None, better with `BRAVE_API_KEY` |
| StockTwits | Retail sentiment (bullish/bearish) | None |
| SEC EDGAR | Official filings (8-K, 10-Q, Form 4) | None |

Each item in the brief's "Latest across sources" feed is badged with its
platform, and a sources strip shows how many hits each platform returned.
(`polymarket_search.py` and `hackernews_search.py` exist but are not part of the
stock digest.)
