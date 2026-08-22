import jwt from "jsonwebtoken";

const JWT_Secret = process.env.JWT_Secret;

/**
 * Default 7 days for the owner mobile app (longer-lived than staff sessions).
 * Accepts "7d", "24h", or a seconds integer >= 3600.
 */
function resolveJwtExpiresIn() {
  const raw = process.env.OWNER_JWT_EXPIRES_IN ?? process.env.JWT_EXPIRES_IN;
  if (raw == null || String(raw).trim() === "") return "7d";
  const s = String(raw).trim();
  if (/^\d+[smhdw]$/i.test(s)) return s;
  if (/^\d+$/.test(s)) {
    const n = Number(s);
    if (n >= 3600) return n;
    return "7d";
  }
  return s;
}

export const OWNER_JWT_EXPIRES_IN = resolveJwtExpiresIn();

if (!JWT_Secret || String(JWT_Secret).trim() === "") {
  console.error(
    "[hotcol-owner] JWT_Secret is missing — owner tokens will fail verification. Set JWT_Secret in the environment.",
  );
}

/** Sign an owner session token. */
export function signOwnerToken(owner) {
  return jwt.sign(
    {
      ownerId: owner.id,
      UserName: owner.UserName,
      kind: "owner",
    },
    JWT_Secret,
    { expiresIn: OWNER_JWT_EXPIRES_IN },
  );
}

/** Parse + verify the bearer token from an Express request. */
export function authenticateOwner(req) {
  const authHeader = req.headers.authorization;
  if (!authHeader) return null;
  const token = authHeader.replace("Bearer ", "");
  try {
    const decoded = jwt.verify(token, JWT_Secret);
    if (decoded?.kind !== "owner") return null;
    return decoded;
  } catch (err) {
    if (err?.name === "TokenExpiredError") {
      return { __authExpired: true };
    }
    return null;
  }
}

/** Throws if the request context is not a valid, non-expired owner session. */
export function assertOwner(context) {
  if (!context.owner) throw new Error("Not Authenticated");
  if (context.owner.__authExpired) throw new Error("Session expired");
  if (!context.owner.ownerId) throw new Error("Not Authenticated");
}
