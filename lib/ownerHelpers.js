import { prisma } from "./prisma.js";
import { envOwnerTins, isEnvOwnerId } from "./envOwner.js";
import {
  findItemRecipeByTitle,
  orderLineResolvedIngredientCost,
  parseMenuRecipe,
} from "./cafeRecipe.js";

// ---------------------------------------------------------------------------
// Portfolio scope guards
// ---------------------------------------------------------------------------

export async function ownedPropertyRows(ownerId) {
  if (isEnvOwnerId(ownerId)) {
    return envOwnerTins().map((tin) => ({
      ownerId,
      tinNumber: tin,
      label: null,
      createdAt: new Date(0),
    }));
  }
  return prisma.owner_property.findMany({
    where: { ownerId },
    orderBy: { createdAt: "asc" },
  });
}

export async function ownedTins(ownerId) {
  if (isEnvOwnerId(ownerId)) return envOwnerTins();
  const rows = await ownedPropertyRows(ownerId);
  return rows.map((r) => String(r.tinNumber).trim()).filter(Boolean);
}

export async function countOwnerProperties(ownerId) {
  if (isEnvOwnerId(ownerId)) return envOwnerTins().length;
  return prisma.owner_property.count({ where: { ownerId } });
}

/** Throws unless this owner is linked to the given property TIN. Returns the trimmed tin. */
export async function assertOwnsTin(ownerId, tinNumber) {
  const tin = String(tinNumber || "").trim();
  if (!tin) throw new Error("Property TIN is required");
  if (isEnvOwnerId(ownerId)) {
    if (!envOwnerTins().includes(tin)) {
      throw new Error("You do not have access to this property");
    }
    return tin;
  }
  const found = await prisma.owner_property.findFirst({
    where: { ownerId, tinNumber: tin },
  });
  if (!found) throw new Error("You do not have access to this property");
  return tin;
}

/**
 * Rows (Order/Item/...) store `HotelName` which equals the TIN for new tenants
 * but may carry a legacy display string for older rows. Collect all matching keys.
 */
export async function hotelKeysForTin(tinNumber) {
  const tin = String(tinNumber).trim();
  const users = await prisma.user.findMany({
    where: { tinNumber: tin },
    select: { HotelName: true },
  });
  const keys = new Set([tin]);
  for (const u of users) {
    const h = String(u.HotelName || "").trim();
    if (h) keys.add(h);
  }
  return [...keys];
}

// ---------------------------------------------------------------------------
// Café "today" (property local time) — keep in sync with hotcol-user
// ---------------------------------------------------------------------------

export const CAFE_BUSINESS_TIMEZONE = "Africa/Addis_Ababa";

export function cafeBusinessDateYmd(dateInput) {
  const d = new Date(dateInput);
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: CAFE_BUSINESS_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

export function cafeBusinessMonth(dateInput) {
  const ymd = cafeBusinessDateYmd(dateInput);
  return ymd ? ymd.slice(0, 7) : "";
}

function shiftYmd(ymd, days) {
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

function shortDayLabel(ymd) {
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    weekday: "short",
  }).format(dt);
}

function marginPct(profit, revenue) {
  return revenue > 0 ? Math.round((profit / revenue) * 1000) / 10 : 0;
}

/** First UTC instant that can fall on Addis calendar day `ymd` (buffer for TZ). */
function addisFetchStart(ymd) {
  const [y, m, d] = String(ymd).split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d - 1, 20, 0, 0));
}

/** Exclusive upper bound after Addis calendar day `ymd`. */
function addisFetchEndExclusive(ymd) {
  const [y, m, d] = String(ymd).split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1, 4, 0, 0));
}

function normalizeReportPeriod(period) {
  return String(period || "").trim().toLowerCase() === "monthly" ? "Monthly" : "Daily";
}

function normalizeReportDate(dateInput, period = "Daily") {
  const raw = String(dateInput || "").trim();
  let ymd = /^\d{4}-\d{2}-\d{2}$/.test(raw)
    ? raw
    : cafeBusinessDateYmd(raw ? new Date(raw) : new Date());
  if (!ymd) ymd = cafeBusinessDateYmd(new Date());
  const today = cafeBusinessDateYmd(new Date());
  if (ymd > today) ymd = today;
  if (normalizeReportPeriod(period) === "Monthly") {
    return `${ymd.slice(0, 7)}-01`;
  }
  return ymd;
}

