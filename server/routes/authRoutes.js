const express = require("express");
const router  = express.Router();
const { signup, login, profileSetup, typeSetup, getMe } = require("../controllers/authController");
const { protect } = require("../middleware/authMiddleware");

router.post("/signup",       signup);
router.post("/login",        login);
router.put("/profile-setup", protect, profileSetup);
router.put("/type-setup",    protect, typeSetup);  // ← NEW: one-time for existing technicians
router.get("/me",            protect, getMe);

module.exports = router;