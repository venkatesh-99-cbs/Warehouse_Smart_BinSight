/**
 * allocation.ts — the decision core.
 *
 * Pure, exported logic (§7.6.1 single-source-of-truth): `scoreOrder`,
 * `runAllocationWave`, `findReallocationPlan`, `revenueComparison`. The
 * frontend (Simulator page, Crisis dialogs) imports these exact functions so
 * projections can never drift from production behavior. Mutations below
 * (`allocatePendingOrders`, `reallocate`) re-read DB state at execution time
 * and re-derive every quantity from it (§11).
 */
import { v } from "convex/values";
import { mutation, type MutationCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import {
  AGE_BONUS_MAX,
  AGE_BONUS_PER_HOUR,
  HOLDING_STATUSES,
  OPEN_ORDER_STATUSES,
  PRIORITY_WEIGHT,
  PROFIT_BONUS_MAX,
  clamp,
  computeReserved,
  customerTrustScore,
  donorTrustCost,
  isDonorEligible,
  netBenefit,
  openDemand,
  orderRevenue,
  targetGain,
  type AlertInput,
  type DecisionInput,
  type OrderState,
  type Priority,
  type ProductState,
  type TrustEntry,
} from "./domain";
import { findOpenAlert, logDecision, upsertAlert } from "./alerts";

/* ------------------------------------------------------------- result types */

export type WaveStats = {
  processed: number;
  fullyAllocated: number;
  partial: number;
  blocked: number;
};

export type WaveResult = {
  products: ProductState[];
  orders: OrderState[];
  stats: WaveStats;
  alerts: AlertInput[];
  /** dedupeKeys of shortfall alerts to resolve (orders that became fully covered) */
  resolveDedupeKeys: string[];
  decisions: DecisionInput[];
  changedOrderIds: Id<"orders">[];
};

export type DonorPlan = {
  donorOrderId: Id<"orders">;
  donorOrderNumber: string;
  donorCustomer: string;
  donorPriority: Priority;
  donorDeadline: number;
  /** units this donor would actually give (sequential draw) */
  units: number;
  lineAllocated: number;
  donorTrustCost: number;
  targetGain: number;
  netBenefit: number;
  trustBefore: number;
  trustAfter: number;
  eligible: boolean;
  ineligibleReason?: string;
};

export type ReallocationPlan = {
  targetOrderId: Id<"orders">;
  targetOrderNumber: string;
  productId: Id<"products">;
  sku: string;
  productName: string;
  leadTimeDays: number;
  supplier: string;
  needed: number;
  /** ranked donors: drawable (eligible) first, then ineligible with reasons */
  donors: DonorPlan[];
  unitsAvailable: number;
  /** true when no profit-positive, trust-safe donor exists */
  withheld: boolean;
  suggestion: string;
};

/* ----------------------------------------------------- §7.1 urgency scoring */

/**
 * §7.1 — urgency & bounded profit scoring breakdown. Single source for the
 * components; `scoreOrder` is the sum. profitBonus is deliberately capped at
 * 15 — smaller than a single priority tier (25+) and smaller than the ≤6h
 * deadline bonus (50) — so profit can never leapfrog an urgent/high order
 * (see the rationale in §7.1; do not uncap it).
 */
export function scoreOrderBreakdown(order: OrderState, now: number): {
  priorityPoints: number;
  deadlineBonus: number;
  ageBonus: number;
  profitBonus: number;
  total: number;
  hoursToDeadline: number;
  ageHours: number;
} {
  const hoursToDeadline = (order.deadline - now) / 3_600_000;
  let deadlineBonus = 0;
  if (hoursToDeadline <= 6) deadlineBonus = 50;
  else if (hoursToDeadline <= 24) deadlineBonus = 35;
  else if (hoursToDeadline <= 72) deadlineBonus = 15;
  const ageHours = Math.max(0, (now - order.createdAt) / 3_600_000);
  const ageBonus = Math.min(AGE_BONUS_MAX, ageHours * AGE_BONUS_PER_HOUR);
  const profitBonus = Math.min(PROFIT_BONUS_MAX, orderRevenue(order) / 100);
  return {
    priorityPoints: PRIORITY_WEIGHT[order.priority],
    deadlineBonus,
    ageBonus,
    profitBonus,
    total: PRIORITY_WEIGHT[order.priority] + deadlineBonus + ageBonus + profitBonus,
    hoursToDeadline,
    ageHours,
  };
}

/** §7.1 — urgency & bounded profit score. `now` is an explicit parameter (§7.6). */
export function scoreOrder(order: OrderState, now: number): number {
  return scoreOrderBreakdown(order, now).total;
}

type Scored = { order: OrderState; score: number };
type OrderComparator = (a: Scored, b: Scored) => number;

/** Default wave order: score descending, ties broken by createdAt ascending. */
const waveComparator: OrderComparator = (a, b) => b.score - a.score || a.order.createdAt - b.order.createdAt;

/** FIFO baseline order: createdAt ascending only (ignores scoring entirely). */
const fifoComparator: OrderComparator = (a, b) => a.order.createdAt - b.order.createdAt;

function shortfallAlertInput(
  order: OrderState,
  productById: Map<Id<"products">, ProductState>,
): AlertInput {
  const short = order.items.find((i) => i.qty - i.allocated > 0);
  if (!short) {
    return {
      type: "shortfall",
      severity: "critical",
      title: `Shortfall: ${order.orderNumber}`,
      message: `${order.orderNumber} has no open shortfall`,
      suggestion: "No action needed.",
      refType: "order",
      refId: order._id,
      dedupeKey: `shortfall:${order._id}`,
    };
  }
  const product = productById.get(short.productId);
  const needed = short.qty - short.allocated;
  return {
    type: "shortfall",
    severity: "critical",
    title: `Shortfall: ${order.orderNumber}`,
    message: `${order.orderNumber} (${order.customer}) is short ${needed} unit(s) of ${short.sku} — ${short.allocated} of ${short.qty} allocated`,
    suggestion: product
      ? `Reallocate reserved stock from a lower-priority order in Crisis Mode, or raise an emergency PO for ${short.sku} (lead time ${product.leadTimeDays}d) with ${product.supplier}`
      : `Reallocate reserved stock or raise an emergency PO for ${short.sku}`,
    refType: "order",
    refId: order._id,
    dedupeKey: `shortfall:${order._id}`,
  };
}

/**
 * Shared classification after an order's allocation pass: fully covered →
 * `allocated` (+ resolve its shortfall alert), partially granted → `review` +
 * shortfall alert, nothing granted → stays open + shortfall alert. Used by the
 * greedy engine AND the fair-allocation strategy so status transitions and
 * alerts can never diverge (§0.4).
 */
function classifyAllocated(
  order: OrderState,
  covered: boolean,
  anyGrant: boolean,
  alerts: AlertInput[],
  resolveDedupeKeys: string[],
  changedOrderIds: Id<"orders">[],
  productById: Map<Id<"products">, ProductState>,
): "allocated" | "review" | "blocked" {
  if (covered && order.items.length > 0) {
    if (order.status !== "allocated") {
      order.status = "allocated";
      changedOrderIds.push(order._id);
    }
    resolveDedupeKeys.push(`shortfall:${order._id}`);
    return "allocated";
  }
  if (anyGrant) {
    if (order.status !== "review") {
      order.status = "review";
      changedOrderIds.push(order._id);
    }
    alerts.push(shortfallAlertInput(order, productById));
    return "review";
  }
  alerts.push(shortfallAlertInput(order, productById));
  return "blocked";
}

/** §7.2.4 stock scans (low_stock / stockout / reorder_due) — shared by every strategy run. */
export function stockScanAlerts(products: ProductState[], orders: OrderState[]): AlertInput[] {
  const alerts: AlertInput[] = [];
  for (const p of products) {
    const demand = openDemand(p._id, orders);
    if (p.onHand <= 0) {
      alerts.push({
        type: "stockout",
        severity: "critical",
        title: `Stockout: ${p.sku}`,
        message: `${p.sku} is out of stock — 0 unit(s) on hand`,
        suggestion: `Raise urgent PO (${p.reorderQty} units) with ${p.supplier} (lead time ${p.leadTimeDays}d)`,
        refType: "product",
        refId: p._id,
        dedupeKey: `stockout:${p._id}`,
      });
      if (demand > 0) {
        alerts.push({
          type: "reorder_due",
          severity: "info",
          title: `Reorder due: ${p.sku}`,
          message: `${p.sku} has ${demand} unit(s) of open demand with 0 on hand`,
          suggestion: `Raise urgent PO (${p.reorderQty} units) with ${p.supplier} — open demand cannot be met`,
          refType: "product",
          refId: p._id,
          dedupeKey: `reorder_due:${p._id}`,
        });
      }
    } else if (p.onHand < p.reorderPoint) {
      alerts.push({
        type: "low_stock",
        severity: "warning",
        title: `Low stock: ${p.sku}`,
        message: `${p.sku} below reorder point — ${p.onHand} of ${p.reorderPoint} on hand`,
        suggestion: `Reorder ${p.reorderQty} units with ${p.supplier} (lead time ${p.leadTimeDays}d)`,
        refType: "product",
        refId: p._id,
        dedupeKey: `low_stock:${p._id}`,
      });
    }
  }
  return alerts;
}

/** §7.4 deadline guard — deadline_risk alert for open orders <24h out. */
export function deadlineRiskAlerts(orders: OrderState[], now: number): AlertInput[] {
  const alerts: AlertInput[] = [];
  for (const o of orders) {
    if (!OPEN_ORDER_STATUSES.includes(o.status)) continue;
    const hours = (o.deadline - now) / 3_600_000;
    if (hours < 0 || hours >= 24) continue;
    alerts.push({
      type: "deadline_risk",
      severity: "warning",
      title: `Deadline risk: ${o.orderNumber}`,
      message: `${o.orderNumber} (${o.customer}) is due in ${Math.max(0, Math.round(hours))}h — status: ${o.status}`,
      suggestion: `Expedite picking or notify ${o.customer}`,
      refType: "order",
      refId: o._id,
      dedupeKey: `deadline_risk:${o._id}`,
    });
  }
  return alerts;
}

/**
 * §7.2 core loop (steps 1–3) plus the §7.2.4 stock/§7.4 deadline scans.
 * Pure: clones its inputs, allocates greedily against `computeReserved`
 * recomputed from the in-progress order set (never a stale cached value —
 * §11.3), and returns updated state plus side effects. The Simulator calls
 * this exact function (§7.6.1).
 */
function runAllocationEngine(
  products: ProductState[],
  orders: OrderState[],
  now: number,
  comparator: OrderComparator,
): WaveResult {
  const prods = products.map((p) => ({ ...p }));
  const ords = orders.map((o) => ({ ...o, items: o.items.map((i) => ({ ...i })) }));
  const productById = new Map(prods.map((p) => [p._id, p]));
  const alerts: AlertInput[] = [];
  const resolveDedupeKeys: string[] = [];
  const changedOrderIds: Id<"orders">[] = [];

  const scored = ords
    .filter((o) => o.status === "pending" || o.status === "review")
    .map((order) => ({ order, score: scoreOrder(order, now) }));
  scored.sort(comparator);

  let processed = 0;
  let fullyAllocated = 0;
  let partial = 0;
  let blocked = 0;

  for (const { order } of scored) {
    processed += 1;
    let anyGrant = false;
    let covered = true;
    for (const item of order.items) {
      const shortfall = Math.max(0, item.qty - item.allocated);
      if (shortfall <= 0) continue;
      const product = productById.get(item.productId);
      if (!product) continue;
      const available = Math.max(0, product.onHand - computeReserved(item.productId, ords));
      const grant = Math.min(shortfall, available);
      if (grant > 0) {
        item.allocated += grant;
        anyGrant = true;
      }
      if (item.qty - item.allocated > 0) covered = false;
    }
    const cls = classifyAllocated(order, covered, anyGrant, alerts, resolveDedupeKeys, changedOrderIds, productById);
    if (cls === "allocated") fullyAllocated += 1;
    else if (cls === "review") partial += 1;
    else blocked += 1;
  }

  // §7.2.4 — stock scans (low_stock / stockout / reorder_due); shared helper so
  // every strategy run produces identical inventory alerts (§0.4).
  alerts.push(...stockScanAlerts(prods, ords));

  // §7.4 — deadline guard: deadline_risk alert for open orders <24h out
  alerts.push(...deadlineRiskAlerts(ords, now));

  const decisions: DecisionInput[] = [
    {
      kind: "allocation",
      summary: "Allocation wave executed",
      detail: `${processed} order(s) processed, ${fullyAllocated} fully allocated, ${partial} partially allocated, ${blocked} blocked.`,
      // wave-level summary entry — no single customer, so `customer` is
      // omitted ONLY here (§7.2.4), never on per-order entries.
      outcome: `${fullyAllocated} allocated · ${partial} flagged · ${blocked} blocked`,
      createdAt: now,
    },
  ];

  return {
    products: prods,
    orders: ords,
    stats: { processed, fullyAllocated, partial, blocked },
    alerts,
    resolveDedupeKeys,
    decisions,
    changedOrderIds,
  };
}

/** §7.2 — the exported wave (score-ordered). Used by the mutation AND the Simulator. */
export function runAllocationWave(
  products: ProductState[],
  orders: OrderState[],
  now: number,
): WaveResult {
  return runAllocationEngine(products, orders, now, waveComparator);
}

/** FIFO baseline for revenue comparison (§7.6) — same engine, createdAt order only. */
export function runFifoAllocation(
  products: ProductState[],
  orders: OrderState[],
  now: number,
): WaveResult {
  return runAllocationEngine(products, orders, now, fifoComparator);
}

/* ------------------------------------------- strategy allocators (§7.6 compare) */

export type AllocationStrategy = "score" | "priority" | "deadline";

/**
 * Comparator per named strategy — deterministic, tie-breaks documented inline.
 * Used by the Simulator's Compare Strategies (§4 of the simulator spec).
 */
function strategyComparator(strategy: AllocationStrategy): OrderComparator {
  switch (strategy) {
    case "score":
      return waveComparator;
    case "priority":
      // Priority First: highest priority weight first; ties → earliest deadline, then FIFO.
      return (a, b) =>
        PRIORITY_WEIGHT[b.order.priority] - PRIORITY_WEIGHT[a.order.priority] ||
        a.order.deadline - b.order.deadline ||
        a.order.createdAt - b.order.createdAt;
    case "deadline":
      // Deadline First: earliest deadline first; ties → highest priority, then FIFO.
      return (a, b) =>
        a.order.deadline - b.order.deadline ||
        PRIORITY_WEIGHT[b.order.priority] - PRIORITY_WEIGHT[a.order.priority] ||
        a.order.createdAt - b.order.createdAt;
  }
}

/** Run the §7.2 engine with a named strategy (used by the strategy comparison). */
export function runAllocationWaveWith(
  products: ProductState[],
  orders: OrderState[],
  now: number,
  strategy: AllocationStrategy,
): WaveResult {
  return runAllocationEngine(products, orders, now, strategyComparator(strategy));
}

/**
 * Fair Allocation strategy (§7.6): per SKU, distribute available units across
 * every order with unmet demand in proportion to that order's demand; the
 * integer remainder goes to the largest fractional share (ties → earliest
 * deadline). Status transitions + alerts reuse the shared classifier so the
 * four strategies can never diverge in bookkeeping (§0.4).
 */
export function runFairAllocation(
  products: ProductState[],
  orders: OrderState[],
  now: number,
): WaveResult {
  const prods = products.map((p) => ({ ...p }));
  const ords = orders.map((o) => ({ ...o, items: o.items.map((i) => ({ ...i })) }));
  const productById = new Map(prods.map((p) => [p._id, p]));
  const alerts: AlertInput[] = [];
  const resolveDedupeKeys: string[] = [];
  const changedOrderIds: Id<"orders">[] = [];

  const queue = ords.filter((o) => o.status === "pending" || o.status === "review");

  for (const p of prods) {
    const available = Math.max(0, p.onHand - computeReserved(p._id, ords));
    if (available <= 0) continue;
    const demanders = queue
      .map((order) => ({ order, item: order.items.find((i) => i.productId === p._id) }))
      .filter(
        (d): d is { order: OrderState; item: OrderState["items"][number] } =>
          !!d.item && d.item.qty - d.item.allocated > 0,
      )
      .sort((a, b) => a.order.createdAt - b.order.createdAt);
    if (demanders.length === 0) continue;
    const totalDemand = demanders.reduce((s, d) => s + (d.item.qty - d.item.allocated), 0);
    if (available >= totalDemand) {
      for (const d of demanders) d.item.allocated = d.item.qty;
      continue;
    }
    const shares = demanders.map((d) => {
      const unmet = d.item.qty - d.item.allocated;
      return { d, unmet, share: (available * unmet) / totalDemand };
    });
    let remaining = available;
    for (const s of shares) {
      const grant = Math.min(s.unmet, Math.floor(s.share));
      s.d.item.allocated += grant;
      remaining -= grant;
    }
    shares.sort(
      (a, b) =>
        b.share - Math.floor(b.share) - (a.share - Math.floor(a.share)) ||
        a.d.order.deadline - b.d.order.deadline,
    );
    for (const s of shares) {
      if (remaining <= 0) break;
      const grant = Math.min(remaining, s.d.item.qty - s.d.item.allocated);
      s.d.item.allocated += grant;
      remaining -= grant;
    }
  }

  let fullyAllocated = 0;
  let partial = 0;
  let blocked = 0;
  for (const order of queue) {
    let anyGrant = false;
    let covered = true;
    for (const item of order.items) {
      if (item.allocated > 0 && item.qty - item.allocated > 0) anyGrant = true;
      if (item.qty - item.allocated > 0) covered = false;
    }
    const cls = classifyAllocated(
      order,
      covered,
      anyGrant,
      alerts,
      resolveDedupeKeys,
      changedOrderIds,
      productById,
    );
    if (cls === "allocated") fullyAllocated += 1;
    else if (cls === "review") partial += 1;
    else blocked += 1;
  }

  alerts.push(...stockScanAlerts(prods, ords));
  alerts.push(...deadlineRiskAlerts(ords, now));

  const decisions: DecisionInput[] = [
    {
      kind: "allocation",
      summary: "Allocation wave executed (fair-share)",
      detail: `${queue.length} order(s) processed, ${fullyAllocated} fully allocated, ${partial} partially allocated, ${blocked} blocked.`,
      outcome: `${fullyAllocated} allocated · ${partial} flagged · ${blocked} blocked (fair-share)`,
      createdAt: now,
    },
  ];

  return {
    products: prods,
    orders: ords,
    stats: { processed: queue.length, fullyAllocated, partial, blocked },
    alerts,
    resolveDedupeKeys,
    decisions,
    changedOrderIds,
  };
}

/* --------------------------------------------------- §7.7.3 reallocation plan */

/**
 * Shared reallocation-eligibility computation (§7.3 steps 3–6): finds every
 * order holding reserved units of the product, filters trust-eligible donors,
 * ranks them (cost asc → priority weight asc → deadline desc), and simulates
 * the sequential draw with the netBenefit gate. Used by the `reallocate`
 * mutation, the Simulator, and the Crisis Mode Reallocate dialog — one
 * implementation, everywhere.
 */
export function findReallocationPlan(params: {
  targetOrder: OrderState;
  product: ProductState;
  allOrders: OrderState[];
  trustEntries: TrustEntry[];
  now: number;
}): ReallocationPlan {
  const { targetOrder, product, allOrders, trustEntries, now } = params;
  const base = {
    targetOrderId: targetOrder._id,
    targetOrderNumber: targetOrder.orderNumber,
    productId: product._id,
    sku: product.sku,
    productName: product.name,
    leadTimeDays: product.leadTimeDays,
    supplier: product.supplier,
  };
  const line = targetOrder.items.find(
    (i) => i.productId === product._id && i.qty - i.allocated > 0,
  );
  if (!line) {
    return {
      ...base,
      needed: 0,
      donors: [],
      unitsAvailable: 0,
      withheld: true,
      suggestion: `No reallocation needed — ${targetOrder.orderNumber} is fully allocated on ${product.sku}`,
    };
  }
  const needed = line.qty - line.allocated;

  const candidates = allOrders
    .filter((o) => o._id !== targetOrder._id && HOLDING_STATUSES.includes(o.status))
    .map((o) => ({ order: o, dLine: o.items.find((i) => i.productId === product._id) }))
    .filter(
      (c): c is { order: OrderState; dLine: OrderState["items"][number] } =>
        !!c.dLine && c.dLine.allocated - c.dLine.picked >= 1,
    );

  // rank: (a) ascending donorTrustCost, (b) ascending priority weight,
  // (c) descending hours-until-deadline (§7.3 step 5)
  const ranked = [...candidates].sort((a, b) => {
    const unitsA = Math.min(needed, a.dLine.allocated - a.dLine.picked);
    const unitsB = Math.min(needed, b.dLine.allocated - b.dLine.picked);
    const costA = donorTrustCost(a.order, a.dLine.allocated, unitsA);
    const costB = donorTrustCost(b.order, b.dLine.allocated, unitsB);
    return (
      costA - costB ||
      PRIORITY_WEIGHT[a.order.priority] - PRIORITY_WEIGHT[b.order.priority] ||
      (b.order.deadline - now) - (a.order.deadline - now)
    );
  });

  const donors: DonorPlan[] = [];
  let remaining = needed;

  for (const { order: donor, dLine } of ranked) {
    const held = dLine.allocated - dLine.picked;
    const units = Math.min(remaining, held);
    if (units <= 0) break;
    const cost = donorTrustCost(donor, dLine.allocated, units);
    const gain = targetGain(targetOrder, needed, units);
    const nb = gain - cost;
    const eligibility = isDonorEligible(trustEntries, donor.customer, now);
    const trustBefore = customerTrustScore(trustEntries, donor.customer, now);
    const eligible = eligibility.eligible && nb > 0;
    const ineligibleReason = eligibility.eligible
      ? nb <= 0
        ? `net benefit ${fmtMoney(nb)} is not positive — drawing would cost more trust than the revenue it protects`
        : undefined
      : eligibility.reason;
    donors.push({
      donorOrderId: donor._id,
      donorOrderNumber: donor.orderNumber,
      donorCustomer: donor.customer,
      donorPriority: donor.priority,
      donorDeadline: donor.deadline,
      units,
      lineAllocated: dLine.allocated,
      donorTrustCost: cost,
      targetGain: gain,
      netBenefit: nb,
      trustBefore,
      trustAfter: clamp(trustBefore - 8, 0, 100),
      eligible,
      ineligibleReason,
    });
    if (!eligible) {
      // §7.3 step 6: if netBenefit ≤ 0 for this donor, stop — do not draw from
      // this donor or any lower-ranked one, even if the target remains short.
      if (nb <= 0) break;
      // trust-ineligible donors are excluded entirely (step 4) but still
      // listed so the UI can explain WHY (test 4 in §16).
      continue;
    }
    remaining -= units;
    if (remaining <= 0) break;
  }

  const drawable = donors.filter((d) => d.eligible);
  const unitsAvailable = drawable.reduce((sum, d) => sum + d.units, 0);
  const withheld = drawable.length === 0;

  const suggestion = withheld
    ? `No trust-safe reallocation available — raise an emergency PO for ${product.sku} (lead time ${product.leadTimeDays}d) with ${product.supplier}`
    : `Reallocate ${unitsAvailable} unit(s) from ${drawable
        .map((d) => `${d.donorOrderNumber} (${d.donorCustomer})`)
        .join(", ")} (lower priority), or raise an emergency PO`;

  return {
    ...base,
    needed,
    donors,
    unitsAvailable,
    withheld,
    suggestion,
  };
}

function fmtMoney(n: number): string {
  return `$${Math.abs(n) < 0.01 ? "0.00" : n.toFixed(2)}`;
}

/* --------------------------------------------- revenue captured vs FIFO (§7.6) */

function capturedFullyAllocatedRevenue(
  result: WaveResult,
  before: Map<Id<"orders">, OrderState>,
): number {
  let sum = 0;
  for (const order of result.orders) {
    const orig = before.get(order._id);
    if (!orig || (orig.status !== "pending" && orig.status !== "review")) continue;
    if (order.items.length === 0) continue;
    if (order.items.every((i) => i.allocated >= i.qty)) sum += orderRevenue(order);
  }
  return sum;
}

/**
 * §7.6/§7.8 — revenue captured under score-ordered allocation vs a naive FIFO
 * baseline, recomputed live from current state (never hardcoded). Both runs use
 * the exact same engine; only the ordering comparator differs. "Captured"
 * counts the full revenue of orders the wave makes shippable (fully allocated).
 */
export function revenueComparison(
  products: ProductState[],
  orders: OrderState[],
  now: number,
): { scoreCaptured: number; fifoCaptured: number; delta: number } {
  const before = new Map(orders.map((o) => [o._id, o]));
  const score = runAllocationWave(products, orders, now);
  const fifo = runFifoAllocation(products, orders, now);
  const scoreCaptured = capturedFullyAllocatedRevenue(score, before);
  const fifoCaptured = capturedFullyAllocatedRevenue(fifo, before);
  return { scoreCaptured, fifoCaptured, delta: scoreCaptured - fifoCaptured };
}

/* ------------------------------------------------------------ mutations */

/**
 * Shared writer used by `allocatePendingOrders` and the Simulator's Apply:
 * runs the pure wave against freshly-read DB state and commits every side
 * effect (alerts, order patches, decisionLog) with dedupe via upserts.
 */
export async function commitAllocationWave(ctx: MutationCtx, now: number): Promise<WaveStats> {
  const [products, orders] = await Promise.all([
    ctx.db.query("products").collect(),
    ctx.db.query("orders").collect(),
  ]);
  const result = runAllocationWave(products, orders, now);

  for (const alert of result.alerts) {
    await upsertAlert(ctx, alert, now);
  }
  for (const key of result.resolveDedupeKeys) {
    const open = await findOpenAlert(ctx, key);
    if (open) {
      await ctx.db.patch(open._id, {
        status: "resolved",
        resolvedAt: now,
        decision: "order fully allocated by allocation wave",
      });
    }
  }
  const origById = new Map(orders.map((o) => [o._id, o]));
  for (const order of result.orders) {
    const orig = origById.get(order._id);
    if (!orig) continue;
    const itemsChanged = JSON.stringify(orig.items) !== JSON.stringify(order.items);
    if (order.status !== orig.status || itemsChanged) {
      await ctx.db.patch(order._id, {
        status: order.status,
        items: order.items,
        updatedAt: now,
      });
    }
  }
  for (const decision of result.decisions) {
    await ctx.db.insert("decisionLog", decision);
  }
  return result.stats;
}

/** §7.2 — run the allocation wave (sidebar button). */
export const allocatePendingOrders = mutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const stats = await commitAllocationWave(ctx, now);
    return { applied: true, stats };
  },
});

