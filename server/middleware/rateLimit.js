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
