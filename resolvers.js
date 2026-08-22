import bcrypt from "bcryptjs";
import { DateTimeResolver, GraphQLJSON } from "graphql-scalars";
import { prisma } from "./lib/prisma.js";
import { signOwnerToken, assertOwner } from "./lib/auth.js";
import { parseModulesJson } from "./lib/subscriptionPricing.js";
import {
  tenantBillingRowFromOwner,
  computeSubscriptionPeriodStatus,
  subscriptionAllowsFullSystemAccess,
  resolveBillingAnchor,
  trialPaymentDeadline,
} from "./lib/tenantBilling.js";
import {
  computeSubscriptionPaidUntil,
  subscriptionRenewalAmountETB,
  subscriptionRenewalPaymentKind,
  normalizeRenewalPaymentKind,
} from "./lib/subscriptionBillingPeriod.js";
import {
  findTenantOwner,
  ensureTenantAccount,
  loadTenantAccountsByTin,
  accountOrOwnerFallback,
} from "./lib/tenantHelpers.js";
import {
  loadTenantOperationalSnapshot,
  loadApprovalPipelineCounts,
  loadLodgingSnapshot,
  loadCafeOpsSnapshot,
  buildModuleHealth,
} from "./lib/monitoringHelpers.js";
import { departmentLabel } from "./lib/departmentLabels.js";
import {
  ownedPropertyRows,
  ownedTins,
  assertOwnsTin,
  countOwnerProperties,
  hotelKeysForTin,
  hotelKeysByTinMap,
  tenantOwnersByTinMap,
  loadTenantRevenueSnapshot,
  loadCafePeriodReport,
  roleAllowedForModules,
  OWNER_MANAGEABLE_ROLES,
} from "./lib/ownerHelpers.js";
import { getEnvOwner, isEnvOwnerId, verifyEnvOwner } from "./lib/envOwner.js";

const ATTENTION_STATUSES = new Set([
  "trial_expired",
  "setup_pending",
  "pending_approval",
  "grace",
  "expired",
]);
const BLOCKED_ACCOUNT_STATUSES = new Set(["suspended", "banned"]);

const ROLE_MODULE_MAP = {
  Kitchen: "Cafe and Restaurant",
  Barista: "Cafe and Restaurant",
  Cashier: "Cafe and Restaurant",
  Store: "Inventory",
  CostControl: "Financial Management",
  Finance: "Financial Management",
  HotelCashier: "Credit Management",
  Reception: "Room Management",
  CMLeader: "Cleaning and Maintenance",
};

function computeAllowedRoles(modules) {
  if (!Array.isArray(modules) || modules.length === 0) return OWNER_MANAGEABLE_ROLES;
  return OWNER_MANAGEABLE_ROLES.filter((role) => {
    const required = ROLE_MODULE_MAP[role];
    return !required || modules.includes(required);
  });
}

function billingInfoFromOwner(owner, pendingPaymentKind = null) {
  const sub = tenantBillingRowFromOwner(owner);
  const status = computeSubscriptionPeriodStatus(sub);

  let paidUntil = owner.subscriptionPaidUntil ?? null;
  if (!paidUntil) {
    if (status === "trial" || status === "trial_ending" || status === "trial_expired") {
      const deadline = trialPaymentDeadline(sub);
      if (deadline) paidUntil = deadline;
    } else {
      const anchor = resolveBillingAnchor(sub);
      if (anchor) {
        const paidPeriods = Math.max(1, Number(owner.paidQuartersCount) || 1);
        paidUntil = computeSubscriptionPaidUntil(anchor, paidPeriods, owner.businessType ?? null);
      }
    }
  }

  return {
    subscriptionStatus: status,
    setupFeeETB: owner.setupFeeETB ?? 0,
    quarterlyFeeETB: owner.quarterlyFeeETB ?? 0,
    renewalAmountETB: subscriptionRenewalAmountETB(
      owner.quarterlyFeeETB ?? 0,
      owner.businessType ?? null,
    ),
    renewalKind: subscriptionRenewalPaymentKind(owner.businessType ?? null),
    setupFeeApproved: Boolean(owner.setupFeeApproved),
    subscriptionPaymentApproved: Boolean(owner.subscriptionPaymentApproved),
    subscriptionPaidUntil: paidUntil,
    paidQuartersCount: owner.paidQuartersCount ?? 0,
    billingHold: Boolean(owner.billingHold),
    isIllustrationTenant: Boolean(owner.isIllustrationTenant),
    freeTrialEndsAt: owner.freeTrialEndsAt ?? null,
    pendingPaymentKind,
  };
}

