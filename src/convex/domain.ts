/**
 * domain.ts — single source of truth for enums, constants, and pure business
 * logic (scoring inputs, reserved-stock math, customer-trust model, net-benefit
 * gate). This module must never import anything server-only: it is imported by
 * the Convex backend AND by the frontend (Simulator page runs the exact same
 * pure functions client-side — see Fidelity Directive #4 / §7.6.1).
 */
import type { Doc, Id } from "./_generated/dataModel";

/* ------------------------------------------------------------------ enums */

export const PRIORITIES = ["urgent", "high", "medium", "low"] as const;
export type Priority = (typeof PRIORITIES)[number];

export const ORDER_STATUSES = [
  "pending",
  "review",
  "allocated",
  "picking",
  "picked",
  "packed",
  "qc",
  "dispatched",
  "fulfilled",
  "cancelled",
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const ALERT_TYPES = [
  "low_stock",
  "stockout",
  "shortfall",
  "missing_item",
  "damaged_item",
  "bottleneck",
  "deadline_risk",
  "reorder_due",
] as const;
export type AlertType = (typeof ALERT_TYPES)[number];

export const ALERT_SEVERITIES = ["critical", "warning", "info"] as const;
export type AlertSeverity = (typeof ALERT_SEVERITIES)[number];

export const ALERT_STATUSES = ["open", "acknowledged", "resolved", "dismissed"] as const;
export type AlertStatus = (typeof ALERT_STATUSES)[number];

export const TASK_STATUSES = ["pending", "in_progress", "picked"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const SHIPMENT_STATUSES = ["in_transit", "delivered"] as const;
export type ShipmentStatus = (typeof SHIPMENT_STATUSES)[number];

export const DECISION_KINDS = [
  "allocation",
  "reallocation",
  "reorder",
  "restock",
  "priority",
  "exception",
  "simulation",
  "fulfillment",
] as const;
export type DecisionKind = (typeof DECISION_KINDS)[number];

export const TRUST_EVENTS = [
  "donor_raided",
  "deadline_missed",
  "partial_fulfilled",
  "fulfilled_on_time",
  "fulfilled_early",
] as const;
export type TrustEvent = (typeof TRUST_EVENTS)[number];

/* --------------------------------------------------- shared status groups */

/** The visible pipeline order (pending → allocated → … → fulfilled). */
export const FLOW: OrderStatus[] = [
  "pending",
  "review",
  "allocated",
  "picking",
  "picked",
  "packed",
  "qc",
  "dispatched",
  "fulfilled",
];

/** Statuses whose `allocated − picked` still reserve stock (used by computeReserved). */
export const HOLDING_STATUSES: OrderStatus[] = [
  "pending",
  "review",
  "allocated",
  "picking",
  "picked",
  "packed",
  "qc",
  "dispatched",
];

/** Statuses counted as "open" (not yet dispatched/fulfilled/cancelled). */
export const OPEN_ORDER_STATUSES: OrderStatus[] = [
  "pending",
  "review",
  "allocated",
  "picking",
  "picked",
  "packed",
  "qc",
];

/* ------------------------------------------------------------- weights */

/** §7.1 — priority weights. */
export const PRIORITY_WEIGHT: Record<Priority, number> = {
  urgent: 100,
  high: 60,
  medium: 25,
  low: 0,
};

/** §7.7.1 — trust event weights. Defined ONCE here; imported everywhere. */
export const TRUST_EVENT_WEIGHT: Record<TrustEvent, number> = {
  donor_raided: -8,
  deadline_missed: -15,
  partial_fulfilled: -5,
  fulfilled_on_time: 3,
  fulfilled_early: 5,
};

/** §7.7.3 — trust cost multipliers per priority band. */
export const TRUST_COST_MULTIPLIER: Record<Priority, number> = {
  urgent: 1.5,
  high: 1.2,
  medium: 1.0,
  low: 0.8,
};

/** §7.7.2 — trust floor below which a customer is protected from raids. */
export const TRUST_FLOOR = 40;
export const TRUST_WINDOW_DAYS = 30;
export const DONOR_STRIKE_WINDOW_HOURS = 24;

/** §7.1 — scoring caps. */
export const DEADLINE_BONUS_BANDS: { hours: number; points: number }[] = [
  { hours: 6, points: 50 },
  { hours: 24, points: 35 },
  { hours: 72, points: 15 },
];
export const AGE_BONUS_MAX = 20;
export const AGE_BONUS_PER_HOUR = 0.4;
export const PROFIT_BONUS_MAX = 15;

export const ALERT_TYPE_META: Record<AlertType, { label: string; defaultSeverity: AlertSeverity }> = {
  low_stock: { label: "Low stock", defaultSeverity: "warning" },
  stockout: { label: "Stockout", defaultSeverity: "critical" },
  shortfall: { label: "Shortfall", defaultSeverity: "critical" },
  missing_item: { label: "Missing item", defaultSeverity: "warning" },
  damaged_item: { label: "Damaged item", defaultSeverity: "warning" },
  bottleneck: { label: "Bottleneck", defaultSeverity: "warning" },
  deadline_risk: { label: "Deadline risk", defaultSeverity: "warning" },
  reorder_due: { label: "Reorder due", defaultSeverity: "info" },
};

export const PRIORITY_LABEL: Record<Priority, string> = {
  urgent: "Urgent",
  high: "High",
  medium: "Medium",
  low: "Low",
};

/* ------------------------------------------------------------ state types */

/* ------------------------------------------------- side-effect input types */

/** A fully-formed alert to upsert (produced by pure logic, committed by mutations). */
export type AlertInput = {
  type: AlertType;
  severity: AlertSeverity;
  title: string;
  message: string;
  suggestion: string;
  refType: "order" | "product" | "zone" | "system";
  refId?: string;
  dedupeKey?: string;
};

/** A decisionLog entry to write. `customer` is required on reallocation/fulfillment/exception. */
export type DecisionInput = {
  kind: DecisionKind;
  summary: string;
  detail?: string;
  outcome: string;
  customer?: string;
  refId?: string;
  trustEvent?: TrustEvent;
  createdAt: number;
};

export type ProductState = Doc<"products">;
export type OrderItemState = Doc<"orders">["items"][number];
export type OrderState = Doc<"orders">;
export type TaskState = Doc<"pickingTasks">;
export type AlertState = Doc<"alerts">;
export type ShipmentState = Doc<"shipments">;
export type DecisionLogState = Doc<"decisionLog">;

/** The slice of decisionLog the trust model aggregates (customer + event + time). */
export type TrustEntry = Pick<DecisionLogState, "customer" | "trustEvent" | "createdAt">;

/* ------------------------------------------------------------- pure helpers */

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function hoursToDeadline(deadline: number, now: number): number {
  return (deadline - now) / 3_600_000;
}

/** Revenue of an order (Σ qty × price), used by the net-benefit gate. */
export function orderRevenue(order: OrderState): number {
  return order.items.reduce((sum, item) => sum + item.qty * item.price, 0);
}

/**
 * §7.2 — reserved units for a product: Σ (allocated − picked) over orders in
 * HOLDING_STATUSES. Reserved is DERIVED (never stored on the product — the
 * schema in §6.2 defines no `reserved` field; §7.4's `product.reserved −=`
 * refers to this same derived value, recomputed after stock is picked).
 */
export function computeReserved(productId: Id<"products">, orders: OrderState[]): number {
  let reserved = 0;
  for (const order of orders) {
    if (!HOLDING_STATUSES.includes(order.status)) continue;
    for (const item of order.items) {
      if (item.productId === productId) {
        reserved += Math.max(0, item.allocated - item.picked);
      }
    }
  }
  return reserved;
}

/** §7.8 — availability snapshot for a product. */
export function availabilityFor(
  product: ProductState,
  orders: OrderState[],
): { onHand: number; reserved: number; available: number; reorderPoint: number } {
  const reserved = computeReserved(product._id, orders);
  return {
    onHand: product.onHand,
    reserved,
    available: Math.max(0, product.onHand - reserved),
    reorderPoint: product.reorderPoint,
  };
}

/** Aggregate unmet (unallocated) demand for a product across open orders. */
export function openDemand(productId: Id<"products">, orders: OrderState[]): number {
  let demand = 0;
  for (const order of orders) {
    if (!OPEN_ORDER_STATUSES.includes(order.status)) continue;
    for (const item of order.items) {
      if (item.productId === productId) {
        demand += Math.max(0, item.qty - item.allocated);
      }
    }
  }
  return demand;
}

/* -------------------------------------------------------- trust model (§7.7) */

/** §7.7.1/§7.7.2 — customer trust score, 0–100, computed ONLY from decisionLog. */
export function customerTrustScore(entries: TrustEntry[], customer: string, now: number): number {
  const cutoff = now - TRUST_WINDOW_DAYS * 86_400_000;
  let sum = 0;
  for (const entry of entries) {
    if (entry.customer !== customer || !entry.trustEvent || entry.createdAt < cutoff) continue;
    sum += TRUST_EVENT_WEIGHT[entry.trustEvent];
  }
  return clamp(100 + sum, 0, 100);
}

/** §7.7.2 — donor_raided strikes for a customer within the last 24h. */
export function recentDonorStrikes(entries: TrustEntry[], customer: string, now: number): number {
  const cutoff = now - DONOR_STRIKE_WINDOW_HOURS * 3_600_000;
  let strikes = 0;
  for (const entry of entries) {
    if (
      entry.customer === customer &&
      entry.trustEvent === "donor_raided" &&
      entry.createdAt >= cutoff
    ) {
      strikes += 1;
    }
  }
  return strikes;
}

/** §7.7.2 — donor eligibility gate: score ≥ 40 AND zero recent strikes. */
export function isDonorEligible(
  entries: TrustEntry[],
  customer: string,
  now: number,
): { eligible: boolean; reason?: string } {
  const score = customerTrustScore(entries, customer, now);
  if (score < TRUST_FLOOR) {
    return {
      eligible: false,
      reason: `trust score ${score} is below the 40-point protection floor`,
    };
  }
  const strikes = recentDonorStrikes(entries, customer, now);
  if (strikes >= 1) {
    return {
      eligible: false,
      reason: `raided ${strikes} time${strikes === 1 ? "" : "s"} in the last 24h — protection lockout active`,
    };
  }
  return { eligible: true };
}

/* --------------------------------------------------- §7.7.3 net-benefit gate */

/**
 * donorTrustCost — proportional cost of taking `units` from a donor order's line.
 * Cost scales with the fraction of the line taken, so partial draws are each
 * justified on their own terms.
 */
export function donorTrustCost(
  donorOrder: OrderState,
  lineAllocated: number,
  units: number,
): number {
  const fraction = lineAllocated > 0 ? units / lineAllocated : 1;
  return orderRevenue(donorOrder) * TRUST_COST_MULTIPLIER[donorOrder.priority] * fraction;
}

/** targetGain — revenue protected on the target order by `units` supplied. */
export function targetGain(
  targetOrder: OrderState,
  lineNeeded: number,
  units: number,
): number {
  const fraction = lineNeeded > 0 ? units / lineNeeded : 0;
  return orderRevenue(targetOrder) * fraction;
}

/** §7.7.3 — proceed with a donor only if netBenefit > 0. */
export function netBenefit(
  targetOrder: OrderState,
  lineNeeded: number,
  donorOrder: OrderState,
  lineAllocated: number,
  units: number,
): number {
  return targetGain(targetOrder, lineNeeded, units) - donorTrustCost(donorOrder, lineAllocated, units);
}

/* ----------------------------------------------------------- formatting */

export function fmtQty(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}