function emptyCafePeriodReport(period, date) {
  return {
    period,
    date,
    label: period === "Monthly" ? date.slice(0, 7) : date,
    revenueETB: 0,
    ingredientCostETB: 0,
    profitETB: 0,
    marginPct: 0,
    cashETB: 0,
    bankETB: 0,
    creditETB: 0,
    paidLines: 0,
    linesWithRecipe: 0,
    recipeCoveragePct: 0,
    menuItemsWithRecipe: 0,
    menuItemCount: 0,
    categories: [],
    topSoldByCategory: [],
    topSoldByType: [],
    topSoldItems: [],
    orderSummary: {
      totalLines: 0,
      completed: 0,
      completedETB: 0,
      cancelled: 0,
      cancelledETB: 0,
      pendingPayment: 0,
      pendingPaymentETB: 0,
      expired: 0,
      expiredETB: 0,
    },
    trend: [],
  };
}

/** Batch HotelName keys for many TINs (one query). */
export async function hotelKeysByTinMap(tins) {
  const unique = [...new Set((tins || []).map((t) => String(t || "").trim()).filter(Boolean))];
  const map = new Map(unique.map((tin) => [tin, new Set([tin])]));
  if (!unique.length) return map;
  const users = await prisma.user.findMany({
    where: { tinNumber: { in: unique } },
    select: { tinNumber: true, HotelName: true },
  });
  for (const u of users) {
    const tin = String(u.tinNumber || "").trim();
    const hotel = String(u.HotelName || "").trim();
    if (!tin || !map.has(tin)) continue;
    if (hotel) map.get(tin).add(hotel);
  }
  return new Map([...map.entries()].map(([tin, set]) => [tin, [...set]]));
}

/** First Admin/Manager row per TIN. */
export async function tenantOwnersByTinMap(tins) {
  const unique = [...new Set((tins || []).map((t) => String(t || "").trim()).filter(Boolean))];
  const map = new Map();
  if (!unique.length) return map;
  const rows = await prisma.user.findMany({
    where: { tinNumber: { in: unique }, Role: { in: ["Admin", "Manager"] } },
    orderBy: { id: "asc" },
  });
  for (const row of rows) {
    const tin = String(row.tinNumber || "").trim();
    if (tin && !map.has(tin)) map.set(tin, row);
  }
  return map;
}

// ---------------------------------------------------------------------------
// Order revenue classification (mirrors hotcol-user cafeBankPayment/cafeOrders)
// ---------------------------------------------------------------------------

export function isPaidOrderLine(o) {
  if (String(o.payment ?? "").trim().toLowerCase() !== "paid") return false;
  if (String(o.status ?? "").trim().toLowerCase() === "cancelled") return false;
  return true;
}

export function orderLineTotalETB(o) {
  return (Number(o.price) || 0) * (Number(o.orderAmount) || 0);
}

export function isCashOrder(o) {
  return o.withBank === false;
}
export function isBankOrder(o) {
  return o.withBank === true;
}
export function isCreditOrder(o) {
  return o.credit === true && o.withBank === null;
}

export function orderBankTransferETB(o) {
  const t = Number(o.bankTransferAmount);
  if (Number.isFinite(t) && t > 0) return t;
  return orderLineTotalETB(o);
}

/**
 * Revenue snapshot for one property over the current calendar month, split into
 * "today" (café business day) and month-to-date figures + payment + category mix.
 */
