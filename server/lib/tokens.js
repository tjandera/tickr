// Token + code helpers: JWT session tokens, random verification tokens, and
// numeric login OTPs. Secrets/expiries come from the environment.
import jwt from "jsonwebtoken";
import { randomBytes, randomInt, createHash } from "node:crypto";

const JWT_SECRET = () => (process.env.JWT_SECRET || "").trim();
const JWT_TTL = process.env.JWT_TTL || "7d"; // session length

// --- Session JWTs -----------------------------------------------------------

export function signSession(user) {
  if (!JWT_SECRET()) throw new Error("JWT_SECRET is not set");
  return jwt.sign({ sub: user._id.toString(), email: user.email }, JWT_SECRET(), {
    expiresIn: JWT_TTL,
  });
}

export function verifySession(token) {
  if (!JWT_SECRET()) throw new Error("JWT_SECRET is not set");
  return jwt.verify(token, JWT_SECRET()); // throws on invalid/expired
}

// --- Email verification tokens ---------------------------------------------

// A long random URL-safe token. We store only its hash; the raw value goes in
// the verification link so a database leak can't be used to verify accounts.
export function makeVerifyToken() {
  const raw = randomBytes(32).toString("hex");
  return { raw, hash: sha256(raw) };
}

// --- Login OTP (email 2FA) --------------------------------------------------

// A 6-digit code, uniformly random. Returned raw (to email) + hashed (to store).
export function makeOtp() {
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  return { code, hash: sha256(code) };
}

// --- Hashing ----------------------------------------------------------------

// SHA-256 hex. Used for verification tokens and OTPs (short-lived, high-entropy
// for tokens; OTPs are additionally rate-limited + attempt-capped in the route).
export function sha256(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}
