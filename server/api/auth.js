// /api/auth/* — account lifecycle: signup, email verification, password login,
// email-OTP second factor, session issue/clear, and "who am I". Sessions are
// carried in an httpOnly cookie (tickr_session). Requires a live MongoDB.
import express from "express";
const { Router } = express;
import { User } from "../models/User.js";
import { isDBConnected } from "../lib/db.js";
import { signSession, makeVerifyToken, makeOtp, sha256 } from "../lib/tokens.js";
import { sendVerificationEmail, sendLoginOtp } from "../lib/email.js";
import { loginLimiter, otpLimiter, signupLimiter } from "../middleware/rateLimit.js";
import { requireAuth } from "../middleware/auth.js";

const router = Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const VERIFY_TTL_MS = 24 * 60 * 60 * 1000; // 24h to confirm email
const OTP_TTL_MS = 10 * 60 * 1000;         // 10 min OTP validity
const OTP_MAX_ATTEMPTS = 5;
const APP_URL = () => (process.env.APP_URL || "http://localhost:3005").trim();

// Require a database for every auth route; fail clearly if it is down.
router.use((req, res, next) => {
  if (!isDBConnected()) {
    return res.status(503).json({ detail: "Accounts are unavailable right now (database not connected)." });
  }
  next();
});

function setSessionCookie(res, token) {
  const secure = APP_URL().startsWith("https");
  const parts = [
    `tickr_session=${encodeURIComponent(token)}`,
    "HttpOnly",
    "Path=/",
    "SameSite=Lax",
    `Max-Age=${7 * 24 * 60 * 60}`, // 7 days, matches JWT TTL
  ];
  if (secure) parts.push("Secure");
  res.setHeader("Set-Cookie", parts.join("; "));
}

function clearSessionCookie(res) {
  res.setHeader("Set-Cookie", "tickr_session=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0");
}

// POST /api/auth/signup { email, password } → creates an unverified account and
// emails a verification link. Always 200 on valid input to avoid leaking which
// emails are registered.
router.post("/api/auth/signup", signupLimiter, async (req, res) => {
  const email = String(req.body?.email || "").trim().toLowerCase();
  const password = String(req.body?.password || "");
  if (!EMAIL_RE.test(email)) return res.status(400).json({ detail: "Enter a valid email address." });
  if (password.length < 8) return res.status(400).json({ detail: "Password must be at least 8 characters." });

  try {
    const existing = await User.findOne({ email });
    if (existing) {
      // Do not reveal registration status; tell them to check their inbox.
      return res.json({ status: "ok", message: "Check your email to confirm your account." });
    }
    const user = new User({ email });
    await user.setPassword(password);
    const { raw, hash } = makeVerifyToken();
    user.verifyTokenHash = hash;
    user.verifyTokenExpires = new Date(Date.now() + VERIFY_TTL_MS);
    await user.save();

    await sendVerificationEmail(email, raw);
    res.json({ status: "ok", message: "Check your email to confirm your account." });
  } catch (e) {
    res.status(500).json({ detail: `Signup failed: ${e.message}` });
  }
});

// GET /api/auth/verify?token= → confirm email, then redirect to the login page.
router.get("/api/auth/verify", async (req, res) => {
  const raw = String(req.query.token || "");
  if (!raw) return res.status(400).send("Missing token.");
  try {
    const user = await User.findOne({
      verifyTokenHash: sha256(raw),
      verifyTokenExpires: { $gt: new Date() },
    });
    if (!user) return res.redirect(`${APP_URL()}/auth?verified=0`);
    user.emailVerified = true;
    user.verifyTokenHash = null;
    user.verifyTokenExpires = null;
    await user.save();
    res.redirect(`${APP_URL()}/auth?verified=1`);
  } catch (e) {
    res.status(500).send(`Verification failed: ${e.message}`);
  }
});

// POST /api/auth/login { email, password } → if verified, emails a 6-digit OTP
// and returns { otp_required: true }. The session is only issued after the OTP.
router.post("/api/auth/login", loginLimiter, async (req, res) => {
  const email = String(req.body?.email || "").trim().toLowerCase();
  const password = String(req.body?.password || "");
  const generic = { detail: "Incorrect email or password." };
  try {
    const user = await User.findOne({ email });
    if (!user) return res.status(401).json(generic);
    const ok = await user.verifyPassword(password);
    if (!ok) return res.status(401).json(generic);
    if (!user.emailVerified) {
      return res.status(403).json({ detail: "Please confirm your email first. Check your inbox." });
    }

    const { code, hash } = makeOtp();
    user.loginOtpHash = hash;
    user.loginOtpExpires = new Date(Date.now() + OTP_TTL_MS);
    user.loginOtpAttempts = 0;
    await user.save();
    await sendLoginOtp(email, code);

    res.json({ status: "otp_required", email, message: "We emailed you a 6-digit login code." });
  } catch (e) {
    res.status(500).json({ detail: `Login failed: ${e.message}` });
  }
});

// POST /api/auth/verify-otp { email, code } → validate the code, issue session.
router.post("/api/auth/verify-otp", otpLimiter, async (req, res) => {
  const email = String(req.body?.email || "").trim().toLowerCase();
  const code = String(req.body?.code || "").trim();
  try {
    const user = await User.findOne({ email });
    if (!user || !user.loginOtpHash || !user.loginOtpExpires) {
      return res.status(400).json({ detail: "No pending login. Start again." });
    }
    if (user.loginOtpExpires.getTime() < Date.now()) {
      return res.status(400).json({ detail: "That code expired. Please log in again." });
    }
    if (user.loginOtpAttempts >= OTP_MAX_ATTEMPTS) {
      user.loginOtpHash = null; user.loginOtpExpires = null;
      await user.save();
      return res.status(429).json({ detail: "Too many wrong codes. Please log in again." });
    }
    if (sha256(code) !== user.loginOtpHash) {
      user.loginOtpAttempts += 1;
      await user.save();
      return res.status(401).json({ detail: "Incorrect code." });
    }

    // Success: clear OTP, stamp login, issue session.
    user.loginOtpHash = null;
    user.loginOtpExpires = null;
    user.loginOtpAttempts = 0;
    user.lastLoginAt = new Date();
    await user.save();

    setSessionCookie(res, signSession(user));
    res.json({ status: "ok", user: user.toSafeJSON(), onboarded: (user.holdings?.length || 0) > 0 });
  } catch (e) {
    res.status(500).json({ detail: `Verification failed: ${e.message}` });
  }
});

// POST /api/auth/logout → clear the session cookie.
router.post("/api/auth/logout", (req, res) => {
  clearSessionCookie(res);
  res.json({ status: "ok" });
});

// GET /api/auth/me → the current user (401 if not signed in).
router.get("/api/auth/me", requireAuth, (req, res) => {
  res.json({ user: req.user.toSafeJSON(), onboarded: (req.user.holdings?.length || 0) > 0 });
});

export default router;
