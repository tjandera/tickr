// User model — one document per account. Holds credentials (bcrypt hash, never
// plain text), email-verification + login-OTP state (email 2FA), and the user's
// own portfolio holdings + notes as embedded subdocuments. At hundreds of users
// this single-document design is simple and fast.
import mongoose from "mongoose";
import bcrypt from "bcryptjs";

const holdingSchema = new mongoose.Schema(
  {
    ticker: { type: String, required: true, uppercase: true, trim: true },
    shares: { type: Number, default: 0 },
    cost_basis: { type: Number, default: null },
    added_at: { type: Date, default: Date.now },
  },
  { _id: false }
);

const noteSchema = new mongoose.Schema(
  {
    id: { type: String, required: true },
    date: { type: String, default: null },
    ticker: { type: String, default: null },
    headline: { type: String, default: null },
    url: { type: String, default: null },
    text: { type: String, required: true },
    created_at: { type: Date, default: Date.now },
  },
  { _id: false }
);

const userSchema = new mongoose.Schema(
  {
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      index: true,
    },
    passwordHash: { type: String, required: true },

    // Email verification (must confirm before login is allowed).
    emailVerified: { type: Boolean, default: false },
    verifyTokenHash: { type: String, default: null },
    verifyTokenExpires: { type: Date, default: null },

    // Login 2FA: a one-time code emailed on each login. Stored hashed with a
    // short expiry and a capped attempt counter to resist guessing.
    loginOtpHash: { type: String, default: null },
    loginOtpExpires: { type: Date, default: null },
    loginOtpAttempts: { type: Number, default: 0 },

    // The user's data (moved off the flat JSON files, scoped per account).
    holdings: { type: [holdingSchema], default: [] },
    notes: { type: [noteSchema], default: [] },

    lastLoginAt: { type: Date, default: null },
  },
  { timestamps: true }
);

// Hash + set the password. bcrypt cost 12 is a good speed/safety balance.
userSchema.methods.setPassword = async function setPassword(plain) {
  this.passwordHash = await bcrypt.hash(plain, 12);
};

// Constant-time compare of a candidate password against the stored hash.
userSchema.methods.verifyPassword = function verifyPassword(plain) {
  return bcrypt.compare(plain, this.passwordHash);
};

// A safe view of the user for API responses (never leaks the hash or OTP state).
userSchema.methods.toSafeJSON = function toSafeJSON() {
  return {
    id: this._id.toString(),
    email: this.email,
    emailVerified: this.emailVerified,
    holdings: this.holdings,
    createdAt: this.createdAt,
    lastLoginAt: this.lastLoginAt,
  };
};

export const User = mongoose.models.User || mongoose.model("User", userSchema);
