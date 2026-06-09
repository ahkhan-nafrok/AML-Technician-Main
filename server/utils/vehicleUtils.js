/**
 * vehicleUtils.js — shared vehicle number normalization
 *
 * Single source of truth for how vehicle numbers are normalized before
 * storing or comparing. Used in:
 *   - SecurityLog controller (POST + PUT) — compute vehicleNoNorm before save
 *   - Entry controller (POST)             — compute vehicleNoNorm before save
 *   - SecurityLog board query             — normalize search query before regex
 *
 * Mirror: client/src/utils/vehicleUtils.js (identical logic, ES module export)
 */

/**
 * normalizeVehicleNo(raw)
 *
 * Strips all hyphens and spaces, uppercases the result.
 * "KA-01-AB-1234" → "KA01AB1234"
 * "ka 01 ab 1234" → "KA01AB1234"
 * "KA01AB1234"    → "KA01AB1234"
 * null / ""       → ""
 *
 * This function must be called:
 *   - On SecurityLog create AND edit (vehicleNoNorm stored on the document)
 *   - On Entry create AND edit        (vehicleNoNorm stored on the document)
 *   - On board search queries         (normalize the q param before regex)
 *
 * Never query vehicleNoNorm with the raw input — always normalize first.
 */
function normalizeVehicleNo(raw) {
  if (!raw) return "";
  return raw.replace(/[-\s]/g, "").toUpperCase().trim();
}

module.exports = { normalizeVehicleNo };