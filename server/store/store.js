// JSON persistence for holdings + notes — a direct port of scripts/lib/store.py.
// Same files (web/data/*.json), atomic writes (write-temp-then-rename).
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { DATA_DIR } from "../config.js";

function load(name, fallback) {
  const path = resolve(DATA_DIR, name);
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

function save(name, data) {
  mkdirSync(DATA_DIR, { recursive: true });
  const path = resolve(DATA_DIR, name);
  const tmp = path + ".tmp";
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  renameSync(tmp, path); // atomic on POSIX
}

const nowISO = () => new Date().toISOString();
const today = () => new Date().toISOString().slice(0, 10);
const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

// -- Portfolio -----------------------------------------------------------------

export function getHoldings() {
  return load("portfolio.json", { holdings: [] }).holdings || [];
}

export function getHolding(ticker) {
  const t = (ticker || "").toUpperCase().trim();
  if (!t) return null;
  return getHoldings().find((h) => String(h.ticker || "").toUpperCase() === t) || null;
}

export function upsertHolding(ticker, shares, costBasis) {
  const t = (ticker || "").toUpperCase().trim();
  if (!t) throw new Error("ticker is required");
  const data = load("portfolio.json", { holdings: [] });
  data.holdings = data.holdings || [];
  const existing = data.holdings.find((h) => String(h.ticker || "").toUpperCase() === t);
  if (existing) {
    existing.shares = num(shares) || 0;
    existing.cost_basis = num(costBasis);
    save("portfolio.json", data);
    return existing;
  }
  const created = { ticker: t, shares: num(shares) || 0, cost_basis: num(costBasis), added_at: nowISO() };
  data.holdings.push(created);
  save("portfolio.json", data);
  return created;
}

export function removeHolding(ticker) {
  const t = (ticker || "").toUpperCase().trim();
  const data = load("portfolio.json", { holdings: [] });
  data.holdings = data.holdings || [];
  const before = data.holdings.length;
  data.holdings = data.holdings.filter((h) => String(h.ticker || "").toUpperCase() !== t);
  save("portfolio.json", data);
  return data.holdings.length < before;
}

// -- Notes ---------------------------------------------------------------------

export function getNotes({ date = null, ticker = null } = {}) {
  let notes = load("notes.json", { notes: [] }).notes || [];
  if (date) notes = notes.filter((n) => n.date === date);
  if (ticker) {
    const t = ticker.toUpperCase();
    notes = notes.filter((n) => String(n.ticker || "").toUpperCase() === t);
  }
  return notes.sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")));
}

export function addNote({ text, date = null, ticker = null, headline = null, url = null }) {
  if (!(text || "").trim()) throw new Error("note text is required");
  const data = load("notes.json", { notes: [] });
  data.notes = data.notes || [];
  const note = {
    id: randomBytes(6).toString("hex"),
    date: date || today(),
    ticker: (ticker || "").toUpperCase() || null,
    headline: headline || null,
    url: url || null,
    text: text.trim(),
    created_at: nowISO(),
  };
  data.notes.push(note);
  save("notes.json", data);
  return note;
}

export function deleteNote(noteId) {
  const data = load("notes.json", { notes: [] });
  data.notes = data.notes || [];
  const before = data.notes.length;
  data.notes = data.notes.filter((n) => n.id !== noteId);
  save("notes.json", data);
  return data.notes.length < before;
}