export async function loadTenantRevenueSnapshot(hotelKeys, refDate = new Date()) {
  if (!hotelKeys?.length) {
    return {
      todayRevenueETB: 0,
      monthRevenueETB: 0,
      todayOrders: 0,
      todayCashETB: 0,
      todayBankETB: 0,
      todayCreditETB: 0,
      categories: [],
    };
  }

  const todayYmd = cafeBusinessDateYmd(refDate);
  const monthKey = cafeBusinessMonth(refDate);
  const monthStartYmd = `${monthKey}-01`;

  const orders = await prisma.order.findMany({
    where: {
      HotelName: hotelKeys.length === 1 ? hotelKeys[0] : { in: hotelKeys },
      createdAt: {
        gte: addisFetchStart(monthStartYmd),
        lt: addisFetchEndExclusive(todayYmd),
      },
    },
    select: {
      price: true,
      orderAmount: true,
      payment: true,
      status: true,
      withBank: true,
      credit: true,
      bankTransferAmount: true,
      category: true,
      createdAt: true,
    },
  });

  let todayRevenueETB = 0;
  let monthRevenueETB = 0;
  let todayOrders = 0;
  let todayCashETB = 0;
  let todayBankETB = 0;
  let todayCreditETB = 0;
  const categoryToday = new Map();

  for (const o of orders) {
    if (!isPaidOrderLine(o)) continue;
    const total = orderLineTotalETB(o);
    const ymd = cafeBusinessDateYmd(o.createdAt);
    if (ymd.startsWith(monthKey)) monthRevenueETB += total;

    if (ymd === todayYmd) {
      todayRevenueETB += total;
      todayOrders += 1;
      if (isCashOrder(o)) todayCashETB += total;
      else if (isBankOrder(o)) todayBankETB += orderBankTransferETB(o);
      else if (isCreditOrder(o)) todayCreditETB += total;

      const key = String(o.category ?? "").trim() || "Others";
      categoryToday.set(key, (categoryToday.get(key) ?? 0) + total);
    }
  }

  const categories = [...categoryToday.entries()]
    .map(([label, revenueETB]) => ({ label, revenueETB }))
    .sort((a, b) => b.revenueETB - a.revenueETB);

  return {
    todayRevenueETB,
    monthRevenueETB,
    todayOrders,
    todayCashETB,
    todayBankETB,
    todayCreditETB,
    categories,
  };
}

/**
 * Café period report (Daily / Monthly) with profit, top sold, order status, trend.
 * Mirrors hotcol-user Financial Reports period filtering.
 */
