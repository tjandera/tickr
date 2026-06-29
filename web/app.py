#!/usr/bin/env python3
"""Tickr - web backend."""

import asyncio
import json
import os
import queue
import re
import sys
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

_env_path = Path(__file__).parent.parent / ".env"
if _env_path.exists():
    for _line in _env_path.read_text().splitlines():
        _line = _line.strip()
        if _line and not _line.startswith("#") and "=" in _line:
            _k, _v = _line.split("=", 1)
            os.environ.setdefault(_k.strip(), _v.strip())

sys.path.insert(0, str(Path(__file__).parent.parent / "scripts"))

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles

from finance_digest import build_digest
from lib import store
from lib.yahoo_finance import get_ticker_data, search_tickers

STATIC_DIR = Path(__file__).parent / "static"
DEMO_DIR = STATIC_DIR / "demo"

app = FastAPI(title="Tickr")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


@app.on_event("startup")
async def _warm_yfinance():
    """Warm yfinance's first import after the server binds so the first ticker
    request is snappy (importing at module load can stall the bind)."""
    def _go():
        try:
            from lib.yahoo_finance import _yfinance
            _yfinance()
        except Exception:
            pass
    threading.Thread(target=_go, daemon=True).start()


def _make_client():
    """Construct the synthesis backend (local LLM preferred, then Agnes)."""
    try:
        from finance_digest import make_client
        return make_client()
    except Exception:
        return None


@app.get("/")
def index():
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/api/health")
def health():
    """Report which synthesis backend is live so the UI can show it."""
    from lib.gemini_client import GeminiClient

    backend = os.environ.get("LLM_BACKEND", "").strip().lower()
    gemini_up = backend != "agnes" and GeminiClient.is_available()
    has_agnes = backend != "gemini" and bool(os.environ.get("AGNES_API_KEY"))

    if gemini_up:
        active, model = "gemini", os.environ.get("GEMINI_MODEL", "gemini-2.5-flash")
    elif has_agnes:
        active, model = "agnes", "agnes-2.0-flash"
    else:
        active, model = None, None

    web_key = next((k for k in ["BRAVE_API_KEY", "SERPER_API_KEY", "TAVILY_API_KEY"] if os.environ.get(k)), None)
    return {
        "live": bool(active),
        "backend": active,
        "model": model,
        "agnes": bool(active),  # back-compat: the masthead lamp reads this
        "web_search": web_key or False,
    }


@app.get("/api/ticker/{symbol}")
def ticker(symbol: str, days: int = 90):
    """Return price, fundamentals, and historical OHLCV for a ticker."""
    try:
        return get_ticker_data(symbol, days=days)
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.get("/api/ticker/{symbol}/chart")
def ticker_chart(symbol: str, days: int = 90):
    """Return a PNG price chart for embedding."""
    try:
        from lib.chart_gen import generate_price_chart
        data = get_ticker_data(symbol, days=days)
        png = generate_price_chart(data["history"], symbol, data.get("name", ""))
        return Response(content=png, media_type="image/png")
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.get("/api/search")
def ticker_search(q: str):
    """Search for ticker symbols."""
    return search_tickers(q)


# -- Digest stream (SSE) --------------------------------------------------------

_SSE_HEADERS = {"Cache-Control": "no-cache", "X-Accel-Buffering": "no"}
_KEEPALIVE_INTERVAL = 15  # seconds between SSE comment keepalives


