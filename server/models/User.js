const mongoose = require("mongoose");

const userSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, "Name is required"],
      trim: true,
    },
    email: {
      type: String,
      required: [true, "Email is required"],
      unique: true,
      lowercase: true,
      trim: true,
    },
    password: {
      type: String,
      required: [true, "Password is required"],
      minlength: 6,
    },
    role: {
      type: String,
      // "superadmin" → all branches, set branch: "all" in MongoDB
      // "admin"      → one branch only, set branch: "<BranchName>" in MongoDB
      // "technician" → default, self-signup
      enum: ["technician", "admin", "superadmin"],
      default: "technician",
    },
    technicianId: {
      type: String,
      default: "",
    },
    branch: {
      type: String,
      default: "",
      // For superadmin: set to "all" in MongoDB
      // For admin:      set to the exact branch string (e.g. "Chennai")
      // For technician: filled via profile-setup modal
    },
    profileComplete: {
      type: Boolean,
      default: false,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("User", userSchema);