function tenantAccessState(tenantOwner, account) {
  const accountStatus = String(account?.accountStatus ?? "active").trim().toLowerCase();
  const subscriptionStatus = tenantOwner
    ? computeSubscriptionPeriodStatus(tenantBillingRowFromOwner(tenantOwner))
    : "active";

  if (BLOCKED_ACCOUNT_STATUSES.has(accountStatus)) {
    return {
      subscriptionStatus,
      accessBlocked: true,
      accessBlockReason:
        accountStatus === "banned"
          ? "This property account is banned. Submit payment details if applicable and contact HotCol support for reactivation."
          : "This property account is suspended. Submit payment details and contact HotCol support for reactivation.",
    };
  }

  if (!subscriptionAllowsFullSystemAccess(subscriptionStatus)) {
    const messages = {
      on_hold:
        "This property is on billing hold. Operations and staff logins stay locked until Apex releases the hold.",
      trial_expired:
        "The free trial has ended. Submit the setup payment for approval to restore access.",
      setup_pending:
        "Setup payment approval is pending. Operations remain locked until HotCol verifies the payment.",
      pending_approval:
        "A subscription payment is awaiting HotCol approval. Operations remain locked during verification.",
      grace:
        "The subscription renewal is due. Submit payment for approval to restore operational access.",
      expired:
        "The subscription and grace period have ended. Submit payment for approval to restore access.",
    };
    return {
      subscriptionStatus,
      accessBlocked: true,
      accessBlockReason:
        messages[subscriptionStatus] ||
        "This property cannot access operations until its account is approved.",
    };
  }

  return { subscriptionStatus, accessBlocked: false, accessBlockReason: null };
}

async function assertOperationalAccess(ownerId, tinNumber) {
  const tin = await assertOwnsTin(ownerId, tinNumber);
  const tenantOwner = await findTenantOwner(tin);
  const account = accountOrOwnerFallback(
    await prisma.tenant_account.findUnique({ where: { tinNumber: tin } }),
    tenantOwner,
    tin,
  );
  const access = tenantAccessState(tenantOwner, account);
  if (access.accessBlocked) {
    throw new Error(access.accessBlockReason || "Property operations are locked");
  }
  return { tin, tenantOwner, account, access };
}

async function loadOwnerRecord(ownerId) {
  if (isEnvOwnerId(ownerId)) {
    const envOwner = getEnvOwner();
    if (!envOwner) throw new Error("Owner account is inactive");
    return envOwner;
  }
  let owner;
  try {
    owner = await prisma.owner_account.findUnique({ where: { id: ownerId } });
  } catch (err) {
    if (!String(err?.message || "").includes("does not exist")) throw err;
    throw new Error("Owner account is inactive");
  }
  if (!owner || !owner.isActive) throw new Error("Owner account is inactive");
  return owner;
}

