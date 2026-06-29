"""
Yahoo Finance connector - free, no API key required.
Provides live prices, fundamentals, and historical OHLCV data.
"""

import io
import logging
from contextlib import contextmanager, redirect_stderr, redirect_stdout
from datetime import datetime, timedelta
from typing import Dict, Any, List, Optional

# yfinance logs delisted/404 warnings on its own logger (e.g. "possibly
# delisted; no price data found"). Silence them so a missing ticker stays quiet
# on stdout/stderr. Level filtering only drops log records; it never affects
# raised exceptions. (Naming the logger does not require yfinance to be imported.)
logging.getLogger("yfinance").setLevel(logging.CRITICAL)

_yf = None


def _yfinance():
    """Import yfinance lazily and cache it.

    yfinance's first import is heavy and, on a flaky network, can stall for
    minutes. Importing it on first use (rather than at module load) keeps web-app
    startup instant; any stall then surfaces as a slow first data fetch behind the
    normal progress UI instead of a server that never finishes booting.
    """
    global _yf
    if _yf is None:
        import yfinance as yf
        _yf = yf
    return _yf


@contextmanager
def _silence_streams():
    """Redirect any stray stdout/stderr (e.g. yfinance's printed HTTP errors)
    to a throwaway buffer.

    Only printed text is swallowed; exceptions raised inside the block
    propagate normally, so real failures are never hidden.
    """
    sink = io.StringIO()
    with redirect_stdout(sink), redirect_stderr(sink):
        yield


def get_ticker_data(symbol: str, days: int = 90) -> Dict[str, Any]:
    """
    Fetch comprehensive data for a stock, ETF, or crypto ticker.

    Returns price, fundamentals, historical data, and analyst info.
    """
    if not symbol or not symbol.strip():
        raise ValueError("ticker symbol is required")

    t = _yfinance().Ticker(symbol.upper())
    period = f"{min(days, 365)}d"

    with _silence_streams():
        try:
            info = t.info
        except Exception:
            info = {}
        try:
            hist = t.history(period=period)
        except Exception:
            hist = None

    history = []
    if hist is not None and not hist.empty:
        for date, row in hist.iterrows():
            history.append({
                "date":   date.strftime("%Y-%m-%d"),
                "open":   round(float(row.get("Open", 0)),  2),
                "high":   round(float(row.get("High", 0)),  2),
                "low":    round(float(row.get("Low", 0)),   2),
                "close":  round(float(row.get("Close", 0)), 2),
                "volume": int(row.get("Volume", 0)),
            })

    def _safe(key, default=None):
        v = info.get(key, default)
        if v is None or v != v:  # catches NaN
            return default
        return v

    price     = _safe("currentPrice") or _safe("regularMarketPrice") or _safe("navPrice")
    prev_close= _safe("regularMarketPreviousClose") or _safe("previousClose")
    change    = round(price - prev_close, 2) if price and prev_close else None
    change_pct= round((change / prev_close) * 100, 2) if change and prev_close else None

    return {
        "source":         "yahoo_finance",
        "symbol":         symbol.upper(),
        "name":           _safe("longName") or _safe("shortName", symbol.upper()),
        "price":          price,
        "change":         change,
        "change_pct":     change_pct,
        "prev_close":     prev_close,
        "open":           _safe("regularMarketOpen"),
        "day_high":       _safe("dayHigh") or _safe("regularMarketDayHigh"),
        "day_low":        _safe("dayLow")  or _safe("regularMarketDayLow"),
        "volume":         _safe("volume")  or _safe("regularMarketVolume"),
        "avg_volume":     _safe("averageVolume"),
        "market_cap":     _safe("marketCap"),
        "pe_ratio":       _safe("trailingPE"),
        "forward_pe":     _safe("forwardPE"),
        "eps":            _safe("trailingEps"),
        "dividend_yield": _safe("dividendYield"),
        "52w_high":       _safe("fiftyTwoWeekHigh"),
        "52w_low":        _safe("fiftyTwoWeekLow"),
        "beta":           _safe("beta"),
        "sector":         _safe("sector"),
        "industry":       _safe("industry"),
        "currency":       _safe("currency", "USD"),
        "exchange":       _safe("exchange"),
        "asset_type":     _safe("quoteType", "EQUITY"),
        "summary":        (_safe("longBusinessSummary") or "")[:600],
        "history":        history,
        "analyst_rating": _safe("recommendationKey"),
        "target_price":   _safe("targetMeanPrice"),
    }


def get_quick_quote(symbol: str) -> Optional[Dict[str, Any]]:
    """Lightweight price + day-change for a symbol, no history or full info.

    Used for index/sector/peer context where only the day move matters. Uses
    yfinance fast_info, which is much cheaper than the full .info call.
    """
    if not symbol or not symbol.strip():
        return None
    try:
        t = _yfinance().Ticker(symbol.upper())
        with _silence_streams():
            fi = t.fast_info

            def _g(*names):
                for n in names:
                    v = None
                    try:
                        v = fi[n]
                    except Exception:
                        v = getattr(fi, n, None)
                    if v:
                        return float(v)
                return None

            price = _g("lastPrice", "last_price")
            prev = _g("previousClose", "previous_close")
    except Exception:
        return None
    if not price or not prev:
        return None
    change = price - prev
    return {
        "symbol": symbol.upper(),
        "price": round(price, 2),
        "change": round(change, 2),
        "change_pct": round(change / prev * 100, 2),
    }


def search_tickers(query: str, limit: int = 6) -> List[Dict[str, Any]]:
    """Search for ticker symbols matching a company name or keyword."""
    try:
        import requests
        resp = requests.get(
            "https://query2.finance.yahoo.com/v1/finance/search",
            params={"q": query, "quotesCount": limit, "newsCount": 0},
            headers={"User-Agent": "Mozilla/5.0"},
            timeout=8,
        )
        resp.raise_for_status()
        quotes = resp.json().get("quotes", [])
        return [
            {
                "symbol":   q.get("symbol", ""),
                "name":     q.get("longname") or q.get("shortname", ""),
                "exchange": q.get("exchange", ""),
                "type":     q.get("quoteType", ""),
            }
            for q in quotes
            if q.get("symbol")
        ]
    except Exception as e:
        return [{"error": str(e)}]


def fmt_large(n: Optional[float]) -> str:
    """Format large numbers: 2800000000 → $2.80B"""
    if n is None:
        return "N/A"
    if abs(n) >= 1e12:
        return f"${n/1e12:.2f}T"
    if abs(n) >= 1e9:
        return f"${n/1e9:.2f}B"
    if abs(n) >= 1e6:
        return f"${n/1e6:.2f}M"
    return f"${n:,.0f}"