export async function loadCafePeriodReport(
  hotelKeys,
  { period: periodInput = "Daily", date: dateInput = null } = {},
) {
  const period = normalizeReportPeriod(periodInput);
  const date = normalizeReportDate(dateInput, period);
  const empty = emptyCafePeriodReport(period, date);
  if (!hotelKeys?.length) return empty;

  const monthKey = date.slice(0, 7);
  const todayYmd = cafeBusinessDateYmd(new Date());
  const hotelWhere = hotelKeys.length === 1 ? hotelKeys[0] : { in: hotelKeys };

  let rangeStartYmd;
  let rangeEndYmd;
  let trendStartYmd;
  let trendEndYmd;

  if (period === "Daily") {
    rangeStartYmd = date;
    rangeEndYmd = date;
    trendEndYmd = date;
    trendStartYmd = shiftYmd(date, -6);
  } else {
    rangeStartYmd = `${monthKey}-01`;
    const [yy, mm] = monthKey.split("-").map(Number);
    const lastDay = new Date(Date.UTC(yy, mm, 0)).getUTCDate();
    rangeEndYmd = `${monthKey}-${String(lastDay).padStart(2, "0")}`;
    if (rangeEndYmd > todayYmd && monthKey === todayYmd.slice(0, 7)) {
      rangeEndYmd = todayYmd;
    }
    trendStartYmd = rangeStartYmd;
    trendEndYmd = rangeEndYmd;
  }

  const fetchFrom = addisFetchStart(trendStartYmd < rangeStartYmd ? trendStartYmd : rangeStartYmd);
  const fetchTo = addisFetchEndExclusive(trendEndYmd > rangeEndYmd ? trendEndYmd : rangeEndYmd);

  const [orders, items] = await Promise.all([
    prisma.order.findMany({
      where: {
        HotelName: hotelWhere,
        createdAt: { gte: fetchFrom, lt: fetchTo },
      },
      select: {
        title: true,
        price: true,
        unitCostAtSale: true,
        orderAmount: true,
        payment: true,
        status: true,
        category: true,
        type: true,
        withBank: true,
        credit: true,
        bankTransferAmount: true,
        createdAt: true,
      },
    }),
    prisma.item.findMany({
      where: { HotelName: hotelWhere },
      select: { name: true, recipeJson: true },
    }),
  ]);

  const recipeCache = new Map();
  const recipeFor = (title) => {
    const key = String(title ?? "").trim().toLowerCase();
    if (!key) return null;
    if (recipeCache.has(key)) return recipeCache.get(key);
    const recipe = findItemRecipeByTitle(items, title);
    recipeCache.set(key, recipe);
    return recipe;
  };

  const inSelectedPeriod = (ymd) =>
    period === "Daily" ? ymd === date : ymd.startsWith(monthKey);

  let revenueETB = 0;
  let costETB = 0;
  let profitETB = 0;
  let cashETB = 0;
  let bankETB = 0;
  let creditETB = 0;
  let paidLines = 0;
  let linesWithRecipe = 0;
  const categoryProfit = new Map();
  const soldByCategory = new Map();
  const soldByType = new Map();
  const soldByItem = new Map();
  const orderSummary = {
    totalLines: 0,
    completed: 0,
    completedETB: 0,
    cancelled: 0,
    cancelledETB: 0,
    pendingPayment: 0,
    pendingPaymentETB: 0,
    expired: 0,
    expiredETB: 0,
  };
  const daily = new Map();

  for (let cursor = trendStartYmd; cursor <= trendEndYmd; cursor = shiftYmd(cursor, 1)) {
    daily.set(cursor, {
      date: cursor,
      label: period === "Monthly" ? String(Number(cursor.slice(8, 10))) : shortDayLabel(cursor),
      revenueETB: 0,
      ingredientCostETB: 0,
      profitETB: 0,
      orders: 0,
    });
  }

  const updateSold = (map, label, order, revenue, profit) => {
    const key = String(label ?? "").trim() || "Uncategorized";
    const prev = map.get(key) || {
      label: key,
      quantity: 0,
      revenueETB: 0,
      profitETB: 0,
    };
    prev.quantity += Math.max(0, Number(order.orderAmount) || 0);
    prev.revenueETB += revenue;
    prev.profitETB += profit;
    map.set(key, prev);
  };

  for (const o of orders) {
    const ymd = cafeBusinessDateYmd(o.createdAt);
    if (!ymd) continue;
    const revenue = orderLineTotalETB(o);
    const status = String(o.status ?? "").trim().toLowerCase();
    const payment = String(o.payment ?? "").trim().toLowerCase();
    const selected = inSelectedPeriod(ymd);

    if (selected) {
      orderSummary.totalLines += 1;
      if (status === "cancelled") {
        orderSummary.cancelled += 1;
        orderSummary.cancelledETB += revenue;
      } else if (status === "completed" && payment === "paid") {
        orderSummary.completed += 1;
        orderSummary.completedETB += revenue;
      } else if (status === "completed" && payment !== "paid") {
        orderSummary.pendingPayment += 1;
        orderSummary.pendingPaymentETB += revenue;
      } else if ((!status || status === "pending") && payment !== "paid") {
        orderSummary.expired += 1;
        orderSummary.expiredETB += revenue;
      }
    }

    if (!isPaidOrderLine(o)) continue;
    const recipe = recipeFor(o.title);
    const costResolved = orderLineResolvedIngredientCost(o, recipe);
    const hasCost = costResolved != null;
    const cost = hasCost ? costResolved : 0;
    const profit = hasCost ? revenue - cost : 0;

    const day = daily.get(ymd);
    if (day) {
      day.revenueETB += revenue;
      day.orders += 1;
      if (hasCost) {
        day.ingredientCostETB += cost;
        day.profitETB += profit;
      }
    }

    if (!selected) continue;

    revenueETB += revenue;
    paidLines += 1;
    if (hasCost) {
      costETB += cost;
      profitETB += profit;
      linesWithRecipe += 1;
    }
    if (isCashOrder(o)) cashETB += revenue;
    else if (isBankOrder(o)) bankETB += orderBankTransferETB(o);
    else if (isCreditOrder(o)) creditETB += revenue;

    const cat = String(o.category ?? "").trim() || "Others";
    const prev = categoryProfit.get(cat) || {
      label: cat,
      revenueETB: 0,
      ingredientCostETB: 0,
      profitETB: 0,
    };
    prev.revenueETB += revenue;
    if (hasCost) {
      prev.ingredientCostETB += cost;
      prev.profitETB += profit;
    }
    categoryProfit.set(cat, prev);

    updateSold(soldByCategory, o.category, o, revenue, profit);
    updateSold(soldByType, o.type, o, revenue, profit);
    updateSold(soldByItem, o.title, o, revenue, profit);
  }

  const menuItemsWithRecipe = items.filter((i) => parseMenuRecipe(i.recipeJson)).length;
  const topTen = (map) =>
    [...map.values()]
      .sort(
        (a, b) =>
          b.revenueETB - a.revenueETB ||
          b.quantity - a.quantity ||
          a.label.localeCompare(b.label),
      )
      .slice(0, 10);

  const label =
    period === "Monthly"
      ? new Intl.DateTimeFormat("en-US", {
          month: "long",
          year: "numeric",
          timeZone: "UTC",
        }).format(new Date(`${monthKey}-15T12:00:00Z`))
      : new Intl.DateTimeFormat("en-US", {
          weekday: "short",
          month: "short",
          day: "numeric",
          year: "numeric",
          timeZone: "UTC",
        }).format(new Date(`${date}T12:00:00Z`));

  return {
    period,
    date,
    label,
    revenueETB,
    ingredientCostETB: costETB,
    profitETB,
    marginPct: marginPct(profitETB, revenueETB),
    cashETB,
    bankETB,
    creditETB,
    paidLines,
    linesWithRecipe,
    recipeCoveragePct:
      paidLines > 0 ? Math.round((linesWithRecipe / paidLines) * 100) : 0,
    menuItemsWithRecipe,
    menuItemCount: items.length,
    categories: [...categoryProfit.values()]
      .sort((a, b) => b.revenueETB - a.revenueETB)
      .slice(0, 12),
    topSoldByCategory: topTen(soldByCategory),
    topSoldByType: topTen(soldByType),
    topSoldItems: topTen(soldByItem),
    orderSummary,
    trend: [...daily.values()],
  };
}