@app.get("/api/generate")
async def generate_stream(
    symbol: str = "",
    days: int = 30,
    topic: str = None,
    quick: bool = False,
):
    """Stream a grounded finance digest build as Server-Sent Events."""
    import time as _time
    symbol = symbol.strip().upper()

    # Return an SSE error (not a 422) when no symbol is provided, so the
    # EventSource onerror handler does not fire with a confusing message.
    if not symbol:
        msg = (
            "Please enter a ticker symbol (e.g. AAPL or BTC-USD)."
            if topic
            else "Please enter a ticker symbol or topic to begin."
        )

        async def _err():
            yield "data: " + json.dumps({"type": "error", "message": msg, "fatal": True}) + "\n\n"
            yield "data: " + json.dumps({"type": "done"}) + "\n\n"

        return StreamingResponse(_err(), media_type="text/event-stream", headers=_SSE_HEADERS)

    event_queue: queue.Queue = queue.Queue()
    client = _make_client()

    def _cb(ev: dict):
        event_queue.put(ev)

    holding = store.get_holding(symbol)  # personalize the brief when it's a holding

    def _run():
        try:
            build_digest(symbol, days=days, topic=topic, quick=quick,
                         client=client, progress=_cb, holding=holding)
        except Exception as exc:
            event_queue.put({"type": "error", "message": str(exc), "fatal": True})
        finally:
            event_queue.put(None)

    threading.Thread(target=_run, daemon=True).start()

    async def _stream():
        yield "data: " + json.dumps({"type": "start", "symbol": symbol, "days": days, "topic": topic}) + "\n\n"
        last_ka = _time.monotonic()
        while True:
            try:
                event = event_queue.get_nowait()
            except queue.Empty:
                # Send a keepalive comment so proxies don't close an idle connection
                # during long synthesis calls (which can run up to ~150 s).
                if _time.monotonic() - last_ka >= _KEEPALIVE_INTERVAL:
                    yield ": keepalive\n\n"
                    last_ka = _time.monotonic()
                await asyncio.sleep(0.05)
                continue
            last_ka = _time.monotonic()
            if event is None:
                yield "data: " + json.dumps({"type": "done"}) + "\n\n"
                break
            yield "data: " + json.dumps(event) + "\n\n"

    return StreamingResponse(
        _stream(),
        media_type="text/event-stream",
        headers=_SSE_HEADERS,
    )


# -- Demo (cached assets, no live call) -----------------------------------------

def _safe_key(key: str) -> str:
    return re.sub(r"[^a-z0-9-]", "", (key or "").lower())


@app.get("/api/demo")
def demo_index():
    """List cached demo digests, or an empty list if none exist."""
    path = DEMO_DIR / "index.json"
    if not path.exists():
        return []
    try:
        return JSONResponse(content=json.loads(path.read_text()))
    except Exception:
        return []


@app.get("/api/demo/{key}")
def demo_get(key: str):
    """Return a single cached demo digest by key."""
    safe = _safe_key(key)
    path = DEMO_DIR / f"{safe}.json"
    if not safe or not path.exists():
        raise HTTPException(status_code=404, detail="demo not found")
    try:
        return JSONResponse(content=json.loads(path.read_text()))
    except Exception:
        raise HTTPException(status_code=404, detail="demo not found")


@app.post("/api/demo/build")
def demo_build(symbol: str, days: int = 30, key: str = None):
    """Run an in-app live build and cache it as a demo asset. Best effort."""
    safe = _safe_key(key) if key else _safe_key(symbol)
    client = _make_client()
    DEMO_DIR.mkdir(parents=True, exist_ok=True)

    try:
        import cache_demo
        if hasattr(cache_demo, "build_and_cache"):
            result = cache_demo.build_and_cache(symbol, days, key=safe, client=client, with_media=True)
            return {"status": "ok", "key": safe, "cached": True, "detail": result if isinstance(result, (str, dict)) else None}
    except Exception:
        pass

    try:
        digest = build_digest(symbol, days=days, client=client)
        (DEMO_DIR / f"{safe}.json").write_text(json.dumps(digest, ensure_ascii=False))
        return {"status": "ok", "key": safe, "cached": True,
                "live": bool(digest.get("meta", {}).get("live"))}
    except Exception as e:
        return {"status": "error", "key": safe, "cached": False, "message": str(e)}


# -- Portfolio (saved holdings) -------------------------------------------------

@app.get("/api/portfolio")
def portfolio_list():
    """Return saved holdings (raw, no live prices)."""
    return {"holdings": store.get_holdings()}


