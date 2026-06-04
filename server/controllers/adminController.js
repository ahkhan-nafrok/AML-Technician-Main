const Entry      = require("../models/Entry");
const User       = require("../models/User");
const Attendance = require("../models/Attendance"); // FIX Bugs 5 & 6: needed for cascade operations

// FIX Bug 10: Server-side branch whitelist.
// Must stay in sync with client/src/utils/constants.js — BRANCHES array.
// If a new branch is added, update both files together.
const VALID_BRANCHES = ["BALLARI", "CHITRADURGA", "HOSPET", "RAICHUR"];

/**
 * isBranchAdmin(req)
 * True if the requester is a branch-scoped admin (not superadmin).
 * Used throughout to decide whether to enforce branch filters.
 */
const isBranchAdmin = (req) => req.user.role === "admin";

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/admin/branches  ← SUPERADMIN ONLY (enforced in routes)
// ─────────────────────────────────────────────────────────────────────────────
const getBranches = async (req, res) => {
  try {
    const branches = await User.distinct("branch", {
      role:   "technician",
      branch: { $ne: "" },
    });
    res.json(branches);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/admin/branch/:branch  — aggregated stats for a branch
// ─────────────────────────────────────────────────────────────────────────────
const getBranchDashboard = async (req, res) => {
  try {
    const { branch } = req.params;

    // Branch admin: the URL branch must match their own branch.
    if (isBranchAdmin(req) && branch !== req.user.branch) {
      return res
        .status(403)
        .json({ message: "Access denied: You can only view your own branch." });
    }

    const [stats] = await Entry.aggregate([
      { $match: { branch } },
      {
        $group: {
          _id:             null,
          totalHours:      { $sum: "$hoursWorked" },
          totalLabour:     { $sum: "$labourAmount" },
          totalIncentives: { $sum: "$incentive" },
          totalLeaveDays:  { $sum: "$leaveDays" },
          totalEntries:    { $count: {} },
        },
      },
    ]);

    const categoryBreakdown = await Entry.aggregate([
      { $match: { branch } },
      { $group: { _id: "$category", count: { $count: {} } } },
      { $sort: { count: -1 } },
    ]);

    const technicianCount = await User.countDocuments({
      branch,
      role: "technician",
    });

    res.json({
      branch,
      technicianCount,
      totalHours:      stats?.totalHours      || 0,
      totalLabour:     stats?.totalLabour     || 0,
      totalIncentives: stats?.totalIncentives || 0,
      totalLeaveDays:  stats?.totalLeaveDays  || 0,
      totalEntries:    stats?.totalEntries    || 0,
      avgHoursPerTechnician: technicianCount
        ? ((stats?.totalHours || 0) / technicianCount).toFixed(1)
        : 0,
      categoryBreakdown,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/admin/branch/:branch/technicians
// ─────────────────────────────────────────────────────────────────────────────
const getBranchTechnicians = async (req, res) => {
  try {
    const { branch } = req.params;

    if (isBranchAdmin(req) && branch !== req.user.branch) {
      return res
        .status(403)
        .json({ message: "Access denied: You can only view your own branch." });
    }

    const technicians = await User.find({ branch, role: "technician" }).select("-password");

    const result = await Promise.all(
      technicians.map(async (tech) => {
        const [summary] = await Entry.aggregate([
          { $match: { userId: tech._id } },
          {
            $group: {
              _id:          null,
              totalEntries: { $count: {} },
              totalHours:   { $sum: "$hoursWorked" },
              totalLabour:  { $sum: "$labourAmount" },
            },
          },
        ]);

        return {
          id:             tech._id,
          name:           tech.name,
          technicianId:   tech.technicianId,
          email:          tech.email,
          technicianType: tech.technicianType || null,
          totalEntries:   summary?.totalEntries || 0,
          totalHours:     summary?.totalHours   || 0,
          totalLabour:    summary?.totalLabour  || 0,
        };
      })
    );

    res.json(result);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/admin/technician/:userId  — paginated entries
// ─────────────────────────────────────────────────────────────────────────────
const getTechnicianEntries = async (req, res) => {
  try {
    const { userId } = req.params;
    const page  = parseInt(req.query.page)  || 1;
    const limit = parseInt(req.query.limit) || 20;

    // Always fetch the target user first — we need their branch for ownership check.
    const targetUser = await User.findById(userId).select("-password");
    if (!targetUser)
      return res.status(404).json({ message: "Technician not found" });

    // Branch admin: target technician must belong to their branch.
    if (isBranchAdmin(req) && targetUser.branch !== req.user.branch) {
      return res.status(403).json({
        message: "Access denied: This technician is not in your branch.",
      });
    }

    const [entries, total] = await Promise.all([
      Entry.find({ userId })
        .sort({ date: -1 })
        .skip((page - 1) * limit)
        .limit(limit),
      Entry.countDocuments({ userId }),
    ]);

    res.json({
      user:  targetUser,
      entries,
      total,
      page,
      pages: Math.ceil(total / limit),
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// PUT /api/admin/entry/:id
// ─────────────────────────────────────────────────────────────────────────────
const editEntry = async (req, res) => {
  try {
    // Read-before-mutate: fetch first to get branch for ownership check.
    const entry = await Entry.findById(req.params.id);
    if (!entry) return res.status(404).json({ message: "Entry not found" });

    if (isBranchAdmin(req) && entry.branch !== req.user.branch) {
      return res.status(403).json({
        message: "Access denied: This entry does not belong to your branch.",
      });
    }

    // FIX Bug 2: Allowlist — only these fields can be changed by admin.
    // Excluded (intentionally immutable via this route):
    //   userId       — entry ownership must never change
    //   branch       — branch is inherited from the user; use editUser to change
    //   date         — changing dates moves entries between months/quarters,
    //                  corrupting historical incentive calculations
    //   incentive    — always computed server-side on demand; never stored directly
    //   technicianType — synced from user profile; use editUser to change
    //
    // Before this fix, `req.body` went straight into findByIdAndUpdate, allowing
    // any field to be overwritten — including incentive and userId.
    const { category, vehicleNo, jcNo, hoursWorked, labourAmount, leaveDays } = req.body;
    const updates = {};

    if (category     !== undefined) updates.category     = category;
    if (vehicleNo    !== undefined) updates.vehicleNo    = vehicleNo?.trim() || "";
    if (jcNo         !== undefined) updates.jcNo         = jcNo?.trim();
    if (hoursWorked  !== undefined) updates.hoursWorked  = Number(hoursWorked)  || 0;
    if (labourAmount !== undefined) updates.labourAmount = Number(labourAmount) || 0;
    if (leaveDays    !== undefined) updates.leaveDays    = Number(leaveDays)    || 0;

    const updated = await Entry.findByIdAndUpdate(req.params.id, updates, {
      new:           true,
      runValidators: true, // schema max/min/enum validators fire here
    });

    res.json(updated);
  } catch (err) {
    // FIX: Return 400 for Mongoose validation failures (e.g. schema max exceeded)
    // instead of the generic 500, so the frontend can surface the real message.
    if (err.name === "ValidationError") {
      const messages = Object.values(err.errors).map((e) => e.message);
      return res.status(400).json({ message: messages.join(", ") });
    }
    res.status(500).json({ message: err.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /api/admin/entry/:id
// ─────────────────────────────────────────────────────────────────────────────
const deleteEntry = async (req, res) => {
  try {
    const entry = await Entry.findById(req.params.id);
    if (!entry) return res.status(404).json({ message: "Entry not found" });

    if (isBranchAdmin(req) && entry.branch !== req.user.branch) {
      return res.status(403).json({
        message: "Access denied: This entry does not belong to your branch.",
      });
    }

    await Entry.findByIdAndDelete(req.params.id);
    res.json({ message: "Entry deleted by admin" });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/admin/technician/:userId/export
// ─────────────────────────────────────────────────────────────────────────────
const exportTechnicianData = async (req, res) => {
  try {
    const { userId } = req.params;

    const targetUser = await User.findById(userId).select("-password");
    if (!targetUser)
      return res.status(404).json({ message: "Technician not found" });

    if (isBranchAdmin(req) && targetUser.branch !== req.user.branch) {
      return res.status(403).json({
        message: "Access denied: This technician is not in your branch.",
      });
    }

    const entries = await Entry.find({ userId }).sort({ date: -1 });
    res.json({ user: targetUser, entries });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/admin/analytics
// ─────────────────────────────────────────────────────────────────────────────
const getAnalytics = async (req, res) => {
  try {
    const { from, to } = req.query;

    // Branch scoping:
    //   Superadmin → optional ?branch= filter, or all
    //   Branch admin → always forced to req.user.branch; query param is ignored
    const branch = isBranchAdmin(req) ? req.user.branch : req.query.branch;

    const matchStage = {};
    if (branch) matchStage.branch = branch;
    if (from || to) {
      matchStage.date = {};
      if (from) matchStage.date.$gte = new Date(from);
      if (to)   matchStage.date.$lte = new Date(to + "T23:59:59.999Z");
    }

    const [overviewArr, byBranch, byCategory, byMonth, topTechs] =
      await Promise.all([

        Entry.aggregate([
          { $match: matchStage },
          {
            $group: {
              _id:             null,
              totalLabour:     { $sum: "$labourAmount" },
              totalHours:      { $sum: "$hoursWorked" },
              totalIncentives: { $sum: "$incentive" },
              totalLeaveDays:  { $sum: "$leaveDays" },
              totalEntries:    { $sum: 1 },
            },
          },
        ]),

        Entry.aggregate([
          { $match: matchStage },
          {
            $group: {
              _id:             "$branch",
              totalLabour:     { $sum: "$labourAmount" },
              totalHours:      { $sum: "$hoursWorked" },
              totalIncentives: { $sum: "$incentive" },
              totalEntries:    { $sum: 1 },
              totalLeaveDays:  { $sum: "$leaveDays" },
            },
          },
          { $sort: { totalLabour: -1 } },
        ]),

        Entry.aggregate([
          { $match: matchStage },
          {
            $group: {
              _id:         "$category",
              totalLabour: { $sum: "$labourAmount" },
              totalHours:  { $sum: "$hoursWorked" },
              count:       { $sum: 1 },
            },
          },
          { $sort: { totalLabour: -1 } },
        ]),

        Entry.aggregate([
          { $match: matchStage },
          {
            $group: {
              _id: {
                year:  { $year:  "$date" },
                month: { $month: "$date" },
              },
              totalLabour:     { $sum: "$labourAmount" },
              totalHours:      { $sum: "$hoursWorked" },
              totalIncentives: { $sum: "$incentive" },
              totalEntries:    { $sum: 1 },
            },
          },
          { $sort: { "_id.year": 1, "_id.month": 1 } },
          { $limit: 12 },
        ]),

        Entry.aggregate([
          { $match: matchStage },
          {
            $group: {
              _id:          "$userId",
              totalLabour:  { $sum: "$labourAmount" },
              totalHours:   { $sum: "$hoursWorked" },
              totalEntries: { $sum: 1 },
              branch:       { $first: "$branch" },
            },
          },
          { $sort: { totalLabour: -1 } },
          { $limit: 10 },
          {
            $lookup: {
              from:         "users",
              localField:   "_id",
              foreignField: "_id",
              as:           "userInfo",
            },
          },
          { $unwind: "$userInfo" },
          {
            $project: {
              totalLabour:  1,
              totalHours:   1,
              totalEntries: 1,
              branch:       1,
              name:         "$userInfo.name",
              technicianId: "$userInfo.technicianId",
            },
          },
        ]),
      ]);

    const MONTH_NAMES = [
      "Jan","Feb","Mar","Apr","May","Jun",
      "Jul","Aug","Sep","Oct","Nov","Dec",
    ];

    res.json({
      overview: overviewArr[0] || {
        totalLabour: 0, totalHours: 0, totalIncentives: 0,
        totalLeaveDays: 0, totalEntries: 0,
      },
      byBranch,
      byCategory,
      byMonth: byMonth.map((m) => ({
        label:           `${MONTH_NAMES[m._id.month - 1]} ${String(m._id.year).slice(2)}`,
        totalLabour:     m.totalLabour,
        totalHours:      m.totalHours,
        totalIncentives: m.totalIncentives,
        totalEntries:    m.totalEntries,
      })),
      topTechs,
      scopedBranch: isBranchAdmin(req) ? req.user.branch : null,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Analytics fetch failed" });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// PUT /api/admin/user/:userId  ← SUPERADMIN ONLY
// Editable: name, technicianId, branch, technicianType
// Never:    email, password, role
// ─────────────────────────────────────────────────────────────────────────────
const editUser = async (req, res) => {
  try {
    const { userId } = req.params;
    const { name, technicianId, branch, technicianType } = req.body;

    const VALID_TYPES = [
      "MECHANIC", "MECHANIC HELPER", "ELECTRICIAN", "ELECTRICIAN HELPER",
    ];

    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ message: "User not found" });

    if (user.role !== "technician") {
      return res.status(403).json({
        message: "Only technician accounts can be edited via this route.",
      });
    }

    if (technicianType && !VALID_TYPES.includes(technicianType)) {
      return res.status(400).json({ message: "Invalid technician type." });
    }

    // FIX Bug 10: Validate branch against known list before accepting.
    // Previously any string was accepted, which could create users with
    // branches that no admin manages and that never appear in any dropdown.
    if (branch !== undefined) {
      const trimmedBranch = branch.trim();
      if (!VALID_BRANCHES.includes(trimmedBranch)) {
        return res.status(400).json({
          message: `Invalid branch. Valid options: ${VALID_BRANCHES.join(", ")}`,
        });
      }
    }

    const updates = {};
    if (name          !== undefined) updates.name          = name.trim();
    if (technicianId  !== undefined) updates.technicianId  = technicianId.trim();
    if (branch        !== undefined) updates.branch        = branch.trim();
    if (technicianType !== undefined) updates.technicianType = technicianType || null;

    const updatedUser = await User.findByIdAndUpdate(userId, updates, { new: true }).select("-password");

    // If branch changed → cascade to entries AND attendance records.
    // FIX Bug 6: Previously only entries were cascaded. Attendance records
    // kept the old branch, causing the admin attendance board to show the
    // moved technician as "absent" on all historical dates.
    if (updates.branch && updates.branch !== user.branch) {
      await Entry.updateMany({ userId }, { $set: { branch: updates.branch } });
      await Attendance.updateMany({ userId }, { $set: { branch: updates.branch } }); // FIX Bug 6
    }

    // If technicianType changed → cascade to all entries
    if ("technicianType" in updates && updates.technicianType !== user.technicianType) {
      await Entry.updateMany({ userId }, { $set: { technicianType: updates.technicianType } });
    }

    res.json(updatedUser);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /api/admin/user/:userId  ← SUPERADMIN ONLY
// Deletes the user account + all their job card entries + attendance records
// ─────────────────────────────────────────────────────────────────────────────
const deleteUser = async (req, res) => {
  try {
    const { userId } = req.params;

    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ message: "User not found" });

    if (user.role !== "technician") {
      return res.status(403).json({
        message: "Only technician accounts can be deleted via this route.",
      });
    }

    // FIX Bug 5: Cascade to Attendance records.
    // Previously only Entry records were deleted. Attendance records were left
    // as orphaned documents with a userId pointing to a non-existent user.
    // The monthly cron only removes records older than 1 month, so recent
    // orphans would persist indefinitely.
    await Entry.deleteMany({ userId });
    await Attendance.deleteMany({ userId }); // FIX Bug 5
    await user.deleteOne();

    res.json({ message: "Technician and all their entries have been deleted." });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

module.exports = {
  getBranches,
  getBranchDashboard,
  getBranchTechnicians,
  getTechnicianEntries,
  editEntry,
  deleteEntry,
  exportTechnicianData,
  getAnalytics,
  editUser,
  deleteUser,
};