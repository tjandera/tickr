// Tiny in-memory TTL cache. Market data here is delayed anyway, so serving a
// value up to ~60s old is invisible to users but turns repeat portfolio/chart
// loads from multi-second Python+Yahoo round-trips into instant responses.
const store = new Map(); // key -> { value, expires }

export function getCached(key) {
  const hit = store.get(key);
  if (!hit) return undefined;
  if (Date.now() > hit.expires) { store.delete(key); return undefined; }
  return hit.value;
}

export function setCached(key, value, ttlMs) {
  store.set(key, { value, expires: Date.now() + ttlMs });
  // Opportunistic sweep so the map cannot grow unbounded.
  if (store.size > 500) {
    const now = Date.now();
    for (const [k, v] of store) if (now > v.expires) store.delete(k);
  }
  return value;
}

// Fetch-through helper: one producer runs, concurrent callers share the promise.
const inflight = new Map();
export async function cached(key, ttlMs, producer) {
  const hit = getCached(key);
  if (hit !== undefined) return hit;
  if (inflight.has(key)) return inflight.get(key);
  const p = (async () => {
    try {
      const value = await producer();
      if (value !== undefined && value !== null) setCached(key, value, ttlMs);
      return value;
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, p);
  return p;
}

// Drop keys by prefix (e.g. bust one user's portfolio after an edit).
export function invalidatePrefix(prefix) {
  for (const k of store.keys()) if (k.startsWith(prefix)) store.delete(k);
}
