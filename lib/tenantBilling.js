/** Shared tenant billing rules (mirrors hotcol-user / hotcol). */

import {
  computeQuarterEndFromCreatedAt,
  daysBetweenCalendar,
  SUBSCRIPTION_QUARTER_DAYS,
} from "./subscriptionPricing.js";
import {
  computeSubscriptionPaidUntil,
  subscriptionRenewalPaymentKind,
} from "./subscriptionBillingPeriod.js";

export { daysBetweenCalendar, SUBSCRIPTION_QUARTER_DAYS };
export {
  computeSubscriptionPaidUntil,
  subscriptionRenewalPaymentKind,
} from "./subscriptionBillingPeriod.js";

export function quarterlyFeeApplies(quarterlyFeeETB) {
  return Number(quarterlyFeeETB) > 0;
}

export function subscriptionBillingApplies(sub) {
  if (sub.isIllustrationTenant) return false;
  return Number(sub.quarterlyFeeETB ?? 0) > 0;
}

export const TRIAL_PAYMENT_WINDOW_DAYS = 5;

export function isFreeTrialActive(sub, now = new Date()) {
  if (!sub.freeTrialEndsAt) return false;
  const end = new Date(sub.freeTrialEndsAt);
  if (Number.isNaN(end.getTime())) return false;
  return now.getTime() < end.getTime();
}

export function freeTrialDaysRemaining(sub, now = new Date()) {
  if (!sub.freeTrialEndsAt) return null;
  const end = new Date(sub.freeTrialEndsAt);
  if (Number.isNaN(end.getTime())) return null;
  return daysBetweenCalendar(now, end);
}

export function hadFreeTrial(sub) {
  if (!sub.freeTrialEndsAt) return false;
  const end = new Date(sub.freeTrialEndsAt);
  return !Number.isNaN(end.getTime());
}

export function trialPaymentDeadline(sub) {
  if (!sub.freeTrialEndsAt) return null;
  const end = new Date(sub.freeTrialEndsAt);
  if (Number.isNaN(end.getTime())) return null;
  const deadline = new Date(end.getTime());
  deadline.setDate(deadline.getDate() + TRIAL_PAYMENT_WINDOW_DAYS);
  return deadline;
}

/** Day 1 for quarter counting — only after hold is released. */
export function resolveBillingAnchor(sub) {
  if (sub.billingHold) return null;
  if (sub.billingStartedAt) {
    const d = new Date(sub.billingStartedAt);
    if (!Number.isNaN(d.getTime())) return d;
  }
  if (sub.createdAt) {
    const d = new Date(sub.createdAt);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return null;
}

export function paidQuartersFromAnchor(anchor, now = new Date()) {
  const days = Math.max(0, daysBetweenCalendar(anchor, now));
  return Math.floor(days / SUBSCRIPTION_QUARTER_DAYS) + 1;
}

export function selfSignupAwaitingSetup(sub, pendingSetupSubmission = false) {
  if (sub.setupFeeApproved) return false;
  const setupFeeETB = Number(sub.setupFeeETB ?? 0);
  if (setupFeeETB <= 0) return false;
  if (pendingSetupSubmission) return true;
  const ref =
    sub.paymentTransactionRef != null
      ? String(sub.paymentTransactionRef).trim()
      : "";
  return ref.length >= 4;
}

/**
 * @returns {'exempt'|'on_hold'|'trial'|'trial_ending'|'trial_expired'|'setup_pending'|'pending_approval'|'active'|'warning'|'grace'|'expired'}
 */
export function computeSubscriptionPeriodStatus(sub, now = new Date(), options = {}) {
  const { pendingSetupSubmission = false } = options;

  if (sub.isIllustrationTenant) return "exempt";
  if (sub.billingHold) return "on_hold";

  const quarterlyFeeETB = sub.quarterlyFeeETB ?? 0;
  if (Number(quarterlyFeeETB) <= 0) return "exempt";

  if (selfSignupAwaitingSetup(sub, pendingSetupSubmission)) {
    return "setup_pending";
  }

  if (isFreeTrialActive(sub, now)) {
    const daysLeft = freeTrialDaysRemaining(sub, now);
    if (daysLeft !== null && daysLeft <= TRIAL_PAYMENT_WINDOW_DAYS && !sub.setupFeeApproved) {
      return "trial_ending";
    }
    return "trial";
  }

  if (hadFreeTrial(sub) && !sub.setupFeeApproved) {
    return "trial_expired";
  }

  const anchor = resolveBillingAnchor(sub);
  if (!anchor) return "on_hold";

  const paidUntil = sub.subscriptionPaidUntil
    ? new Date(sub.subscriptionPaidUntil)
    : null;
  if (!paidUntil || Number.isNaN(paidUntil.getTime())) {
    return "active";
  }

  const daysUntilEnd = daysBetweenCalendar(now, paidUntil);

  if (daysUntilEnd > 10) return "active";
  if (daysUntilEnd >= 0) return "warning";

  const daysPast = -daysUntilEnd;
  if (daysPast >= 1 && daysPast < 10) return "grace";
  return "expired";
}

export function isPastPaidQuarterEnd(sub, now = new Date()) {
  const paidUntil = sub.subscriptionPaidUntil
    ? new Date(sub.subscriptionPaidUntil)
    : null;
  if (!paidUntil || Number.isNaN(paidUntil.getTime())) return false;
  return daysBetweenCalendar(now, paidUntil) < 0;
}

export function subscriptionAllowsFullSystemAccess(status) {
  return (
    status === "exempt" ||
    status === "trial" ||
    status === "trial_ending" ||
    status === "active" ||
    status === "warning"
  );
}

export function computePaidUntilForOwner(owner, paidPeriodsCount) {
  const anchor = resolveBillingAnchor(tenantBillingRowFromOwner(owner));
  if (!anchor) return null;
  return computeSubscriptionPaidUntil(
    anchor,
    paidPeriodsCount,
    owner.businessType ?? null,
  );
}

export function tenantBillingRowFromOwner(row) {
  return {
    modules: row.modules,
    setupFeeETB: row.setupFeeETB ?? 0,
    quarterlyFeeETB: row.quarterlyFeeETB ?? 0,
    setupFeeApproved: Boolean(row.setupFeeApproved),
    createdAt: row.createdAt ?? null,
    billingStartedAt: row.billingStartedAt ?? null,
    billingHold: Boolean(row.billingHold),
    isIllustrationTenant: Boolean(row.isIllustrationTenant),
    freeTrialEndsAt: row.freeTrialEndsAt ?? null,
    billingNotes: row.billingNotes ?? null,
    subscriptionPaidUntil: row.subscriptionPaidUntil ?? null,
    subscriptionPaymentApproved: Boolean(row.subscriptionPaymentApproved),
    paidQuartersCount: row.paidQuartersCount ?? 0,
    paymentTransactionRef: row.paymentTransactionRef ?? null,
  };
}

export { computeQuarterEndFromCreatedAt };
