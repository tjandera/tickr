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

Every number comes from live market data (yfinance). The brief is written by
**Gemini** (`GEMINI_API_KEY`); with no key or no credits the app still works,
using deterministic offline synthesis. With MongoDB configured, users get real
accounts (email verification + email-OTP 2FA) and their holdings/notes live on
their own user document; without it, data is saved locally under `web/data/`.

---

## Setup

```bash
# Python data tier
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

# Node server deps (also done automatically by server/start.sh)
cd server && npm install
```

> **macOS + iCloud:** if this repo lives under `~/Documents`, keep `.venv` and
> `server/node_modules` OUTSIDE iCloud (symlink them, and point `TICKR_PYTHON`
> at the external interpreter) — iCloud-synced imports can stall for minutes.

### AI synthesis (Gemini)

Set `GEMINI_API_KEY` in `.env` (from [aistudio.google.com](https://aistudio.google.com)).
Optional; without it every brief uses the offline synthesis path.

### Accounts (MongoDB, optional)

Set `MONGODB_URI` + `JWT_SECRET` (and ideally `ENCRYPTION_KEY` + `RESEND_API`
for real emails) to enable signup/login with email verification and OTP 2FA.
Check the connection anytime with `cd server && npm run db:check`.

---

## Running the web app

The server is **Node.js** (the Python connectors are the data tier, called via
`scripts/data_cli.py`):

```bash
./server/start.sh                 # Node server on port 3005 (installs deps if needed)
PORT=8080 ./server/start.sh       # different port

# Legacy Python/FastAPI server (kept as a fallback, same routes):
cd web && ../.venv/bin/uvicorn app:app --port 3005
```

Then open http://localhost:3005. Logged-out visitors land on `/welcome` (the
marketing page); the app itself lives at `/` behind the login when accounts are
enabled. Enter a symbol such as `AAPL`, `BTC-USD`, or `NVDA` and the digest
streams in as it is built: snapshot first, then research across every source,
then the brief, then the "full story" essay.

**If the first brief seems to hang for a minute:** that's `yfinance`'s first
network call on a flaky connection — the app itself starts instantly and the
stall, if any, only affects the first data fetch (it's cached afterward).

---

## Environment variables

Copy the template and fill in what you have:

```bash
cp .env.example .env
```

`.env.example` documents every variable. The short version:

| Variable | Required | Purpose |
|---|---|---|
| `GEMINI_API_KEY` | Optional | AI-written briefs/essays. Without it: offline synthesis. |
| `MONGODB_URI` | Optional | Enables accounts (verify + 2FA). Without it: local file store. |
| `JWT_SECRET` | With accounts | Signs session tokens. Long random string. |
| `ENCRYPTION_KEY` | Recommended | Encrypts note text at rest (falls back to `JWT_SECRET`). |
| `RESEND_API` / `EMAIL_FROM` | Optional | Real verification/OTP emails. Without: logged to console. |
| `APP_URL` | In production | Public https origin — enables Secure cookies + HSTS. |
| `TRUST_PROXY` | Behind a proxy | Hop count so rate limiting sees real client IPs. |
| `FINNHUB_API_KEY`, `YOUTUBE_API_KEY`, `BRAVE_API_KEY` | Optional | Richer research panels. |

The server reads `.env` from the project root on startup; shell-set variables
always win over the file.

---

## Security

What the server enforces (see `server/middleware/` + `server/lib/validate.js`):

- **Auth**: bcrypt-hashed passwords (cost 12), email verification before first
  login, email-OTP 2FA on every login, httpOnly `SameSite=Lax` session cookies
  (`Secure` on https), and hashed OTP/verification tokens — a database leak
  exposes no usable secrets. Rate limits on login/OTP/signup.
- **Data isolation**: with accounts enabled, `/api/portfolio`, `/api/notes`,
  `/api/home`, and `/api/generate` require a session; the shared local file
  store is only used in DB-less single-user mode. Note text is AES-256-GCM
  encrypted at rest.
- **Input validation**: one shared module (`lib/validate.js`) checks every
  ticker symbol, day window, URL (http/https only), and free-text length
  before anything reaches the Python tier, the DB, or a cache key.
- **Resource limits**: per-IP rate limits on all APIs (tightest on briefs), a
  concurrency cap + bounded queue on Python subprocesses, a hard cache-size
  cap, and a 100kb JSON body limit.
- **Headers**: CSP, `X-Frame-Options`, `nosniff`, `Referrer-Policy`,
  `Permissions-Policy`, and HSTS when `APP_URL` is https.
- **Output hygiene**: clients get generic error messages; real details go to
  the server log. The frontend escapes all API data (`esc()`) and scheme-checks
  every dynamic link (`safeUrl()`).

**Deploy checklist**: set a strong `JWT_SECRET` + `ENCRYPTION_KEY`, set
`APP_URL` to your https origin, set `TRUST_PROXY` if behind a proxy, and keep
`.env` out of git (already ignored).

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

The backend is a **Node.js server** (API + AI "thinking"); the **Python connectors
stay the data tier**, reached over a small subprocess CLI. The frontend is a single
unchanged `index.html`.

```
agnes-investor-desk/
├── server/                    Node.js server (the app)
│   ├── index.js               Express app: headers, limits, static, routers
│   ├── api/                   Routes: health, auth, search, ticker, portfolio,
│   │                          notes, demo, generate (SSE), home, markets
│   ├── middleware/            auth (sessions + accounts gate), rateLimit,
│   │                          securityHeaders (CSP etc.)
│   ├── lib/                   db (Mongo), tokens (JWT/OTP), encryption (notes),
│   │                          email (Resend), cache (TTL), validate, log
│   ├── thinking/              AI: geminiClient, prompts, synthesize, essay
│   ├── models/                User (accounts) + digest shape/coercion
│   ├── tools/pythonData.js    Subprocess bridge (+ concurrency cap)
│   ├── store/store.js         JSON persistence for DB-less local mode
│   └── start.sh               Launcher (PORT defaults to 3005)
├── web/
│   ├── app.py                 Legacy FastAPI server (fallback, no accounts)
│   ├── data/                  Local-mode holdings + notes (git-ignored)
│   └── static/                index.html (app) · welcome.html (marketing)
│                              · auth.html (login/signup/OTP)
└── scripts/
    ├── data_cli.py            Python data tier: JSON/NDJSON over the connectors
    ├── finance_digest.py      Research fan-out + builders + offline fallback
    └── lib/
        ├── store.py           JSON persistence (Python side)
        ├── yahoo_finance.py   Live prices, fundamentals, OHLCV history
        ├── finnhub_search.py · youtube_search.py
        ├── yahoo_news.py · google_news_search.py · web_search.py
        ├── reddit_search.py · stocktwits_search.py · sec_edgar_search.py
        └── chart_gen.py       PNG price chart
```

The Node server calls `scripts/data_cli.py` once per brief to gather the snapshot,
research, and deterministic panels (streaming progress as NDJSON), then runs the
Gemini synthesis + essay itself and assembles the digest. When the AI is
unavailable it falls back to the Python offline digest/essay, so the brief always
renders.

### How it works

1. Snapshot. `build_digest` pulls live market data from `yahoo_finance`: price,
   daily change, 52-week range, volume, and fundamentals.
2. Research. It fans out in parallel across seven sources — Yahoo Finance news,
   Google News, the web (Brave), Reddit, StockTwits, SEC EDGAR filings, and the
   Yahoo earnings calendar — then merges them into one ranked, de-duplicated feed
   badged by platform.
3. Synthesis. Gemini writes a structured JSON brief grounded in the verified
   numbers, then streams a plain-English "full story" essay. If the stock is in
   your portfolio, the brief is personalized to your position and gain/loss. With
   no key or credits, a deterministic offline synthesis produces the same shape.
   Real numbers always win over model output.
4. Decision panels. Your position P&L, a risk read (volatility, 52-week position,
   support/resistance), and income (yield, ex-dividend, your income) are computed
   from the live data and shown with the brief.

### Models

| Model | Role |
|---|---|
| `gemini-2.5-flash` (default; override with `GEMINI_MODEL`) | Brief synthesis + "full story" essay |

No image or video models — the dashboard is data and text only. With no key or
depleted credits, the deterministic offline path writes both instead.

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
