#!/usr/bin/env python3
"""
Tickr data CLI — the Python data tier for the Node server.

The Node app (server/) owns the HTTP server, API, and AI "thinking". For raw
market data it shells out to this script, which wraps the proven Python
connectors in scripts/lib/* and the builders in finance_digest. Each command
prints a single JSON object on stdout (commands that need progress stream
NDJSON, one event per line, then a final {"type":"result", ...} line).

Usage:
    python data_cli.py ticker AAPL --days 90
    python data_cli.py search "apple"
    python data_cli.py quote ^GSPC
    python data_cli.py portfolio-overview
    python data_cli.py research AAPL --days 7      # streams NDJSON
    python data_cli.py offline AAPL --days 7

Imports are lazy so commands that do not need yfinance stay fast.
"""

import argparse
import json
import os
import sys
from pathlib import Path

_ROOT = Path(__file__).resolve().parent.parent      # repo root
_SCRIPTS = Path(__file__).resolve().parent           # scripts/
if str(_SCRIPTS) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS))


def _load_env() -> None:
    """Load repo-root .env into os.environ (same rules as web/app.py)."""
    env = _ROOT / ".env"
    if not env.exists():
        return
    for line in env.read_text().splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip())


def _emit(obj) -> None:
    """Print one compact JSON line and flush (for NDJSON streaming)."""
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def _out(obj) -> None:
    """Print the final JSON result."""
    sys.stdout.write(json.dumps(obj, ensure_ascii=False))
    sys.stdout.flush()


# ------------------------------------------------------------------ #
# Commands
# ------------------------------------------------------------------ #

def cmd_ticker(args) -> int:
    from lib.yahoo_finance import get_ticker_data
    try:
        _out(get_ticker_data(args.symbol, days=args.days))
        return 0
    except Exception as e:
        _out({"error": str(e)})
        return 1


def cmd_search(args) -> int:
    from lib.yahoo_finance import search_tickers
    _out(search_tickers(args.symbol))
    return 0


def cmd_quote(args) -> int:
    from lib.yahoo_finance import get_quick_quote
    _out(get_quick_quote(args.symbol))
    return 0


def cmd_portfolio_overview(args) -> int:
    """Holdings enriched with live price, P&L, weight, and a quick signal.

    Mirrors web/app.py::portfolio_overview, reusing get_ticker_data,
    _quick_signal, and the JSON store.
    """
    from concurrent.futures import ThreadPoolExecutor
    from lib.yahoo_finance import get_ticker_data
    from lib import store
    from finance_digest import _quick_signal

    def _num(v):
        try:
            return float(v)
        except (TypeError, ValueError):
            return None

    # Per-user holdings (from MongoDB) arrive as JSON on stdin; otherwise fall
    # back to the shared local file store (single-user / logged-out mode).
    if getattr(args, "holdings_stdin", False):
        raw = sys.stdin.read()
        try:
            holds = json.loads(raw) if raw.strip() else []
        except (ValueError, TypeError):
            holds = []
    else:
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
    _out({
        "holdings": rows,
        "totals": {
            "value": total_value, "cost": total_cost,
            "gain": total_gain if total_cost else None,
            "gain_pct": (total_gain / total_cost * 100) if total_cost else None,
            "day_change_value": sum((r.get("day_change_value") or 0) for r in rows),
        },
        "movers": [{"ticker": r["ticker"], "change_pct": r["change_pct"]} for r in movers],
    })
    return 0


def cmd_research(args) -> int:
    """Gather research + deterministic panels for a brief, streaming progress.

    Streams NDJSON search_start/search_done events (so the live-sources UI keeps
    working), then a final {"type":"result", "data": {...}} line with the
    research dict, snapshot, position, and every deterministic panel Node needs
    to assemble the digest.
    """
    from lib.yahoo_finance import get_ticker_data
    from lib import store
    import finance_digest as fd

    sym = (args.symbol or "").upper().strip()
    try:
        real = get_ticker_data(sym, days=max(args.days, 90))
    except Exception as e:
        _emit({"type": "error", "message": f"Could not load {sym}: {e}", "fatal": True})
        return 1

    history = real.get("history", [])
    snapshot_payload = {**{k: v for k, v in real.items() if k != "history"}, "history": history}
    _emit({"type": "snapshot", "data": snapshot_payload})

    research = fd.run_research(real, args.topic, args.days, args.quick, progress=_emit)

    holding = store.get_holding(sym)
    position = fd._build_position(real, holding) if holding else None

    panels = {
        "feed": fd._build_feed(research),
        "watch_this_week": fd._watch_list(research.get("events", {}), real),
        "risk": fd._build_risk(real, history),
        "income": fd._build_income(real, research.get("events", {}), position),
        "finnhub": research.get("finnhub") or {},
        "market": research.get("market"),
        "video": research.get("youtube"),
        "peers": fd._peer_quotes((research.get("finnhub") or {}).get("peers") or []),
        "next_earnings": fd._earnings_countdown(research.get("events", {})),
        "news": research.get("news", []),
    }

    # Deterministic offline fallback (used when the Node AI path is unavailable).
    offline_digest = fd.offline_synthesis(real, research)
    if position:
        offline_digest["position"] = position
    fd._clean_digest_text(offline_digest)
    offline_essay = fd._strip_dashes(fd._offline_essay(real, offline_digest, research))

    _emit({"type": "result", "data": {
        "real": real,
        "snapshot": snapshot_payload,
        "grounded_snapshot": fd._grounded_snapshot(None, real),
        "research": research,
        "position": position,
        "panels": panels,
        "window": fd._build_window_report(args.days, research, history),
        "asset_type": real.get("asset_type", "EQUITY"),
        "offline_digest": offline_digest,
        "offline_essay": offline_essay,
    }})
    return 0


def cmd_offline(args) -> int:
    """Deterministic offline digest + essay (the no-AI fallback path)."""
    from lib.yahoo_finance import get_ticker_data
    from lib import store
    import finance_digest as fd

    sym = (args.symbol or "").upper().strip()
    real = get_ticker_data(sym, days=max(args.days, 90))
    research = fd.run_research(real, args.topic, args.days, args.quick, progress=None)
    holding = store.get_holding(sym)
    position = fd._build_position(real, holding) if holding else None

    digest = fd.offline_synthesis(real, research)
    if position:
        digest["position"] = position
    fd._clean_digest_text(digest)
    essay = fd._strip_dashes(fd._offline_essay(real, digest, research))
    _out({"digest": digest, "essay": essay})
    return 0


def main() -> int:
    _load_env()
    p = argparse.ArgumentParser(prog="data_cli")
    sub = p.add_subparsers(dest="cmd", required=True)

    def add(name, fn, needs_symbol=True):
        sp = sub.add_parser(name)
        if needs_symbol:
            sp.add_argument("symbol")
        sp.add_argument("--days", type=int, default=90)
        sp.add_argument("--topic", default=None)
        sp.add_argument("--quick", action="store_true")
        # When set, portfolio-overview reads the holdings list as JSON from stdin
        # (used for per-user data in MongoDB) instead of the local file store.
        sp.add_argument("--holdings-stdin", action="store_true")
        sp.set_defaults(func=fn)
        return sp

    add("ticker", cmd_ticker)
    add("search", cmd_search)
    add("quote", cmd_quote)
    add("research", cmd_research)
    add("offline", cmd_offline)
    add("portfolio-overview", cmd_portfolio_overview, needs_symbol=False)

    args = p.parse_args()
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
