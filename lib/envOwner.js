import "dotenv/config";

/**
 * Temporary owner sourced from the .env file.
 *
 * This lets you sign in to the owner app and view real property data BEFORE
 * any `owner_account` rows exist in the database. As soon as you seed real
 * owners (`npm run seed:owner`) those DB accounts take precedence; the env
 * owner is only used as a fallback and only when OWNER_PASSWORD is set.
 *
 * Configure in .env:
 *   OWNER_USERNAME, OWNER_PASSWORD (plain text), OWNER_NAME,
 *   OWNER_EMAIL, OWNER_PHONE, OWNER_TINS (comma separated property TINs)
 */

/** Sentinel id for the env owner (no DB row). Real owners use positive ids. */
export const ENV_OWNER_ID = -1;

export function isEnvOwnerId(id) {
  return Number(id) === ENV_OWNER_ID;
}

export function envOwnerTins() {
  return String(process.env.OWNER_TINS || "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
}

/** Returns the configured env owner, or null when not enabled. */
export function getEnvOwner() {
  const UserName = String(process.env.OWNER_USERNAME || "").trim();
  const Password = process.env.OWNER_PASSWORD || "";
  if (!UserName || !Password) return null;

  return {
    id: ENV_OWNER_ID,
    UserName,
    Password,
    displayName: String(process.env.OWNER_NAME || "Property Owner").trim() || null,
    email: String(process.env.OWNER_EMAIL || "").trim() || null,
    phone: String(process.env.OWNER_PHONE || "").trim() || null,
    isActive: true,
    tins: envOwnerTins(),
  };
}

/** Validates credentials against the env owner. Returns the owner or null. */
export function verifyEnvOwner(userName, password) {
  const owner = getEnvOwner();
  if (!owner) return null;
  if (owner.UserName !== String(userName).trim()) return null;
  if (owner.Password !== String(password)) return null;
  return owner;
}