export const resolvers = {
  DateTime: DateTimeResolver,
  JSON: GraphQLJSON,

  Query: {
    ownerMe: async (_, __, context) => {
      assertOwner(context);
      const owner = await loadOwnerRecord(context.owner.ownerId);
      const propertyCount = await countOwnerProperties(owner.id);
      return {
        id: owner.id,
        UserName: owner.UserName,
        displayName: owner.displayName,
        phone: owner.phone,
        email: owner.email,
        propertyCount,
      };
    },

    portfolio: async (_, __, context) => {
      assertOwner(context);
      const props = await ownedPropertyRows(context.owner.ownerId);
      const tins = props.map((p) => String(p.tinNumber).trim()).filter(Boolean);

      const [accountMap, ownerMap, keysMap] = await Promise.all([
        loadTenantAccountsByTin(tins),
        tenantOwnersByTinMap(tins),
        hotelKeysByTinMap(tins),
      ]);

      const properties = await Promise.all(
        props.map(async (prop) => {
          const tin = String(prop.tinNumber).trim();
          const owner = ownerMap.get(tin) ?? null;
          const account = accountOrOwnerFallback(accountMap.get(tin), owner, tin);
          const bt = owner?.businessType ?? account.businessType ?? null;
          const modules = parseModulesJson(owner?.modules ?? account.modules);
          const access = tenantAccessState(owner, account);
          const hasRooms = modules.includes("Room Management");
          const hasCm = modules.includes("Cleaning and Maintenance");
          const hasCafe = modules.includes("Cafe and Restaurant");
          const hasApprovals =
            modules.includes("Inventory") || modules.includes("Financial Management");

          if (access.accessBlocked) {
            return {
              tinNumber: tin,
              label: prop.label ?? null,
              hotelDisplayName: account.hotelDisplayName,
              businessType: bt,
              logoUrl: account.logoUrl ?? owner?.LogoUrl ?? null,
              accountStatus: account.accountStatus,
              subscriptionStatus: access.subscriptionStatus,
              accessBlocked: true,
              accessBlockReason: access.accessBlockReason,
              modules,
              todayRevenueETB: 0,
              monthRevenueETB: 0,
              openOrders: 0,
              pendingApprovals: 0,
              staffCount: 0,
              needsAttention: true,
              occupancyPct: null,
              vacantDirty: null,
              openCmAssignments: null,
              activeStays: null,
            };
          }

          const keys = keysMap.get(tin) ?? [tin];
          const [revenue, operational, lodging] = await Promise.all([
            hasCafe
              ? loadTenantRevenueSnapshot(keys)
              : Promise.resolve({
                  todayRevenueETB: 0,
                  monthRevenueETB: 0,
                  todayOrders: 0,
                  todayCashETB: 0,
                  todayBankETB: 0,
                  todayCreditETB: 0,
                  categories: [],
                }),
            loadTenantOperationalSnapshot(tin),
            hasRooms || hasCm ? loadLodgingSnapshot(keys) : Promise.resolve(null),
          ]);

          const subStatus = access.subscriptionStatus;
          const propPendingApprovals = hasApprovals
            ? operational.pendingPurchaseRequests +
              operational.pendingStockOutRequests +
              operational.pendingItemRegistrations
            : 0;
          const needsAttention =
            ATTENTION_STATUSES.has(subStatus) ||
            account.accountStatus === "suspended" ||
            account.accountStatus === "banned";

          return {
            tinNumber: tin,
            label: prop.label ?? null,
            hotelDisplayName: account.hotelDisplayName,
            businessType: bt,
            logoUrl: account.logoUrl ?? owner?.LogoUrl ?? null,
            accountStatus: account.accountStatus,
            subscriptionStatus: subStatus,
            accessBlocked: false,
            accessBlockReason: null,
            modules,
            todayRevenueETB:
              revenue.todayRevenueETB +
              (lodging && (hasRooms || hasCm)
                ? lodging.todayRoomRevenueETB +
                  lodging.todayFoodDrinkETB +
                  lodging.todayLaundryETB +
                  lodging.todayOtherServicesETB
                : 0),
            monthRevenueETB:
              revenue.monthRevenueETB +
              (lodging && (hasRooms || hasCm) ? lodging.monthStayRevenueETB : 0),
            openOrders: hasCafe ? operational.openOrders : 0,
            pendingApprovals: propPendingApprovals,
            staffCount: operational.staffCount,
            needsAttention,
            occupancyPct: hasRooms ? lodging?.occupancyPct ?? null : null,
            vacantDirty: hasRooms || hasCm ? lodging?.vacantDirty ?? null : null,
            openCmAssignments: hasCm ? lodging?.openCmAssignments ?? null : null,
            activeStays: hasRooms ? lodging?.activeStays ?? null : null,
            _hasRooms: hasRooms,
            _hasCm: hasCm,
            _hasCafe: hasCafe,
            _lodging: lodging,
            _revenue: revenue,
          };
        }),
      );

      let todayRevenueETB = 0;
      let monthRevenueETB = 0;
      let openOrders = 0;
      let pendingApprovals = 0;
      let attentionCount = 0;
      let occupiedRooms = 0;
      let openCmJobs = 0;

      const cleaned = properties.map((p) => {
        if (p.needsAttention) attentionCount += 1;
        if (!p.accessBlocked) {
          todayRevenueETB += p.todayRevenueETB;
          monthRevenueETB += p.monthRevenueETB;
          openOrders += p.openOrders;
          pendingApprovals += p.pendingApprovals;
          if (p._hasRooms && p._lodging) occupiedRooms += p._lodging.occupied;
          if (p._hasCm && p._lodging) openCmJobs += p._lodging.openCmAssignments;
        }
        const {
          _hasRooms,
          _hasCm,
          _hasCafe,
          _lodging,
          _revenue,
          ...rest
        } = p;
        return rest;
      });

      return {
        propertyCount: cleaned.length,
        todayRevenueETB,
        monthRevenueETB,
        openOrders,
        pendingApprovals,
        attentionCount,
        occupiedRooms,
        openCmJobs,
        properties: cleaned,
      };
    },

    propertyDashboard: async (_, { tinNumber }, context) => {
      assertOwner(context);
      const tin = await assertOwnsTin(context.owner.ownerId, tinNumber);
      const owner = await findTenantOwner(tin);
      const account = accountOrOwnerFallback(
        await prisma.tenant_account.findUnique({ where: { tinNumber: tin } }),
        owner,
        tin,
      );
      const bt = owner?.businessType ?? account.businessType ?? null;
      const modules = parseModulesJson(owner?.modules ?? account.modules);
      const access = tenantAccessState(owner, account);
      const hasRooms = modules.includes("Room Management");
      const hasCm = modules.includes("Cleaning and Maintenance");
      const hasCafe = modules.includes("Cafe and Restaurant");
      const hasInventory = modules.includes("Inventory");

      if (access.accessBlocked) {
        const pendingPayment = await prisma.tenant_payment_submission.findFirst({
          where: { tinNumber: tin, status: "pending" },
          orderBy: { submittedAt: "desc" },
          select: { paymentKind: true },
        });
        return {
          tinNumber: tin,
          hotelDisplayName: account.hotelDisplayName,
          businessType: bt,
          logoUrl: account.logoUrl ?? owner?.LogoUrl ?? null,
          accountStatus: account.accountStatus,
          subscriptionStatus: access.subscriptionStatus,
          accessBlocked: true,
          accessBlockReason: access.accessBlockReason,
          modules,
          allowedRoles: [],
          revenue: {
            todayRevenueETB: 0,
            monthRevenueETB: 0,
            todayOrders: 0,
            todayCashETB: 0,
            todayBankETB: 0,
            todayCreditETB: 0,
            categories: [],
          },
          operational: {
            staffCount: 0,
            ordersToday: 0,
            openOrders: 0,
            pendingPurchaseRequests: 0,
            pendingStockOutRequests: 0,
            pendingItemRegistrations: 0,
            purchaseRequestPipeline: null,
            stockOutRequestPipeline: null,
            itemRegistrationPipeline: null,
          },
          lodging: null,
          cafeOps: null,
          cafeAnalytics: null,
          moduleHealth: [],
          billing: owner
            ? billingInfoFromOwner(owner, pendingPayment?.paymentKind ?? null)
            : billingInfoFromOwner({}, pendingPayment?.paymentKind ?? null),
        };
      }

      const keys = await hotelKeysForTin(tin);
      const [revenue, operational, pendingSetup, lodging, cafeOps, inventoryCount] =
        await Promise.all([
          hasCafe
            ? loadTenantRevenueSnapshot(keys)
            : Promise.resolve({
                todayRevenueETB: 0,
                monthRevenueETB: 0,
                todayOrders: 0,
                todayCashETB: 0,
                todayBankETB: 0,
                todayCreditETB: 0,
                categories: [],
              }),
          loadTenantOperationalSnapshot(tin),
          prisma.tenant_payment_submission.findFirst({
            where: { tinNumber: tin, status: "pending" },
            orderBy: { submittedAt: "desc" },
            select: { paymentKind: true },
          }),
          hasRooms || hasCm ? loadLodgingSnapshot(keys) : Promise.resolve(null),
          hasCafe ? loadCafeOpsSnapshot(keys) : Promise.resolve(null),
          hasInventory
            ? prisma.itemRegistration.count({
                where: {
                  HotelName: keys.length === 1 ? keys[0] : { in: keys },
                  approvalStatus: { notIn: ["VOID", "REJECTED"] },
                },
              })
            : Promise.resolve(0),
        ]);

      if (modules.includes("Financial Management") || hasInventory) {
        const pipeline = await loadApprovalPipelineCounts(tin);
        operational.purchaseRequestPipeline = pipeline.purchaseRequestPipeline;
        operational.stockOutRequestPipeline = pipeline.stockOutRequestPipeline;
        operational.itemRegistrationPipeline = pipeline.itemRegistrationPipeline;
      }

      // Null out ops counts that don't apply to unsubscribed modules.
      if (!hasCafe) {
        operational.ordersToday = 0;
        operational.openOrders = 0;
      }
      if (!hasInventory && !modules.includes("Financial Management")) {
        operational.pendingPurchaseRequests = 0;
        operational.pendingStockOutRequests = 0;
        operational.pendingItemRegistrations = 0;
      }

      const moduleHealth = buildModuleHealth({
        modules,
        lodging,
        cafeOps,
        operational,
        inventoryItemCount: inventoryCount,
      });

      const allowedRoles = computeAllowedRoles(modules);

      return {
        tinNumber: tin,
        hotelDisplayName: account.hotelDisplayName,
        businessType: bt,
        logoUrl: account.logoUrl ?? owner?.LogoUrl ?? null,
        accountStatus: account.accountStatus,
        subscriptionStatus: access.subscriptionStatus,
        accessBlocked: false,
        accessBlockReason: null,
        modules,
        allowedRoles,
        revenue,
        operational,
        lodging,
        cafeOps,
        cafeAnalytics: null,
        moduleHealth,
        billing: owner
          ? billingInfoFromOwner(owner, pendingSetup?.paymentKind ?? null)
          : billingInfoFromOwner({}, pendingSetup?.paymentKind ?? null),
      };
    },

    propertyCafeReport: async (_, { tinNumber, period, date }, context) => {
      assertOwner(context);
      const { tin } = await assertOperationalAccess(context.owner.ownerId, tinNumber);
      const owner = await findTenantOwner(tin);
      const modules = parseModulesJson(owner?.modules);
      if (!modules.includes("Cafe and Restaurant")) {
        throw new Error("Café & Restaurant module is not subscribed for this property");
      }
      const keys = await hotelKeysForTin(tin);
      return loadCafePeriodReport(keys, { period, date });
    },

    propertyStaff: async (_, { tinNumber }, context) => {
      assertOwner(context);
      const { tin } = await assertOperationalAccess(context.owner.ownerId, tinNumber);
      return prisma.user.findMany({
        where: { tinNumber: tin },
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
    },

    propertyWaiters: async (_, { tinNumber }, context) => {
      assertOwner(context);
      const { tin } = await assertOperationalAccess(context.owner.ownerId, tinNumber);
      const keys = await hotelKeysForTin(tin);
      const rows = await prisma.waiter.findMany({
        where: { HotelName: keys.length === 1 ? keys[0] : { in: keys } },
        orderBy: { name: "asc" },
      });
      return rows.map((w) => {
        const prices = Array.isArray(w.price) ? w.price : [];
        const served = Array.isArray(w.tablesServed) ? w.tablesServed : [];
        return {
          id: w.id,
          name: w.name,
          sex: w.sex,
          age: w.age,
          experience: w.experience,
          phoneNumber: w.phoneNumber,
          completedOrders: served.length,
          totalSalesETB: prices.reduce((s, p) => s + (Number(p) || 0), 0),
        };
      });
    },

    propertyInventoryPeople: async (_, { tinNumber }, context) => {
      assertOwner(context);
      const { tin } = await assertOperationalAccess(context.owner.ownerId, tinNumber);
      const keys = await hotelKeysForTin(tin);
      const hotelWhere = keys.length === 1 ? keys[0] : { in: keys };

      const [leaders, controllers] = await Promise.all([
        prisma.departmentLeader.findMany({
          where: { HotelName: hotelWhere },
          orderBy: { department: "asc" },
        }),
        prisma.costControllerProfile.findMany({
          where: { HotelName: hotelWhere },
          orderBy: [{ displayName: "asc" }, { id: "asc" }],
        }),
      ]);

      return {
        departmentLeaders: leaders.map((row) => ({
          id: row.id,
          department: row.department,
          departmentLabel: departmentLabel(row.department),
          leaderName: row.leaderName,
        })),
        costControllers: controllers.map((row) => ({
          id: row.id,
          displayName: row.displayName,
          createdAt: row.createdAt,
        })),
      };
    },

    propertyInventory: async (_, { tinNumber, limit }, context) => {
      assertOwner(context);
      const { tin } = await assertOperationalAccess(context.owner.ownerId, tinNumber);
      const keys = await hotelKeysForTin(tin);
      const take = Math.min(Math.max(limit ?? 100, 1), 300);

      const rows = await prisma.itemRegistration.findMany({
        where: {
          HotelName: keys.length === 1 ? keys[0] : { in: keys },
          approvalStatus: { notIn: ["VOID", "REJECTED"] },
        },
        orderBy: { registrationDate: "desc" },
        take,
      });

      const now = Date.now();
      const soonCutoff = now + 14 * 24 * 60 * 60 * 1000;
      let totalValueETB = 0;
      let expiringSoon = 0;

      const items = rows.map((r) => {
        const value = (Number(r.amount) || 0) * (Number(r.unitPrice) || 0);
        totalValueETB += value;
        const exp = r.expireDate ? new Date(r.expireDate).getTime() : null;
        if (exp && exp > now && exp <= soonCutoff) expiringSoon += 1;
        return {
          id: r.id,
          name: r.name,
          category: r.category,
          amount: r.amount,
          measuredBy: r.measuredBy,
          unitPrice: r.unitPrice,
          totalValueETB: value,
          expireDate: r.expireDate,
          supplierName: r.supplierName,
          approvalStatus: r.approvalStatus,
        };
      });

      return {
        itemCount: items.length,
        totalValueETB,
        expiringSoon,
        items,
      };
    },

    propertyPayments: async (_, { tinNumber, limit }, context) => {
      assertOwner(context);
      const tin = await assertOwnsTin(context.owner.ownerId, tinNumber);
      return prisma.tenant_payment_submission.findMany({
        where: { tinNumber: tin },
        orderBy: { submittedAt: "desc" },
        take: Math.min(Math.max(limit ?? 30, 1), 100),
      });
    },
  },

  Mutation: {
    ownerLogin: async (_, { UserName, Password }) => {
      const name = String(UserName).trim();

      // 1. Real DB owner account takes precedence.
      let owner = null;
      try {
        owner = await prisma.owner_account.findUnique({
          where: { UserName: name },
        });
      } catch (err) {
        const msg = String(err?.message || "");
        if (!msg.includes("does not exist")) throw err;
      }
      if (owner && owner.isActive) {
        const valid = await bcrypt.compare(Password, owner.Password);
        if (valid) {
          const token = signOwnerToken(owner);
          const propertyCount = await prisma.owner_property.count({
            where: { ownerId: owner.id },
          });
          return {
            token,
            owner: {
              id: owner.id,
              UserName: owner.UserName,
              displayName: owner.displayName,
              phone: owner.phone,
              email: owner.email,
              propertyCount,
            },
          };
        }
      }

      // 2. Fallback: owner configured in BackEnd/.env (temporary, dev/bootstrap).
      const envOwner = verifyEnvOwner(name, Password);
      if (envOwner) {
        const token = signOwnerToken({ id: envOwner.id, UserName: envOwner.UserName });
        return {
          token,
          owner: {
            id: envOwner.id,
            UserName: envOwner.UserName,
            displayName: envOwner.displayName,
            phone: envOwner.phone,
            email: envOwner.email,
            propertyCount: envOwner.tins.length,
          },
        };
      }

      throw new Error("Invalid username or password");
    },

    ownerChangePassword: async (_, { currentPassword, newPassword }, context) => {
      assertOwner(context);
      if (isEnvOwnerId(context.owner.ownerId)) {
        throw new Error(
          "This owner is configured in the server .env file — change OWNER_PASSWORD there instead.",
        );
      }
      const owner = await loadOwnerRecord(context.owner.ownerId);
      const valid = await bcrypt.compare(currentPassword, owner.Password);
      if (!valid) throw new Error("Current password is incorrect");
      if (String(newPassword).length < 6) {
        throw new Error("New password must be at least 6 characters");
      }
      const hash = await bcrypt.hash(newPassword, 12);
      await prisma.owner_account.update({
        where: { id: owner.id },
        data: { Password: hash },
      });
      return true;
    },

    ownerCreateStaff: async (_, { tinNumber, UserName, Password, Role }, context) => {
      assertOwner(context);
      const { tin } = await assertOperationalAccess(context.owner.ownerId, tinNumber);

      const role = String(Role).trim();
      if (!OWNER_MANAGEABLE_ROLES.includes(role)) {
        throw new Error(
          `Role "${role}" cannot be created from the owner app. Allowed: ${OWNER_MANAGEABLE_ROLES.join(", ")}`,
        );
      }
      if (String(Password).length < 4) {
        throw new Error("Password must be at least 4 characters");
      }

      const userNameNorm = String(UserName).trim();
      const existing = await prisma.user.findUnique({
        where: { UserName: userNameNorm },
      });
      if (existing) {
        throw new Error("Username already exists. Please choose a different username.");
      }

      const tenantOwner = await findTenantOwner(tin);
      if (!tenantOwner) throw new Error("Property owner account not found");

      const modules = parseModulesJson(tenantOwner.modules);
      if (!roleAllowedForModules(role, modules)) {
        throw new Error(
          `Role "${role}" requires a module that is not subscribed for this property`,
        );
      }

      const sub = tenantBillingRowFromOwner(tenantOwner);
      const periodStatus = computeSubscriptionPeriodStatus(sub);
      if (!subscriptionAllowsFullSystemAccess(periodStatus)) {
        throw new Error(
          "Staff credentials cannot be created while subscription payment is pending or in grace renewal.",
        );
      }

      const hashedPassword = await bcrypt.hash(Password, 12);
      const created = await prisma.user.create({
        data: {
          UserName: userNameNorm,
          Password: hashedPassword,
          HotelName: tenantOwner.HotelName,
          tinNumber: tin,
          Role: role,
          LogoUrl: tenantOwner.LogoUrl ?? "",
          businessType: tenantOwner.businessType ?? null,
          modules: tenantOwner.modules ?? modules,
        },
        select: {
          id: true,
          UserName: true,
          Role: true,
          loginDisabled: true,
          loginDisabledReason: true,
          createdAt: true,
        },
      });
      return created;
    },

    ownerSetStaffPassword: async (_, { userId, Password }, context) => {
      assertOwner(context);
      const staff = await prisma.user.findUnique({ where: { id: userId } });
      if (!staff) throw new Error("Staff member not found");
      await assertOperationalAccess(context.owner.ownerId, staff.tinNumber);
      if (["Admin", "Manager"].includes(staff.Role)) {
        throw new Error("Owner cannot change the property administrator password");
      }
      if (String(Password).length < 4) {
        throw new Error("Password must be at least 4 characters");
      }
      const hash = await bcrypt.hash(Password, 12);
      await prisma.user.update({
        where: { id: userId },
        data: { Password: hash },
      });
      return true;
    },

    ownerSetStaffLoginDisabled: async (_, { userId, disabled, reason }, context) => {
      assertOwner(context);
      const staff = await prisma.user.findUnique({ where: { id: userId } });
      if (!staff) throw new Error("Staff member not found");
      await assertOperationalAccess(context.owner.ownerId, staff.tinNumber);
      if (["Admin", "Manager"].includes(staff.Role)) {
        throw new Error("Owner cannot disable the property administrator login");
      }
      const now = new Date();
      await prisma.user.update({
        where: { id: userId },
        data: disabled
          ? {
              loginDisabled: true,
              loginDisabledReason: reason ? String(reason).trim() : "Disabled by owner",
              loginDisabledAt: now,
            }
          : {
              loginDisabled: false,
              loginDisabledReason: null,
              loginDisabledAt: null,
            },
      });
      return true;
    },

    ownerSubmitSubscriptionPayment: async (
      _,
      { tinNumber, paymentKind, paymentChannel, transactionRef },
      context,
    ) => {
      assertOwner(context);
      const tin = await assertOwnsTin(context.owner.ownerId, tinNumber);
      const tenantOwner = await findTenantOwner(tin);
      if (!tenantOwner) throw new Error("Property owner account not found");

      const kind = normalizeRenewalPaymentKind(paymentKind, tenantOwner.businessType);
      const ref = String(transactionRef || "").trim();
      const channel = String(paymentChannel || "").trim();
      if (!ref) throw new Error("Transaction reference is required");
      if (!channel) throw new Error("Payment channel is required");

      const amountETB =
        kind === "setup"
          ? Number(tenantOwner.setupFeeETB ?? 0)
          : subscriptionRenewalAmountETB(
              tenantOwner.quarterlyFeeETB ?? 0,
              tenantOwner.businessType ?? null,
            );

      await prisma.tenant_payment_submission.updateMany({
        where: { tinNumber: tin, paymentKind: kind, status: "pending" },
        data: { status: "rejected" },
      });

      const submission = await prisma.tenant_payment_submission.create({
        data: {
          tinNumber: tin,
          paymentKind: kind,
          amountETB,
          paymentChannel: channel,
          transactionRef: ref,
          status: "pending",
        },
      });

      await ensureTenantAccount(tin, tenantOwner);
      return submission;
    },

    ownerRequestModuleChange: async (
      _,
      { tinNumber, changeType, modules, requestNote },
      context,
    ) => {
      assertOwner(context);
      const tin = await assertOwnsTin(context.owner.ownerId, tinNumber);

      const type = String(changeType || "").trim().toLowerCase();
      if (type !== "add" && type !== "remove") {
        throw new Error("changeType must be add or remove");
      }

      const delta = [
        ...new Set(
          parseModulesJson(modules)
            .map((m) => String(m).trim())
            .filter(Boolean),
        ),
      ];
      if (delta.length === 0) {
        throw new Error("Select at least one module");
      }
      if (delta.includes("Credentials(Common)")) {
        throw new Error("Credentials(Common) cannot be requested or removed");
      }

      const tenantOwner = await findTenantOwner(tin);
      if (!tenantOwner) throw new Error("Property owner account not found");

      const current = parseModulesJson(tenantOwner.modules);
      const currentSet = new Set(current);

      if (type === "add") {
        const alreadyOwned = delta.filter((m) => currentSet.has(m));
        if (alreadyOwned.length === delta.length) {
          throw new Error("Selected modules are already subscribed");
        }
      } else {
        const missing = delta.filter((m) => !currentSet.has(m));
        if (missing.length) {
          throw new Error(
            `Cannot remove modules that are not subscribed: ${missing.join(", ")}`,
          );
        }
      }

      const projectedSet = new Set(current);
      if (type === "add") {
        for (const m of delta) projectedSet.add(m);
      } else {
        for (const m of delta) projectedSet.delete(m);
      }
      projectedSet.add("Credentials(Common)");
      const projected = [...projectedSet];

      const pending = await prisma.tenant_module_change_request.findFirst({
        where: { tinNumber: tin, status: "pending" },
        orderBy: { createdAt: "desc" },
      });
      if (pending) {
        throw new Error(
          "A module change request is already pending Apex review. Wait for approval or rejection before sending another.",
        );
      }

      await ensureTenantAccount(tin, tenantOwner);

      let requesterLabel = String(context.owner.UserName || "Owner").trim() || "Owner";
      try {
        const ownerRecord = await loadOwnerRecord(context.owner.ownerId);
        const display = String(ownerRecord.displayName || "").trim();
        if (display) requesterLabel = `${display} (@${ownerRecord.UserName})`;
        else requesterLabel = String(ownerRecord.UserName || requesterLabel).trim();
      } catch {
        /* env / inactive edge — fall back to JWT username */
      }

      const noteParts = [
        `[Module change: ${type}]`,
        `Changed modules: ${delta.join(", ")}`,
        `Current modules: ${current.join(", ") || "None"}`,
        `Projected modules: ${projected.join(", ") || "None"}`,
        `Requested by: ${requesterLabel} (Owner)`,
      ];
      const freeNote = String(requestNote || "").trim();
      if (freeNote) {
        noteParts.push("---", freeNote);
      }

      const row = await prisma.tenant_module_change_request.create({
        data: {
          tinNumber: tin,
          requestedModules: projected,
          requestNote: noteParts.join("\n"),
          status: "pending",
          requestedBySide: "tenant",
          requestedByUserId: null,
        },
      });

      return {
        id: row.id,
        tinNumber: row.tinNumber,
        status: row.status,
        requestedBySide: row.requestedBySide,
        requestNote: row.requestNote,
        requestedModules: row.requestedModules,
        createdAt: row.createdAt,
      };
    },
  },
};
