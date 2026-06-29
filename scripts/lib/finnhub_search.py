"""
Finnhub analytics connector.

Pulls analyst consensus, price targets, earnings beat/miss history,
insider sentiment, and key financial ratios for a stock ticker.

Free tier: 60 req/min — generous for a personal app.
Set FINNHUB_API_KEY in .env to activate.
"""

import os
import requests
from datetime import datetime, timedelta
from typing import Optional

_BASE = "https://finnhub.io/api/v1"
_TIMEOUT = 8


def _key() -> Optional[str]:
    return os.environ.get("FINNHUB_API_KEY", "").strip() or None


def _get(path: str, params: dict) -> Optional[object]:
    k = _key()
    if not k:
        return None
    try:
        r = requests.get(f"{_BASE}{path}", params={**params, "token": k}, timeout=_TIMEOUT)
        if r.status_code == 200:
            return r.json()
    except Exception:
        pass
    return None


# ------------------------------------------------------------------ #
# Individual endpoints
# ------------------------------------------------------------------ #

def get_analyst_recommendations(symbol: str) -> Optional[dict]:
    """Most recent analyst buy/hold/sell consensus (last reported month)."""
    data = _get("/stock/recommendation", {"symbol": symbol})
    if not data or not isinstance(data, list) or not data:
        return None
    rec = data[0]
    sb = rec.get("strongBuy", 0)
    b  = rec.get("buy", 0)
    h  = rec.get("hold", 0)
    s  = rec.get("sell", 0)
    ss = rec.get("strongSell", 0)
    total = sb + b + h + s + ss
    if total == 0:
        return None
    # Weighted 0-10: strongBuy=5, buy=4, hold=3, sell=2, strongSell=1
    score = ((sb * 5 + b * 4 + h * 3 + s * 2 + ss * 1) / total - 1) / 4 * 10
    buy_pct  = (sb + b) / total * 100
    sell_pct = (s + ss) / total * 100
    if buy_pct >= 60:
        label = "Strong Buy" if sb / total > 0.3 else "Buy"
    elif sell_pct >= 40:
        label = "Sell"
    else:
        label = "Hold"
    return {
        "strong_buy": sb, "buy": b, "hold": h, "sell": s, "strong_sell": ss,
        "total": total, "score": round(score, 1),
        "buy_pct": round(buy_pct, 1), "sell_pct": round(sell_pct, 1),
        "label": label, "period": rec.get("period", ""),
    }


def get_price_target(symbol: str, current_price: float = None) -> Optional[dict]:
    """Analyst price target consensus — mean, high, low, upside %."""
    data = _get("/stock/price-target", {"symbol": symbol})
    if not data or not data.get("targetMean"):
        return None
    mean = data["targetMean"]
    result = {
        "mean": round(mean, 2),
        "high": data.get("targetHigh"),
        "low":  data.get("targetLow"),
        "last_updated": data.get("lastUpdated", ""),
    }
    if current_price and current_price > 0:
        result["upside_pct"] = round((mean - current_price) / current_price * 100, 1)
    return result


def get_earnings_history(symbol: str) -> Optional[dict]:
    """Last 4 quarters of earnings surprises (beat / miss vs. estimates)."""
    data = _get("/stock/earnings", {"symbol": symbol})
    if not data or not isinstance(data, list):
        return None
    quarters = []
    for q in data[:4]:
        actual   = q.get("actual")
        estimate = q.get("estimate")
        if actual is None:
            continue
        beat = None
        if estimate is not None and estimate != 0:
            beat = actual > estimate
        quarters.append({
            "period":       q.get("period", ""),
            "actual":       actual,
            "estimate":     estimate,
            "surprise_pct": round(q["surprisePercent"], 1) if q.get("surprisePercent") is not None else None,
            "beat":         beat,
        })
    if not quarters:
        return None
    beats = sum(1 for q in quarters if q.get("beat") is True)
    return {
        "quarters":  quarters,
        "beat_rate": round(beats / len(quarters) * 100),
        "beats":     beats,
        "total":     len(quarters),
    }


