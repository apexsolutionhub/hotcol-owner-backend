/** Lodging vs café subscription cadence — hotels bill yearly (4× quarterly rate). */

import { SUBSCRIPTION_QUARTER_DAYS } from "./subscriptionPricing.js";

export const SUBSCRIPTION_YEAR_DAYS = SUBSCRIPTION_QUARTER_DAYS * 4;

const LODGING_TYPES = new Set(["Hotel", "Resort", "Pension"]);

export function isLodgingBusinessType(businessType) {
  return businessType != null && LODGING_TYPES.has(String(businessType).trim());
}

export function subscriptionRenewalPaymentKind(businessType) {
  return isLodgingBusinessType(businessType) ? "yearly" : "quarterly";
}

export function subscriptionRenewalAmountETB(quarterlyFeeETB, businessType) {
  const q = Number(quarterlyFeeETB) || 0;
  return isLodgingBusinessType(businessType) ? q * 4 : q;
}

export function subscriptionPeriodDays(businessType) {
  return isLodgingBusinessType(businessType)
    ? SUBSCRIPTION_YEAR_DAYS
    : SUBSCRIPTION_QUARTER_DAYS;
}

export function computeSubscriptionPaidUntil(anchor, paidPeriodsCount, businessType) {
  const count = Math.max(1, Number(paidPeriodsCount) || 1);
  const days = subscriptionPeriodDays(businessType) * count;
  const end = new Date(anchor.getTime());
  end.setDate(end.getDate() + days);
  return end;
}

export function isValidRenewalPaymentKind(paymentKind, businessType) {
  const kind = String(paymentKind || "").trim().toLowerCase();
  const expected = subscriptionRenewalPaymentKind(businessType);
  return kind === "setup" || kind === expected;
}

export function normalizeRenewalPaymentKind(paymentKind, businessType) {
  const kind = String(paymentKind || "").trim().toLowerCase();
  if (kind === "setup") return "setup";
  return subscriptionRenewalPaymentKind(businessType);
}
