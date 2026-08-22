export const SUBSCRIPTION_QUARTER_DAYS = 90;

export function daysBetweenCalendar(start, end) {
  const a = new Date(start.getFullYear(), start.getMonth(), start.getDate());
  const b = new Date(end.getFullYear(), end.getMonth(), end.getDate());
  return Math.round((b.getTime() - a.getTime()) / (24 * 60 * 60 * 1000));
}

export function computeQuarterEndFromCreatedAt(createdAt, paidQuartersCount) {
  const end = new Date(createdAt.getTime());
  end.setDate(end.getDate() + paidQuartersCount * SUBSCRIPTION_QUARTER_DAYS);
  return end;
}

export {
  parseModulesJson,
  calculateSignupPricing,
  calculateSignupPricingHardcoded,
  resolveSignupPricing,
  modulesForPricingLookup,
} from "./pricingRules.js";
