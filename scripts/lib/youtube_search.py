"""
YouTube Data API connector.

Recommends one explainer video per ticker so a reader can watch a quick rundown
of what is going on with the stock. Uses the official YouTube Data API v3.

Set YOUTUBE_API_KEY in .env to activate. Free quota is 10,000 units/day; a
recommendation costs ~101 units (one search.list + one videos.list), so this is
comfortable for a personal app.
"""

import os
import re
import requests
from datetime import datetime, timedelta, timezone
from typing import Optional, List, Dict

_SEARCH_URL = "https://www.googleapis.com/youtube/v3/search"
_VIDEOS_URL = "https://www.googleapis.com/youtube/v3/videos"
_TIMEOUT = 8


def _key() -> Optional[str]:
    return os.environ.get("YOUTUBE_API_KEY", "").strip() or None


def is_available() -> bool:
    return bool(_key())


def _parse_duration(iso: str) -> Optional[int]:
    """ISO-8601 duration (e.g. PT12M30S) to seconds."""
    m = re.match(r"PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?", iso or "")
    if not m:
        return None
    h, mn, s = (int(x) if x else 0 for x in m.groups())
    return h * 3600 + mn * 60 + s


def _fmt_length(seconds: Optional[int]) -> str:
    if not seconds:
        return ""
    m, s = divmod(seconds, 60)
    h, m = divmod(m, 60)
    return f"{h}:{m:02d}:{s:02d}" if h else f"{m}:{s:02d}"


def _fmt_views(n: Optional[int]) -> str:
    if not n:
        return ""
    if n >= 1_000_000:
        return f"{n / 1_000_000:.1f}M views"
    if n >= 1_000:
        return f"{n / 1_000:.0f}K views"
    return f"{n} views"


def _ago(published: str) -> str:
    try:
        dt = datetime.fromisoformat(published.replace("Z", "+00:00"))
        days = (datetime.now(timezone.utc) - dt).days
        if days <= 0:
            return "today"
        if days == 1:
            return "1 day ago"
        if days < 30:
            return f"{days} days ago"
        if days < 365:
            return f"{days // 30} mo ago"
        return f"{days // 365} yr ago"
    except Exception:
        return ""


def recommend_video(symbol: str, name: str = "") -> Optional[Dict]:
    """Return the single best explainer video for a ticker, or None.

    Searches recent, relevant videos, then ranks them by view count while
    skipping Shorts (too short) and very long streams (too long), so the pick
    is a watchable rundown rather than a 3-hour livestream or a 30-second clip.
    """
    key = _key()
    if not key:
        return None
    label = (name or symbol).strip()
    query = f"{label} {symbol} stock analysis"
    published_after = (datetime.now(timezone.utc) - timedelta(days=180)).strftime("%Y-%m-%dT%H:%M:%SZ")

    try:
        sr = requests.get(_SEARCH_URL, timeout=_TIMEOUT, params={
            "key": key, "q": query, "part": "snippet", "type": "video",
            "order": "relevance", "maxResults": 6, "relevanceLanguage": "en",
            "safeSearch": "moderate", "videoEmbeddable": "true",
            "publishedAfter": published_after,
        })
        if sr.status_code != 200:
            return None
        items = sr.json().get("items", [])
    except Exception:
        return None

    candidates: List[Dict] = []
    for it in items:
        vid = (it.get("id") or {}).get("videoId")
        sn = it.get("snippet") or {}
        if not vid:
            continue
        thumbs = sn.get("thumbnails") or {}
        thumb = (thumbs.get("medium") or thumbs.get("high") or thumbs.get("default") or {}).get("url", "")
        candidates.append({
            "video_id": vid,
            "title": sn.get("title", ""),
            "channel": sn.get("channelTitle", ""),
            "published": sn.get("publishedAt", ""),
            "thumbnail": thumb,
        })
    if not candidates:
        return None

    # Enrich with statistics + duration so we can rank and label.
    stats = {}
    try:
        ids = ",".join(c["video_id"] for c in candidates)
        vr = requests.get(_VIDEOS_URL, timeout=_TIMEOUT, params={
            "key": key, "id": ids, "part": "statistics,contentDetails",
        })
        if vr.status_code == 200:
            for v in vr.json().get("items", []):
                stats[v["id"]] = {
                    "views": int((v.get("statistics") or {}).get("viewCount", 0) or 0),
                    "seconds": _parse_duration((v.get("contentDetails") or {}).get("duration", "")),
                }
    except Exception:
        pass

    def _ok(c):
        s = stats.get(c["video_id"], {})
        secs = s.get("seconds")
        # Skip Shorts (<90s) and marathon streams (>45m); keep unknown durations.
        return secs is None or (90 <= secs <= 2700)

    ranked = [c for c in candidates if _ok(c)] or candidates
    ranked.sort(key=lambda c: stats.get(c["video_id"], {}).get("views", 0), reverse=True)
    best = ranked[0]
    s = stats.get(best["video_id"], {})
    best["views"] = s.get("views")
    best["seconds"] = s.get("seconds")
    best["url"] = f"https://www.youtube.com/watch?v={best['video_id']}"
    best["length_label"] = _fmt_length(s.get("seconds"))
    best["views_label"] = _fmt_views(s.get("views"))
    best["ago"] = _ago(best.get("published", ""))
    return best
