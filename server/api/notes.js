// /api/notes* — calendar journal CRUD.
//
// Signed-in: notes live on the user's MongoDB document. Logged out (or DB down):
// the shared local file store, so behavior is unchanged from before accounts.
import express from "express";
const { Router } = express;
import { randomBytes } from "node:crypto";
import * as store from "../store/store.js";
import { attachUser } from "../middleware/auth.js";
import { encrypt, decrypt } from "../lib/encryption.js";

const router = Router();
router.use(attachUser);

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
  const text = (req.body?.text || "").trim();
  if (!text) return res.status(400).json({ detail: "note text is required" });

  if (req.user) {
    const note = {
      id: randomBytes(6).toString("hex"),
      date: req.body?.date || today(),
      ticker: (req.body?.ticker || "").toUpperCase() || null,
      headline: req.body?.headline || null,
      url: req.body?.url || null,
      text: encrypt(text), // stored encrypted at rest
      created_at: new Date(),
    };
    req.user.notes.push(note);
    await req.user.save();
    // Return the plaintext the user just wrote (not the ciphertext).
    return res.json({ status: "ok", note: { ...note, text } });
  }

  const note = store.addNote({
    text,
    date: req.body?.date || null,
    ticker: req.body?.ticker || null,
    headline: req.body?.headline || null,
    url: req.body?.url || null,
  });
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
