import { prisma } from "./prisma.js";
import { cafeBusinessDateYmd } from "./ownerHelpers.js";

export const BUSINESS_TYPE_BUCKETS = [
  { key: "Cafe and Restaurant", label: "Café & Restaurant" },
  { key: "Hotel", label: "Hotel" },
  { key: "Resort", label: "Resort" },
  { key: "Pension", label: "Pension" },
  { key: "Other", label: "Other" },
];

/** Cafe tableNo ≥ this maps to hotel room-service stays (hotcol-user). */
export const ROOM_SERVICE_TABLE_BASE = 900_000;

export function normalizeBusinessType(raw) {
  const s = String(raw || "").trim();
  if (!s) return "Other";
  const lower = s.toLowerCase();
  if (
    lower === "cafe" ||
    lower === "café" ||
    lower === "restaurant" ||
    lower === "cafe and restaurant" ||
    lower === "café & restaurant"
  ) {
    return "Cafe and Restaurant";
  }
  if (lower === "hotel") return "Hotel";
  if (lower === "resort") return "Resort";
  if (lower === "pension") return "Pension";
  return "Other";
}

export function businessTypeLabel(key) {
  return BUSINESS_TYPE_BUCKETS.find((b) => b.key === key)?.label ?? key;
}

function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

function hotelNameWhere(keys) {
  return keys.length === 1 ? keys[0] : { in: keys };
}

function modulesInclude(modules, name) {
  return Array.isArray(modules) && modules.includes(name);
}

function clampScore(n) {
  return Math.max(0, Math.min(100, Math.round(n)));
}

function alertFromScore(score) {
  if (score >= 75) return "ok";
  if (score >= 45) return "watch";
  return "critical";
}

/** Pending-approval + activity counts for one property (matches Apex monitoring). */
export async function loadTenantOperationalSnapshot(tinNumber) {
  const tin = String(tinNumber).trim();
  const since = startOfToday();

  const openStatusFilter = {
    OR: [
      { status: null },
      {
        status: {
          notIn: ["Completed", "Cancelled", "completed", "cancelled"],
        },
      },
    ],
  };

  const [
    staffCount,
    ordersToday,
    openOrders,
    pendingPurchaseRequests,
    pendingStockOutRequests,
    pendingItemRegistrations,
  ] = await Promise.all([
    prisma.user.count({ where: { tinNumber: tin } }),
    prisma.order.count({ where: { HotelName: tin, createdAt: { gte: since } } }),
    prisma.order.count({ where: { HotelName: tin, ...openStatusFilter } }),
    prisma.purchaseRequest.count({
      where: { HotelName: tin, status: { startsWith: "PENDING" } },
    }),
    prisma.stockOutRequest.count({
      where: {
        HotelName: tin,
        status: {
          in: [
            "PENDING",
            "PENDING_CC",
            "CHECKED_CC",
            "PENDING_FINANCE",
            "PENDING_MANAGER",
          ],
        },
      },
    }),
    prisma.itemRegistration.count({
      where: { HotelName: tin, approvalStatus: { startsWith: "PENDING" } },
    }),
  ]);

  return {
    staffCount,
    ordersToday,
    openOrders,
    pendingPurchaseRequests,
    pendingStockOutRequests,
    pendingItemRegistrations,
  };
}

export async function loadApprovalPipelineCounts(tinNumber) {
  const tin = String(tinNumber).trim();
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  const countByStatus = async (model, statusField, dateField, hotelField = "HotelName") => {
    const [pendingCC, checkedCC, pendingFinance, pendingManager, authorized] = await Promise.all([
      model.count({ where: { [hotelField]: tin, [statusField]: "PENDING_CC" } }),
      model.count({ where: { [hotelField]: tin, [statusField]: "CHECKED_CC" } }),
      model.count({ where: { [hotelField]: tin, [statusField]: "PENDING_FINANCE" } }),
      model.count({ where: { [hotelField]: tin, [statusField]: "PENDING_MANAGER" } }),
      model.count({
        where: {
          [hotelField]: tin,
          [statusField]: "AUTHORIZED",
          [dateField]: { gte: sevenDaysAgo },
        },
      }),
    ]);
    return { pendingCC, checkedCC, pendingFinance, pendingManager, authorized };
  };

  const [purchaseRequestPipeline, stockOutRequestPipeline, itemRegistrationPipeline] =
    await Promise.all([
      countByStatus(prisma.purchaseRequest, "status", "createdAt"),
      countByStatus(prisma.stockOutRequest, "status", "createdAt"),
      countByStatus(prisma.itemRegistration, "approvalStatus", "registrationDate"),
    ]);

  return { purchaseRequestPipeline, stockOutRequestPipeline, itemRegistrationPipeline };
}