/** Lightweight daily-only café analytics for screens that still expect CafeAnalytics. */
export async function loadCafeProfitSnapshot(hotelKeys, refDate = new Date()) {
  const report = await loadCafePeriodReport(hotelKeys, {
    period: "Daily",
    date: cafeBusinessDateYmd(refDate),
  });
  return {
    profit: {
      todayRevenueETB: report.revenueETB,
      todayIngredientCostETB: report.ingredientCostETB,
      todayProfitETB: report.profitETB,
      todayMarginPct: report.marginPct,
      monthRevenueETB: report.revenueETB,
      monthIngredientCostETB: report.ingredientCostETB,
      monthProfitETB: report.profitETB,
      monthMarginPct: report.marginPct,
      linesWithRecipe: report.linesWithRecipe,
      paidLines: report.paidLines,
      recipeCoveragePct: report.recipeCoveragePct,
      menuItemsWithRecipe: report.menuItemsWithRecipe,
      menuItemCount: report.menuItemCount,
    },
    dailyTrend: report.trend,
    topCategories: report.categories
      .map((c) => ({
        label: c.label,
        revenueETB: c.revenueETB,
        ingredientCostETB: c.ingredientCostETB,
        profitETB: c.profitETB,
      }))
      .sort((a, b) => b.profitETB - a.profitETB)
      .slice(0, 6),
    topSoldByCategory: report.topSoldByCategory,
    topSoldByType: report.topSoldByType,
    topSoldItems: report.topSoldItems,
    orderSummary: report.orderSummary,
  };
}

// ---------------------------------------------------------------------------
// Staff role <-> module gating (mirrors hotcol-user ROLE_REQUIRED_MODULE)
// ---------------------------------------------------------------------------

export const OWNER_MANAGEABLE_ROLES = [
  "Cashier",
  "Kitchen",
  "Barista",
  "Store",
  "CostControl",
  "Finance",
  "HotelCashier",
  "Reception",
  "CMLeader",
  "HR",
];

const ROLE_REQUIRED_MODULE = {
  Kitchen: "Cafe and Restaurant",
  Barista: "Cafe and Restaurant",
  Cashier: "Cafe and Restaurant",
  Store: "Inventory",
  CostControl: "Financial Management",
  Finance: "Financial Management",
  HotelCashier: "Credit Management",
  Reception: "Room Management",
  CMLeader: "Cleaning and Maintenance",
  HR: "HR Module",
};

export function roleAllowedForModules(role, modules) {
  const required = ROLE_REQUIRED_MODULE[role];
  if (!required) return true;
  if (!Array.isArray(modules) || modules.length === 0) return true;
  return modules.includes(required);
}