/**
 * §7.3 — the competitive twist. Resolves `{ alertId }` (never raw ids), re-fetches
 * every entity, applies the trust-safe, profit-positive reallocation plan, and
 * logs each donor raid. Idempotent: an already-resolved alert short-circuits.
 */
export const reallocate = mutation({
  args: { alertId: v.id("alerts") },
  handler: async (ctx, { alertId }) => {
    const now = Date.now();

    // §7.3 step 1 — re-fetch the alert; stale/already-resolved alerts no-op.
    const alert = await ctx.db.get(alertId);
    if (!alert || alert.status !== "open" || alert.type !== "shortfall") {
      return { applied: false, reason: "alert no longer open" };
    }

    // §7.3 step 2 — re-fetch target order + product from the DB.
    const target = alert.refId ? await ctx.db.get(alert.refId as Id<"orders">) : null;
    if (!target) return { applied: false, reason: "target order not found" };
    const shortLine = target.items.reduce<OrderState["items"][number] | null>(
      (best, item) =>
        item.qty - item.allocated > (best ? best.qty - best.allocated : -1) ? item : best,
      null,
    );
    if (!shortLine || shortLine.qty - shortLine.allocated <= 0) {
      return { applied: false, reason: "target order has no open shortfall" };
    }
    const product = await ctx.db.get(shortLine.productId);
    if (!product) return { applied: false, reason: "product not found" };

    const [allOrders, trustEntries] = await Promise.all([
      ctx.db.query("orders").collect(),
      ctx.db.query("decisionLog").collect(),
    ]);
    const plan = findReallocationPlan({
      targetOrder: target,
      product,
      allOrders,
      trustEntries,
      now,
    });

    // §7.3 step 8 — withheld: no profit-positive, trust-safe donor exists.
    // (This is the required URG-2002 behavior — a pass/fail condition.)
    if (plan.withheld) {
      await ctx.db.patch(alert._id, { suggestion: plan.suggestion });
      await logDecision(ctx, {
        kind: "exception",
        summary: `Reallocation withheld for ${target.orderNumber}`,
        detail: `Only trust-protected or unprofitable donors hold reserved ${product.sku}`,
        outcome: "reallocation withheld — no profit-positive, trust-safe donor",
        customer: target.customer,
        refId: target._id,
        createdAt: now,
      });
      return {
        applied: false,
        reason: "no trust-safe donor",
        withheld: true,
        suggestion: plan.suggestion,
        donors: plan.donors,
      };
    }

    // §7.3 steps 6–7 — draw from eligible donors in ranked order.
    const donorsApplied: {
      donorOrderId: Id<"orders">;
      donorOrderNumber: string;
      units: number;
      customer: string;
    }[] = [];

    for (const donorPlan of plan.donors.filter((d) => d.eligible)) {
      // re-fetch donor AND target fresh (§11.1) — never trust cached quantities
      const donor = await ctx.db.get(donorPlan.donorOrderId);
      const liveTarget = await ctx.db.get(target._id);
      if (!donor || !liveTarget) break;
      const dLine = donor.items.find((i) => i.productId === product._id);
      const tLine = liveTarget.items.find((i) => i.productId === product._id);
      if (!dLine || !tLine) break;
      const held = dLine.allocated - dLine.picked;
      const remainingNeeded = tLine.qty - tLine.allocated;
      if (held <= 0 || remainingNeeded <= 0) break;
      const units = Math.min(held, remainingNeeded);

      const donorItems = donor.items.map((i) =>
        i.productId === product._id ? { ...i, allocated: i.allocated - units } : i,
      );
      const donorLineAfter = donorItems.find((i) => i.productId === product._id)!;
      const donorShort = Math.max(0, donorLineAfter.qty - donorLineAfter.allocated);

      await ctx.db.patch(donor._id, {
        items: donorItems,
        status:
          donorShort > 0 && donor.status === "allocated" ? "review" : donor.status,
        updatedAt: now,
      });

      // §7.3 step 7 — donor backorder alert + one reallocation decisionLog entry
      if (donorShort > 0) {
        await upsertAlert(
          ctx,
          {
            type: "shortfall",
            severity: "critical",
            title: `Shortfall: ${donor.orderNumber}`,
            message: `${donor.orderNumber} (${donor.customer}) is short ${donorShort} unit(s) of ${product.sku} — ${donorLineAfter.allocated} of ${donorLineAfter.qty} allocated`,
            suggestion: `Awaiting restock — ${units} unit(s) reallocated to order ${target.orderNumber}`,
            refType: "order",
            refId: donor._id,
            dedupeKey: `shortfall:${donor._id}`,
          },
          now,
        );
      }
      await logDecision(ctx, {
        kind: "reallocation",
        summary: `Reallocated ${units} × ${product.sku} from ${donor.orderNumber} to ${target.orderNumber}`,
        detail: `Trust cost ${fmtMoney(
          donorTrustCost(donor, dLine.allocated, units),
        )} vs gain ${fmtMoney(targetGain(target, remainingNeeded + units, units))}`,
        outcome: `${units} unit(s) of ${product.sku} moved from ${donor.orderNumber} (${donor.customer}) to ${target.orderNumber}`,
        customer: donor.customer,
        refId: target._id,
        trustEvent: "donor_raided",
        createdAt: now,
      });
      donorsApplied.push({
        donorOrderId: donor._id,
        donorOrderNumber: donor.orderNumber,
        units,
        customer: donor.customer,
      });

      // reflect the transfer on the local target so the next donor draws correctly
      target.items = liveTarget.items.map((i) =>
        i.productId === product._id ? { ...i, allocated: i.allocated + units } : i,
      );
      target.status = liveTarget.status;
    }

    // §7.3 step 8 re-check on the freshly-persisted target
    const finalTarget = await ctx.db.get(target._id);
    if (!finalTarget) return { applied: false, reason: "target order disappeared" };
    const finalLine = finalTarget.items.find((i) => i.productId === product._id);
    const remainingNeeded = finalLine ? Math.max(0, finalLine.qty - finalLine.allocated) : 0;

    if (remainingNeeded === 0) {
      await ctx.db.patch(finalTarget._id, { status: "allocated", updatedAt: now });
      await ctx.db.patch(alert._id, {
        status: "resolved",
        resolvedAt: now,
        decision: `reallocated from ${donorsApplied.map((d) => d.donorOrderNumber).join(", ")}`,
        donorOrderId: donorsApplied[0]?.donorOrderId,
      });
    } else {
      await ctx.db.patch(alert._id, {
        suggestion: `Still short ${remainingNeeded} unit(s) of ${product.sku} — raise an emergency PO (lead time ${product.leadTimeDays}d) with ${product.supplier}`,
        donorOrderId: donorsApplied[0]?.donorOrderId,
      });
    }

    return {
      applied: true,
      donors: donorsApplied,
      targetCovered: remainingNeeded === 0,
      remainingNeeded,
    };
  },
});
