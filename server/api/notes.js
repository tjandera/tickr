// /api/notes* — calendar journal CRUD.
//
// Signed-in: notes live on the user's MongoDB document. Logged out (or DB down):
// the shared local file store, so behavior is unchanged from before accounts.
import express from "express";
const { Router } = express;
import { randomBytes } from "node:crypto";
import * as store from "../store/store.js";
import { attachUser, requireUserIfAccounts } from "../middleware/auth.js";
import { encrypt, decrypt } from "../lib/encryption.js";
import { cleanSymbol, cleanUrl, cleanDate, capString } from "../lib/validate.js";

const router = Router();
// Path-scoped — see the note in portfolio.js.
router.use("/api/notes", attachUser, requireUserIfAccounts);

// Field caps: generous for real use, small enough that no one can balloon
// their user document toward Mongo's 16MB per-document limit.
const MAX_TEXT = 5000;
const MAX_HEADLINE = 300;
const MAX_NOTES = 1000;

const today = () => new Date().toISOString().slice(0, 10);
const byNewest = (a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0);

// A plain, client-safe copy of a stored note with its text decrypted.
const decodeNote = (n) => {
  const o = typeof n.toObject === "function" ? n.toObject() : { ...n };
  o.text = decrypt(o.text);
  return o;
};

router.get("/api/notes", (req, res) => {
  const date = req.query.date ? String(req.query.date) : null;
  const ticker = req.query.ticker ? String(req.query.ticker).toUpperCase() : null;

  if (req.user) {
    let notes = [...(req.user.notes || [])];
    if (date) notes = notes.filter((n) => n.date === date);
    if (ticker) notes = notes.filter((n) => String(n.ticker || "").toUpperCase() === ticker);
    notes.sort(byNewest);
    return res.json({ notes: notes.map(decodeNote) }); // decrypt for the client
  }
  res.json({ notes: store.getNotes({ date, ticker }) });
});

router.post("/api/notes", async (req, res) => {
  const text = capString(req.body?.text, MAX_TEXT);
  if (!text) return res.status(400).json({ detail: "note text is required" });
  // Validate everything up front so both storage paths get the same clean data.
  // cleanUrl only accepts absolute http(s) URLs — a stored "javascript:" URL
  // would otherwise come back to life inside an <a href> in the notes UI.
  const date = cleanDate(req.body?.date);
  const ticker = cleanSymbol(req.body?.ticker);
  const headline = capString(req.body?.headline, MAX_HEADLINE);
  const url = cleanUrl(req.body?.url);

  if (req.user) {
    if ((req.user.notes || []).length >= MAX_NOTES) {
      return res.status(400).json({ detail: `Notes are full (max ${MAX_NOTES}). Delete some to add more.` });
    }
    const note = {
      id: randomBytes(6).toString("hex"),
      date: date || today(),
      ticker,
      headline,
      url,
      text: encrypt(text), // stored encrypted at rest
      created_at: new Date(),
    };
    req.user.notes.push(note);
    await req.user.save();
    // Return the plaintext the user just wrote (not the ciphertext).
    return res.json({ status: "ok", note: { ...note, text } });
  }

  const note = store.addNote({ text, date, ticker, headline, url });
  res.json({ status: "ok", note });
});

router.delete("/api/notes/:id", async (req, res) => {
  if (req.user) {
    const before = req.user.notes.length;
    req.user.notes = req.user.notes.filter((n) => n.id !== req.params.id);
    await req.user.save();
    return res.json({ status: "ok", removed: req.user.notes.length < before });
  }
  res.json({ status: "ok", removed: store.deleteNote(req.params.id) });
});

export default router;
