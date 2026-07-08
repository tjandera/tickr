// GET /api/home — the "Today" page payload: index quotes, upcoming events, and
// headlines across the user's holdings. Cached under the same pf:<owner> prefix
// as the portfolio overview, so editing a holding refreshes both together.
import express from "express";
const { Router } = express;
import * as store from "../store/store.js";
import { runJson } from "../tools/pythonData.js";
import { attachUser, requireUserIfAccounts } from "../middleware/auth.js";
import { cached } from "../lib/cache.js";
import { logError } from "../lib/log.js";

const router = Router();
// Path-scoped — see the note in portfolio.js.
router.use("/api/home", attachUser, requireUserIfAccounts);

const HOME_TTL_MS = 60_000;
const ownerKey = (req) => `pf:${req.user ? req.user._id.toString() : "local"}`;

router.get("/api/home", async (req, res) => {
  try {
    const data = await cached(`${ownerKey(req)}:home`, HOME_TTL_MS, async () => {
      if (req.user) {
        const holdings = (req.user.holdings || []).map((h) => ({ ticker: h.ticker }));
        return runJson("home", { holdingsStdin: true },
          { timeoutMs: 45000, input: JSON.stringify(holdings) });
      }
      return runJson("home", {}, { timeoutMs: 45000 });
    });
    res.json(data || { indices: [], events: [], headlines: [] });
  } catch (e) {
    logError("home", e);
    res.status(500).json({ detail: "Could not load the home page data." });
  }
});

export default router;
