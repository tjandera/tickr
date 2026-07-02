// Auth middleware. requireAuth rejects unauthenticated requests; attachUser is
// a soft variant that populates req.user when a valid session exists but never
// blocks (used so portfolio/notes can fall back to the file store when logged
// out). The session token is read from an httpOnly cookie or a Bearer header.
import { verifySession } from "../lib/tokens.js";
import { User } from "../models/User.js";
import { isDBConnected } from "../lib/db.js";

function tokenFrom(req) {
  const auth = req.headers.authorization || "";
  if (auth.startsWith("Bearer ")) return auth.slice(7).trim();
  const cookie = req.headers.cookie || "";
  const match = cookie.match(/(?:^|;\s*)tickr_session=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

async function resolveUser(req) {
  if (!isDBConnected()) return null;
  const token = tokenFrom(req);
  if (!token) return null;
  try {
    const payload = verifySession(token);
    const user = await User.findById(payload.sub);
    return user && user.emailVerified ? user : null;
  } catch {
    return null; // invalid or expired
  }
}

// Hard gate: 401 unless a valid, verified session is present.
export async function requireAuth(req, res, next) {
  const user = await resolveUser(req);
  if (!user) return res.status(401).json({ detail: "Not authenticated" });
  req.user = user;
  next();
}

// Soft: attach req.user if available, otherwise continue as anonymous.
export async function attachUser(req, res, next) {
  req.user = await resolveUser(req);
  next();
}