/**
 * Room status + CM + stay activity + guest-bill service revenue for lodging properties.
 * Safe if tables are empty / unused.
 */
export async function loadLodgingSnapshot(hotelKeys, refDate = new Date()) {
  const empty = {
    vacantClean: 0,
    vacantDirty: 0,
    occupied: 0,
    onMaintenance: 0,
    totalRooms: 0,
    activeStays: 0,
    reservedStays: 0,
    openCmAssignments: 0,
    openCleaning: 0,
    openMaintenance: 0,
    occupancyPct: 0,
    readyPct: 0,
    todayRoomRevenueETB: 0,
    todayFoodDrinkETB: 0,
    todayLaundryETB: 0,
    todayOtherServicesETB: 0,
    monthStayRevenueETB: 0,
    openFolioETB: 0,
    checkInsToday: 0,
    checkOutsToday: 0,
    roomServiceOpenOrders: 0,
    roomServiceOrdersToday: 0,
  };

  if (!hotelKeys?.length) return empty;

  const scope = { HotelName: hotelNameWhere(hotelKeys) };
  const since = startOfToday();
  const monthStart = new Date(refDate.getFullYear(), refDate.getMonth(), 1);
  const todayYmd = cafeBusinessDateYmd(refDate);

  try {
    const [
      vacantClean,
      vacantDirty,
      occupied,
      onMaintenance,
      activeStays,
      reservedStays,
      openCmAssignments,
      openCleaning,
      openMaintenance,
      openBills,
      monthSettled,
      todayLines,
      arrivals,
      departures,
      roomServiceOpenOrders,
      roomServiceOrdersToday,
    ] = await Promise.all([
      prisma.lodging_room.count({ where: { ...scope, status: "vacant_clean" } }),
      prisma.lodging_room.count({ where: { ...scope, status: "vacant_dirty" } }),
      prisma.lodging_room.count({ where: { ...scope, status: "occupied" } }),
      prisma.lodging_room.count({ where: { ...scope, status: "on_maintenance" } }),
      prisma.lodging_stay.count({ where: { ...scope, status: "checked_in" } }),
      prisma.lodging_stay.count({ where: { ...scope, status: "reserved" } }),
      prisma.lodging_cm_assignment.count({ where: { ...scope, status: "open" } }),
      prisma.lodging_cm_assignment.count({
        where: { ...scope, status: "open", workKind: "cleaning" },
      }),
      prisma.lodging_cm_assignment.count({
        where: { ...scope, status: "open", workKind: "maintenance" },
      }),
      prisma.lodging_bill.findMany({
        where: { ...scope, status: "open" },
        select: { totalETB: true },
      }),
      prisma.lodging_bill.findMany({
        where: {
          ...scope,
          status: "settled",
          settledAt: { gte: monthStart },
        },
        select: { totalETB: true },
      }),
      prisma.lodging_bill_line.findMany({
        where: {
          createdAt: { gte: since },
          bill: scope,
        },
        select: { kind: true, amountETB: true, createdAt: true },
      }),
      prisma.lodging_stay.count({
        where: { ...scope, status: { in: ["checked_in", "reserved"] }, arrivalAt: { gte: since } },
      }),
      prisma.lodging_stay.count({
        where: { ...scope, status: "checked_out", departureAt: { gte: since } },
      }),
      prisma.order.count({
        where: {
          HotelName: hotelNameWhere(hotelKeys),
          tableNo: { gte: ROOM_SERVICE_TABLE_BASE },
          OR: [
            { status: null },
            {
              status: {
                notIn: ["Completed", "Cancelled", "completed", "cancelled"],
              },
            },
          ],
        },
      }),
      prisma.order.count({
        where: {
          HotelName: hotelNameWhere(hotelKeys),
          tableNo: { gte: ROOM_SERVICE_TABLE_BASE },
          createdAt: { gte: since },
        },
      }),
    ]);

    const totalRooms = vacantClean + vacantDirty + occupied + onMaintenance;
    const sellable = vacantClean + vacantDirty + occupied;
    const occupancyPct =
      sellable > 0 ? Math.round((occupied / sellable) * 100) : 0;
    const readyPct =
      totalRooms > 0 ? Math.round((vacantClean / totalRooms) * 100) : 0;

    let todayRoomRevenueETB = 0;
    let todayFoodDrinkETB = 0;
    let todayLaundryETB = 0;
    let todayOtherServicesETB = 0;
    for (const line of todayLines) {
      if (cafeBusinessDateYmd(line.createdAt) !== todayYmd) continue;
      const amt = Number(line.amountETB) || 0;
      switch (String(line.kind || "")) {
        case "room":
          todayRoomRevenueETB += amt;
          break;
        case "food_drink":
          todayFoodDrinkETB += amt;
          break;
        case "laundry":
          todayLaundryETB += amt;
          break;
        default:
          todayOtherServicesETB += amt;
      }
    }

    const openFolioETB = openBills.reduce((s, b) => s + (Number(b.totalETB) || 0), 0);
    const monthStayRevenueETB = monthSettled.reduce(
      (s, b) => s + (Number(b.totalETB) || 0),
      0,
    );

    return {
      vacantClean,
      vacantDirty,
      occupied,
      onMaintenance,
      totalRooms,
      activeStays,
      reservedStays,
      openCmAssignments,
      openCleaning,
      openMaintenance,
      occupancyPct,
      readyPct,
      todayRoomRevenueETB,
      todayFoodDrinkETB,
      todayLaundryETB,
      todayOtherServicesETB,
      monthStayRevenueETB,
      openFolioETB,
      checkInsToday: arrivals,
      checkOutsToday: departures,
      roomServiceOpenOrders,
      roomServiceOrdersToday,
    };
  } catch (err) {
    // Tables may not exist yet on a fresh shared DB — degrade gracefully.
    if (String(err?.message || "").includes("does not exist")) return empty;
    throw err;
  }
}

