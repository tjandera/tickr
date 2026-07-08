// Rate limiters to blunt brute-force + email-spam. Tuned for a small app: tight
// on login/OTP (credential guessing), looser on signup (per IP). In-memory store
// is fine for a single Node process; move to a shared store if you scale out.
import rateLimit from "express-rate-limit";

const opts = (windowMs, max, message) =>
  rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res) => res.status(429).json({ detail: message }),
  });

// 5 login attempts per 15 min per IP.
export const loginLimiter = opts(15 * 60 * 1000, 5, "Too many login attempts. Try again in a few minutes.");

// 10 OTP verifications per 15 min per IP (the code itself is also attempt-capped).
export const otpLimiter = opts(15 * 60 * 1000, 10, "Too many attempts. Request a new code shortly.");

// 5 new accounts per hour per IP.
export const signupLimiter = opts(60 * 60 * 1000, 5, "Too many signups from this network. Try again later.");

// General ceiling for all /api routes: generous for the SPA's real usage
// (40 req/min sustained) but stops a naive flood from monopolizing the
// Python data tier or the cache.
export const apiLimiter = opts(15 * 60 * 1000, 600, "Too many requests. Please slow down.");

// Briefs are the most expensive call in the app (multi-minute research
// subprocess + paid AI tokens), so they get their own tight budget.
export const generateLimiter = opts(15 * 60 * 1000, 20, "Too many briefs requested. Try again in a few minutes.");