@app.post("/api/portfolio")
def portfolio_add(payload: dict):
    """Add or update a holding: {ticker, shares, cost_basis}."""
    ticker = (payload.get("ticker") or "").strip()
    if not ticker:
        raise HTTPException(status_code=400, detail="ticker is required")
    holding = store.upsert_holding(ticker, payload.get("shares"), payload.get("cost_basis"))
    return {"status": "ok", "holding": holding}


@app.delete("/api/portfolio/{ticker}")
def portfolio_remove(ticker: str):
    removed = store.remove_holding(ticker)
    return {"status": "ok", "removed": removed}


@app.get("/api/portfolio/overview")
def portfolio_overview():
    """Holdings enriched with live price, P&L, weight, and a quick signal."""
    from finance_digest import _quick_signal

    holds = store.get_holdings()

    def _enrich(h):
        row = {"ticker": h.get("ticker"), "shares": _num(h.get("shares")) or 0,
               "cost_basis": _num(h.get("cost_basis"))}
        try:
            d = get_ticker_data(h["ticker"], days=90)
        except Exception:
            row["error"] = True
            return row
        price = d.get("price")
        shares = row["shares"]
        cb = row["cost_basis"]
        row.update({
            "name": d.get("name"),
            "price": price,
            "change": d.get("change"),
            "change_pct": d.get("change_pct"),
            "value": (price or 0) * shares,
            "cost": (cb or 0) * shares if cb is not None else None,
            "day_change_value": (d.get("change") or 0) * shares,
            "signal": _quick_signal(price, d.get("52w_low"), d.get("52w_high"), d.get("change_pct")),
        })
        if cb is not None and cb > 0:
            row["gain"] = row["value"] - cb * shares
            row["gain_pct"] = (price - cb) / cb * 100 if price is not None else None
        else:
            row["gain"] = row["gain_pct"] = None
        return row

    rows = []
    if holds:
        with ThreadPoolExecutor(max_workers=min(8, len(holds))) as pool:
            rows = list(pool.map(_enrich, holds))

    total_value = sum((r.get("value") or 0) for r in rows)
    total_cost = sum((r.get("cost") or 0) for r in rows)
    for r in rows:
        r["weight"] = ((r.get("value") or 0) / total_value * 100) if total_value else 0
    total_gain = total_value - total_cost
    movers = sorted([r for r in rows if r.get("change_pct") is not None],
                    key=lambda r: abs(r["change_pct"]), reverse=True)[:3]
    return {
        "holdings": rows,
        "totals": {
            "value": total_value,
            "cost": total_cost,
            "gain": total_gain if total_cost else None,
            "gain_pct": (total_gain / total_cost * 100) if total_cost else None,
            "day_change_value": sum((r.get("day_change_value") or 0) for r in rows),
        },
        "movers": [{"ticker": r["ticker"], "change_pct": r["change_pct"]} for r in movers],
    }


def _num(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


# -- Notes (calendar journal) ---------------------------------------------------

@app.get("/api/notes")
def notes_list(date: str = None, ticker: str = None):
    """Saved notes, newest first, optionally filtered by date or ticker."""
    return {"notes": store.get_notes(date=date, ticker=ticker)}


@app.post("/api/notes")
def notes_add(payload: dict):
    """Save a note: {text, date?, ticker?, headline?, url?}."""
    text = (payload.get("text") or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="note text is required")
    note = store.add_note(
        text, date=payload.get("date"), ticker=payload.get("ticker"),
        headline=payload.get("headline"), url=payload.get("url"),
    )
    return {"status": "ok", "note": note}


@app.delete("/api/notes/{note_id}")
def notes_delete(note_id: str):
    return {"status": "ok", "removed": store.delete_note(note_id)}


if __name__ == "__main__":
    import argparse
    import uvicorn
    p = argparse.ArgumentParser()
    p.add_argument("--host", default="0.0.0.0")
    p.add_argument("--port", type=int, default=3005)
    a = p.parse_args()
    try:
        sys.stderr.write(f"Agnes Finance Research on http://localhost:{a.port}\n")
    except Exception:
        pass
    uvicorn.run(app, host=a.host, port=a.port, log_level="warning")