def get_insider_sentiment(symbol: str) -> Optional[dict]:
    """Net insider buying/selling over the past 3 months (MSPR -1 to 1)."""
    to_dt   = datetime.now()
    from_dt = to_dt - timedelta(days=90)
    data = _get("/stock/insider-sentiment", {
        "symbol": symbol,
        "from": from_dt.strftime("%Y-%m-%d"),
        "to":   to_dt.strftime("%Y-%m-%d"),
    })
    if not data or not data.get("data"):
        return None
    items = data["data"]
    msprs = [item["mspr"] for item in items if item.get("mspr") is not None]
    if not msprs:
        return None
    avg = sum(msprs) / len(msprs)
    label = "Net Buying" if avg > 0.1 else "Net Selling" if avg < -0.1 else "Neutral"
    return {
        "mspr":                round(avg, 3),
        "label":               label,
        "total_purchase_usd":  sum(item.get("purchaseAmount", 0) for item in items),
        "total_sale_usd":      sum(item.get("saleAmount", 0) for item in items),
    }


def get_basic_financials(symbol: str) -> Optional[dict]:
    """Key financial ratios — P/E, P/B, ROE, debt/equity, 52-week return."""
    data = _get("/stock/metric", {"symbol": symbol, "metric": "all"})
    if not data or not data.get("metric"):
        return None
    m = data["metric"]
    mapping = {
        "pe":             "peNormalizedAnnual",
        "pb":             "pbAnnual",
        "roe":            "roeAnnual",
        "debt_equity":    "totalDebt/totalEquityAnnual",
        "return_52w":     "52WeekPriceReturnDaily",
        "revenue_growth": "revenueGrowthTTMYoy",
        "eps_growth":     "epsGrowthTTMYoy",
        "current_ratio":  "currentRatioAnnual",
        "dividend_yield": "dividendYieldIndicatedAnnual",
    }
    result = {}
    for key, field in mapping.items():
        val = m.get(field)
        if val is not None:
            result[key] = round(val, 2)
    return result or None


def get_company_peers(symbol: str, limit: int = 6) -> Optional[list]:
    """Peer tickers in the same sector/industry (Finnhub /stock/peers)."""
    data = _get("/stock/peers", {"symbol": symbol})
    if not data or not isinstance(data, list):
        return None
    peers = [p for p in data if isinstance(p, str) and p.upper() != symbol.upper()]
    return peers[:limit] or None


def get_recommendation_trend(symbol: str) -> Optional[dict]:
    """How the analyst consensus has shifted over the last few months.

    Returns a direction (improving / steady / weakening) plus the raw monthly
    buy/hold/sell counts so the UI can show the trend, not just a snapshot.
    """
    data = _get("/stock/recommendation", {"symbol": symbol})
    if not data or not isinstance(data, list) or len(data) < 2:
        return None

    def _score(rec):
        sb, b, h, s, ss = (rec.get(k, 0) for k in ("strongBuy", "buy", "hold", "sell", "strongSell"))
        total = sb + b + h + s + ss
        return ((sb * 5 + b * 4 + h * 3 + s * 2 + ss * 1) / total) if total else None  # 1..5

    cur = _score(data[0])
    prev = _score(data[min(2, len(data) - 1)])
    if cur is None or prev is None:
        return None
    delta = cur - prev
    direction = "improving" if delta > 0.15 else "weakening" if delta < -0.15 else "steady"
    return {
        "direction": direction,
        "current_period": data[0].get("period", ""),
        "months": [
            {"period": r.get("period", ""), "strong_buy": r.get("strongBuy", 0),
             "buy": r.get("buy", 0), "hold": r.get("hold", 0),
             "sell": r.get("sell", 0), "strong_sell": r.get("strongSell", 0)}
            for r in data[:3]
        ],
    }


# ------------------------------------------------------------------ #
# Combined call (used by run_research)
# ------------------------------------------------------------------ #

def get_finnhub_analytics(symbol: str, current_price: float = None) -> dict:
    """Fetch all Finnhub analytics for a symbol. Returns {} when no key set."""
    if not _key():
        return {}
    result = {}
    rec = get_analyst_recommendations(symbol)
    if rec:
        result["analyst"] = rec
    pt = get_price_target(symbol, current_price)
    if pt:
        result["price_target"] = pt
    earnings = get_earnings_history(symbol)
    if earnings:
        result["earnings"] = earnings
    insider = get_insider_sentiment(symbol)
    if insider:
        result["insider"] = insider
    ratios = get_basic_financials(symbol)
    if ratios:
        result["ratios"] = ratios
    peers = get_company_peers(symbol)
    if peers:
        result["peers"] = peers
    trend = get_recommendation_trend(symbol)
    if trend:
        result["rec_trend"] = trend
    return result
