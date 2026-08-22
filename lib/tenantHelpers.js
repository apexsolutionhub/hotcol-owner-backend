import { prisma } from "./prisma.js";
import { parseModulesJson } from "./subscriptionPricing.js";
import { tenantBillingRowFromOwner } from "./tenantBilling.js";

export async function findTenantOwner(tinNumber) {
  const tin = String(tinNumber || "").trim();
  if (!tin) return null;
  return prisma.user.findFirst({
    where: { tinNumber: tin, Role: { in: ["Admin", "Manager"] } },
    orderBy: { id: "asc" },
  });
}

export async function ensureTenantAccount(tinNumber, owner) {
  const tin = String(tinNumber).trim();
  let account = await prisma.tenant_account.findUnique({ where: { tinNumber: tin } });
  if (account) return account;

  return prisma.tenant_account.create({
    data: {
      tinNumber: tin,
      hotelDisplayName: owner?.HotelName ?? tin,
      businessType: owner?.businessType ?? null,
      logoUrl: owner?.LogoUrl ?? null,
      modules: owner?.modules ?? [],
      accountStatus: "active",
    },
  });
}

export function ownerToBillingSnapshot(owner) {
  return tenantBillingRowFromOwner(owner);
}

export async function loadTenantAccountsByTin(tins) {
  if (!tins.length) return new Map();
  const rows = await prisma.tenant_account.findMany({
    where: { tinNumber: { in: tins } },
  });
  return new Map(rows.map((r) => [r.tinNumber, r]));
}

export function accountOrOwnerFallback(account, owner, tin) {
  if (account) return account;
  return {
    tinNumber: tin,
    hotelDisplayName: owner?.HotelName ?? tin,
    accountStatus: "active",
  };
}

export async function tenantUsersForTin(tinNumber) {
  return prisma.user.findMany({
    where: { tinNumber: tinNumber },
    orderBy: [{ Role: "asc" }, { UserName: "asc" }],
    select: {
      id: true,
      UserName: true,
      Role: true,
      loginDisabled: true,
      loginDisabledReason: true,
      createdAt: true,
    },
  });
}

export function modulesArrayToJson(modules) {
  return parseModulesJson(modules);
}
