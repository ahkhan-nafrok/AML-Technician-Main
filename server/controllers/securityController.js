const SecurityLog            = require("../models/SecurityLog");
const Entry                  = require("../models/Entry");
const { normalizeVehicleNo } = require("../utils/vehicleUtils");

// ─── Helper: UTC midnight ─────────────────────────────────────────────────────
function utcMidnight(input) {
  const d = input ? new Date(input) : new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

// ─── POST /api/security/log ───────────────────────────────────────────────────
const createLog = async (req, res) => {
  try {
    const { vehicleNo } = req.body;

    if (!vehicleNo || vehicleNo.trim().length < 2) {
      return res.status(400).json({
        message: "Vehicle number must be at least 2 characters",
      });
    }

    const branch = req.user.branch;
    if (!branch || branch.trim() === "") {
      return res.status(400).json({
        message: "Security user has no branch configured. Contact your developer.",
      });
    }

    const trimmed       = vehicleNo.trim();
    const vehicleNoNorm = normalizeVehicleNo(trimmed);

    const log = await SecurityLog.create({
      vehicleNo:    trimmed,
      vehicleNoNorm,
      branch,
      loggedBy:     req.user.userId,
      date:         utcMidnight(),
      loggedAt:     new Date(),
    });

    res.status(201).json(log);
  } catch (err) {
    console.error("[createLog]", err);
    res.status(500).json({ message: err.message });
  }
};

// ─── GET /api/security/today ──────────────────────────────────────────────────
const getTodayLogs = async (req, res) => {
  try {
    const logs = await SecurityLog.find({
      loggedBy: req.user.userId,
      date:     utcMidnight(),
    })
      .sort({ loggedAt: -1 })
      .lean();

    res.json(logs);
  } catch (err) {
    console.error("[getTodayLogs]", err);
    res.status(500).json({ message: err.message });
  }
};

// ─── PUT /api/security/log/:id ────────────────────────────────────────────────
const editLog = async (req, res) => {
  try {
    const { vehicleNo } = req.body;

    if (!vehicleNo || vehicleNo.trim().length < 2) {
      return res.status(400).json({
        message: "Vehicle number must be at least 2 characters",
      });
    }

    const log = await SecurityLog.findById(req.params.id);
    if (!log) return res.status(404).json({ message: "Log not found" });

    if (log.loggedBy.toString() !== req.user.userId.toString()) {
      return res.status(403).json({ message: "Cannot edit another user's log" });
    }

    const trimmed     = vehicleNo.trim();
    log.vehicleNo     = trimmed;
    log.vehicleNoNorm = normalizeVehicleNo(trimmed);

    await log.save();
    res.json(log);
  } catch (err) {
    console.error("[editLog]", err);
    res.status(500).json({ message: err.message });
  }
};

// ─── GET /api/security/board ──────────────────────────────────────────────────
// OPTIMIZED: replaced N+1 Entry.find() loop with a single batched Entry.find()
// + JS-level partitioning. Response shape is identical to the original.
// ─────────────────────────────────────────────────────────────────────────────
const getBoardLogs = async (req, res) => {
  try {
    const isAdmin = req.user.role === "admin";

    const branch = isAdmin
      ? req.user.branch
      : (req.query.branch || null);

    const targetDate = utcMidnight(
      req.query.date ? new Date(req.query.date) : null
    );

    const q = (req.query.q || "").trim();

    const LIMIT    = 10;
    const safePage = Math.max(parseInt(req.query.page, 10) || 1, 1);

    const filter = { date: targetDate };
    if (branch) filter.branch = branch;
    if (q.length >= 3) {
      const normQ = normalizeVehicleNo(q);
      filter.vehicleNoNorm = { $regex: normQ, $options: "i" };
    }

    // ── 1. Fetch all matching logs for the day ─────────────────────────────
    // Same query as before. Sorted by vehicleNoNorm + loggedAt — the natural
    // order the linking algorithm requires.
    const allLogs = await SecurityLog.find(filter)
      .populate("loggedBy", "name")
      .sort({ vehicleNoNorm: 1, loggedAt: 1 })
      .lean();

    const total      = allLogs.length;
    const totalPages = Math.ceil(total / LIMIT);

    // Short-circuit: no logs → skip the entry query entirely
    if (total === 0) {
      return res.json({
        logs:            [],
        total:           0,
        page:            safePage,
        totalPages:      0,
        date:            targetDate,
        totalAssigned:   0,
        totalUnassigned: 0,
      });
    }

    // ── 2. Pre-compute log groups per (vehicleNoNorm|branch) key ────────────
    // allLogs is already sorted by { vehicleNoNorm: 1, loggedAt: 1 } from the
    // DB query, so each group's array is naturally in ascending loggedAt order.
    // This replaces the O(n²) allLogs.find() scan that was inside the old map.
    const logGroups = new Map(); // `${vehicleNoNorm}|${branch}` → SecurityLog[]
    let   globalMinLoggedAt = Infinity;

    for (const log of allLogs) {
      const key = `${log.vehicleNoNorm}|${log.branch}`;
      if (!logGroups.has(key)) logGroups.set(key, []);
      logGroups.get(key).push(log);

      const t = new Date(log.loggedAt).getTime();
      if (t < globalMinLoggedAt) globalMinLoggedAt = t;
    }

    // ── 3. ONE batched Entry query for all vehicles ────────────────────────
    // Old code: N Entry.find() calls (one per log) + N populate calls.
    // New code: 1 Entry.find() with $in on vehicleNoNorm + 1 populate.
    //
    // createdAt lower-bound = earliest loggedAt across all logs.
    // No upper-bound cap — by design (a technician can log a job card on D+1
    // for a vehicle that arrived on D; capping at midnight drops valid entries).
    //
    // Branch filter: applied when a specific branch is active (reduces scan).
    // When superadmin views all branches, omit branch filter — the JS grouping
    // below uses (vehicleNoNorm|branch) key and naturally isolates each branch.
    const vehicleNorms = [...new Set(allLogs.map((l) => l.vehicleNoNorm))];

    const entryFilter = {
      vehicleNoNorm: { $in: vehicleNorms },
      createdAt:     { $gte: new Date(globalMinLoggedAt) },
    };
    if (branch) entryFilter.branch = branch;

    const allEntries = await Entry.find(entryFilter)
      .populate("userId", "name technicianId technicianType")
      .sort({ createdAt: 1 }) // ascending — same as original per-log sort
      .lean();

    // ── 4. Partition entries to their owning log ───────────────────────────
    // For each entry, find its log by descending through the sorted log group
    // for that vehicle — stops at the last log whose loggedAt ≤ entry.createdAt,
    // then verifies entry.createdAt < nextLog.loggedAt (upper bound).
    //
    // Correctness guarantee: the groups are sorted ascending by loggedAt, so
    // scanning from the end finds the correct window in O(visits-per-vehicle)
    // steps — at most a few iterations for any realistic vehicle history.
    const entryMap = new Map(); // log._id.toString() → Entry[]

    for (const entry of allEntries) {
      const key           = `${entry.vehicleNoNorm}|${entry.branch}`;
      const logsForVehicle = logGroups.get(key);

      // Entry's vehicle wasn't in today's logs for this branch — skip
      if (!logsForVehicle) continue;

      const entryTime = new Date(entry.createdAt).getTime();

      // Descending scan: find the last log whose loggedAt ≤ entry.createdAt
      for (let i = logsForVehicle.length - 1; i >= 0; i--) {
        const logTime = new Date(logsForVehicle[i].loggedAt).getTime();
        if (entryTime >= logTime) {
          // Verify upper bound: entry must precede the next visit for this vehicle
          const nextLogTime =
            i + 1 < logsForVehicle.length
              ? new Date(logsForVehicle[i + 1].loggedAt).getTime()
              : Infinity;

          if (entryTime < nextLogTime) {
            const lid = logsForVehicle[i]._id.toString();
            if (!entryMap.has(lid)) entryMap.set(lid, []);
            entryMap.get(lid).push(entry);
          }
          break; // found the window — stop scanning
        }
        // If entryTime < logTime[0], loop exits with no assignment → correct
      }
    }

    // ── 5. Assemble full result (same shape as original) ─────────────────
    const allWithEntries = allLogs.map((log) => {
      const entries = entryMap.get(log._id.toString()) || [];
      return {
        ...log,
        entries,
        status: entries.length > 0 ? "assigned" : "unassigned",
      };
    });

    // Current-page slice (display only — totals always cover all logs)
    const withEntries = allWithEntries.slice(
      (safePage - 1) * LIMIT,
      safePage * LIMIT
    );

    // Totals derived from the same allWithEntries as the table — no drift
    let totalAssigned   = 0;
    let totalUnassigned = 0;
    for (const log of allWithEntries) {
      if (log.status === "assigned") totalAssigned++;
      else                            totalUnassigned++;
    }

    res.json({
      logs:            withEntries,
      total,
      page:            safePage,
      totalPages,
      date:            targetDate,
      totalAssigned,
      totalUnassigned,
    });
  } catch (err) {
    console.error("[getBoardLogs]", err);
    res.status(500).json({ message: err.message });
  }
};
module.exports = { createLog, getTodayLogs, editLog, getBoardLogs };