/** Café floor readiness: menu / tables / waiters + cancelled today. */
export async function loadCafeOpsSnapshot(hotelKeys) {
  const empty = {
    menuItemCount: 0,
    tableCount: 0,
    waiterCount: 0,
    cancelledToday: 0,
  };
  if (!hotelKeys?.length) return empty;

  const scope = hotelNameWhere(hotelKeys);
  const since = startOfToday();

  try {
    const [menuItemCount, tableCount, waiterCount, cancelledToday] = await Promise.all([
      prisma.item.count({ where: { HotelName: scope } }),
      prisma.table.count({ where: { HotelName: scope } }),
      prisma.waiter.count({ where: { HotelName: scope } }),
      prisma.order.count({
        where: {
          HotelName: scope,
          createdAt: { gte: since },
          status: { in: ["Cancelled", "cancelled"] },
        },
      }),
    ]);
    return { menuItemCount, tableCount, waiterCount, cancelledToday };
  } catch (err) {
    if (String(err?.message || "").includes("does not exist")) return empty;
    throw err;
  }
}

/** Build module scorecards mirroring hotcol-user ManagerOverviewDashboard. */
export function buildModuleHealth({
  modules,
  lodging,
  cafeOps,
  operational,
  inventoryItemCount = 0,
}) {
  const cards = [];

  if (modulesInclude(modules, "Room Management") && lodging) {
    const s = lodging;
    let score = 10;
    if (s.totalRooms > 0) {
      score = clampScore(
        55 +
          s.readyPct * 0.35 -
          s.vacantDirty * 6 -
          s.onMaintenance * 4 +
          Math.min(20, s.activeStays * 2),
      );
    }
    cards.push({
      module: "Room Management",
      label: "Rooms & stays",
      score,
      alertLevel: alertFromScore(score),
      summary:
        s.totalRooms === 0
          ? "No rooms configured yet"
          : `${s.occupancyPct}% occupied · ${s.activeStays} in-house`,
      metrics: [
        { label: "Ready", value: String(s.vacantClean) },
        { label: "Dirty", value: String(s.vacantDirty) },
        { label: "Occupied", value: String(s.occupied) },
        { label: "Maintenance", value: String(s.onMaintenance) },
      ],
    });
  }

  if (modulesInclude(modules, "Cleaning and Maintenance") && lodging) {
    const backlog = lodging.openCmAssignments + lodging.vacantDirty;
    const score = clampScore(92 - lodging.openCmAssignments * 8 - lodging.vacantDirty * 5);
    cards.push({
      module: "Cleaning and Maintenance",
      label: "Housekeeping",
      score,
      alertLevel: alertFromScore(score),
      summary:
        backlog === 0
          ? "Housekeeping queue clear"
          : `${lodging.openCleaning} cleaning · ${lodging.openMaintenance} maintenance open`,
      metrics: [
        { label: "Open jobs", value: String(lodging.openCmAssignments) },
        { label: "Dirty rooms", value: String(lodging.vacantDirty) },
        { label: "On maintenance", value: String(lodging.onMaintenance) },
      ],
    });
  }

  if (modulesInclude(modules, "Cafe and Restaurant") && cafeOps) {
    const open = operational?.openOrders ?? 0;
    const setup =
      (cafeOps.menuItemCount > 0 ? 25 : 0) +
      (cafeOps.tableCount > 0 ? 25 : 0) +
      (cafeOps.waiterCount > 0 ? 25 : 0);
    const score = clampScore(setup + Math.min(25, Math.max(0, 25 - open * 2)));
    cards.push({
      module: "Cafe and Restaurant",
      label: "Café & F&B",
      score,
      alertLevel: alertFromScore(score),
      summary: `${open} live orders · ${cafeOps.menuItemCount} menu items`,
      metrics: [
        { label: "Menu", value: String(cafeOps.menuItemCount) },
        { label: "Tables", value: String(cafeOps.tableCount) },
        { label: "Waiters", value: String(cafeOps.waiterCount) },
        { label: "Cancelled today", value: String(cafeOps.cancelledToday) },
      ],
    });
  }

  if (modulesInclude(modules, "Inventory")) {
    const pending =
      (operational?.pendingPurchaseRequests ?? 0) +
      (operational?.pendingStockOutRequests ?? 0) +
      (operational?.pendingItemRegistrations ?? 0);
    const score = clampScore(
      (inventoryItemCount > 0 ? 70 : 20) - Math.min(50, pending * 6),
    );
    cards.push({
      module: "Inventory",
      label: "Inventory",
      score,
      alertLevel: alertFromScore(score),
      summary:
        pending === 0
          ? `${inventoryItemCount} active stock lines`
          : `${pending} approvals waiting`,
      metrics: [
        { label: "Items", value: String(inventoryItemCount) },
        { label: "Purchases", value: String(operational?.pendingPurchaseRequests ?? 0) },
        { label: "Stock-outs", value: String(operational?.pendingStockOutRequests ?? 0) },
      ],
    });
  }

  if (modulesInclude(modules, "Financial Management") && operational) {
    const pipelinePending =
      (operational.purchaseRequestPipeline?.pendingCC ?? 0) +
      (operational.purchaseRequestPipeline?.pendingFinance ?? 0) +
      (operational.purchaseRequestPipeline?.pendingManager ?? 0) +
      (operational.stockOutRequestPipeline?.pendingCC ?? 0) +
      (operational.stockOutRequestPipeline?.pendingFinance ?? 0) +
      (operational.stockOutRequestPipeline?.pendingManager ?? 0) +
      (operational.itemRegistrationPipeline?.pendingCC ?? 0) +
      (operational.itemRegistrationPipeline?.pendingFinance ?? 0) +
      (operational.itemRegistrationPipeline?.pendingManager ?? 0);
    const score = clampScore(95 - pipelinePending * 5);
    cards.push({
      module: "Financial Management",
      label: "Approvals",
      score,
      alertLevel: alertFromScore(score),
      summary:
        pipelinePending === 0
          ? "Approval pipeline clear"
          : `${pipelinePending} items in finance pipeline`,
      metrics: [
        { label: "Pipeline", value: String(pipelinePending) },
        {
          label: "Authorized (7d)",
          value: String(
            (operational.purchaseRequestPipeline?.authorized ?? 0) +
              (operational.stockOutRequestPipeline?.authorized ?? 0) +
              (operational.itemRegistrationPipeline?.authorized ?? 0),
          ),
        },
      ],
    });
  }

  if (modulesInclude(modules, "Credentials(Common)") || modulesInclude(modules, "Credentials")) {
    const staff = operational?.staffCount ?? 0;
    const score = clampScore(staff > 0 ? 70 + Math.min(30, staff * 3) : 15);
    cards.push({
      module: "Credentials(Common)",
      label: "Staff access",
      score,
      alertLevel: alertFromScore(score),
      summary: `${staff} staff accounts`,
      metrics: [{ label: "Accounts", value: String(staff) }],
    });
  }

  return cards;
}
