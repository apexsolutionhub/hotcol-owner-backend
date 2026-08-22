import bcrypt from "bcryptjs";
import "dotenv/config";
import { prisma } from "../lib/prisma.js";

/**
 * Create / update an owner account and link the property TINs they oversee.
 *
 * Configure via env (.env) or CLI flags:
 *   OWNER_SEED_USERNAME / --user
 *   OWNER_SEED_PASSWORD / --password   (min 6 chars)
 *   OWNER_SEED_NAME     / --name
 *   OWNER_SEED_TINS     / --tins       (comma separated property TINs)
 *
 * Example:
 *   node scripts/seedOwner.js --user abel --password Secret123 --tins 0012345678,0098765432
 */
function argFlag(name) {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx >= 0 && idx + 1 < process.argv.length) return process.argv[idx + 1];
  return undefined;
}

async function main() {
  const userName = (argFlag("user") || process.env.OWNER_SEED_USERNAME || "owner").trim();
  const password = argFlag("password") || process.env.OWNER_SEED_PASSWORD;
  const displayName = (argFlag("name") || process.env.OWNER_SEED_NAME || "Property Owner").trim();
  const tinsRaw = argFlag("tins") || process.env.OWNER_SEED_TINS || "";

  if (!password || String(password).length < 6) {
    throw new Error(
      "Set a password (min 6 chars) via --password or OWNER_SEED_PASSWORD.",
    );
  }

  const tins = tinsRaw
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);

  const hash = await bcrypt.hash(password, 12);
  const owner = await prisma.owner_account.upsert({
    where: { UserName: userName },
    create: { UserName: userName, Password: hash, displayName, isActive: true },
    update: { Password: hash, displayName, isActive: true },
  });

  console.log(`Owner ready: ${owner.UserName} (id ${owner.id})`);

  for (const tin of tins) {
    const tenantOwner = await prisma.user.findFirst({
      where: { tinNumber: tin, Role: { in: ["Admin", "Manager"] } },
      orderBy: { id: "asc" },
    });
    if (!tenantOwner) {
      console.warn(`  ! No Admin/Manager found for TIN ${tin} — linking anyway`);
    } else {
      console.log(`  + Linking ${tenantOwner.HotelName} (TIN ${tin})`);
    }
    await prisma.owner_property.upsert({
      where: { ownerId_tinNumber: { ownerId: owner.id, tinNumber: tin } },
      create: { ownerId: owner.id, tinNumber: tin },
      update: {},
    });
  }

  const count = await prisma.owner_property.count({ where: { ownerId: owner.id } });
  console.log(`Owner now oversees ${count} propert${count === 1 ? "y" : "ies"}.`);
  console.log("Sign in to the owner app with this username and password.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
