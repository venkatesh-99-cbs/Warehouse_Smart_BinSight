/**
 * decisionEngine.ts — the manager decision-simulator engine (§1–§7, §16–§17).
 *
 * Every function is pure and deterministic: it re-derives state from the
 * supplied products/orders/trust entries, runs the SHARED allocation engine
 * (allocation.ts → runAllocationWave) and the SHARED metric counter
 * (simulator.ts → countMetrics), and computes every impact number from the
 * simulated world — nothing is fabricated or hardcoded per scenario.
 *
 * Business constants (blended margin, labour cost) are explicit and the UI
 * always labels them "Estimated".
 *
 * The module also exports ONE mutation, logManagerDecision, which writes the
 * §17 decision-audit entry into decisionLog. It is client-importable (same
 * pattern as simulator.ts).
 */
import { v } from "convex/values";
import { mutation } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import {
  HOLDING_STATUSES,
  OPEN_ORDER_STATUSES,
  PRIORITY_LABEL,
  computeReserved,
  customerTrustScore,
  orderRevenue,
  type OrderState,
  type ProductState,
  type TrustEntry,
} from "./domain";
import {
  findReallocationPlan,
  runAllocationWave,
  scoreOrder,
  type WaveResult,
} from "./allocation";
import { SIM_DEFAULTS, countMetrics, type Capacity } from "./simulator";
import { logActivity } from "./activities";

/* ------------------------------------------------------------ constants */

/** Blended gross margin used for the ESTIMATED profit impact (§4). */
export const ESTIMATED_MARGIN = 0.35;
/** Estimated labour cost per picked unit, used for ESTIMATED operational cost. */
export const PICK_COST_PER_UNIT = 2.5;
/** Estimated handling cost per delayed order. */
export const DELAY_HANDLING_COST = 15;

const DEFAULT_CAPACITY: Capacity = {
  pickers: SIM_DEFAULTS.pickers,
  pickingCapacity: SIM_DEFAULTS.pickingCapacity,
  packingCapacity: SIM_DEFAULTS.packingCapacity,
  disruption: "none",
};

/* ------------------------------------------------------------- crisis */

export type CustomerRisk = "high" | "medium" | "low";

export type CrisisOrder = {
  order: OrderState;
  line: OrderState["items"][number];
  product: ProductState;
  required: number;
  available: number; // usable = on hand − other reservations
  shortage: number;
  coveredPct: number;
  deadlineHours: number;
  customerRisk: CustomerRisk;
  /** Plain-language headline for the situation card (§1). */
  situation: string;
};

/**
 * §1 — derive the CURRENT operational situation: every open order that has
 * unmet demand, faces a stockout, or is inside the 24h deadline window.
 * Sorted by the same score the allocation engine uses (highest first) so the
 * manager sees the most consequential orders on top.
 */
export function detectCrisisOrders(
  products: ProductState[],
  orders: OrderState[],
  trustEntries: TrustEntry[],
  now: number,
): CrisisOrder[] {
  const productById = new Map(products.map((p) => [p._id, p]));
  const out: CrisisOrder[] = [];
  for (const order of orders) {
    if (!OPEN_ORDER_STATUSES.includes(order.status)) continue;
    if (order.status === "picked" || order.status === "packed" || order.status === "qc") continue;
    for (const line of order.items) {
      const product = productById.get(line.productId);
      if (!product) continue;
      const unmet = line.qty - line.allocated;
      const ownReservation =
        HOLDING_STATUSES.includes(order.status) ? line.allocated : 0;
      const reservedOther = Math.max(0, computeReserved(product._id, orders) - ownReservation);
      const available = Math.max(0, product.onHand - reservedOther);
      const deadlineHours = Math.max(0, (order.deadline - now) / 3_600_000);
      const isCrisis =
        unmet > 0 || product.onHand <= 0 || deadlineHours <= 24;
      if (!isCrisis) continue;
      const shortage = Math.max(0, unmet - available);
      const coveredPct =
        unmet > 0 ? Math.round((Math.min(unmet, available) / unmet) * 100) : 100;
      const trust = customerTrustScore(trustEntries, order.customer, now);
      let customerRisk: CustomerRisk = "low";
      if (order.priority === "urgent" || (order.priority === "high" && unmet > 0) || deadlineHours <= 8) {
        customerRisk = "high";
      } else if (unmet > 0 || deadlineHours <= 24 || trust < 40) {
        customerRisk = "medium";
      }
      const h = Math.round(deadlineHours);
      const situation =
        product.onHand <= 0 && unmet > 0
          ? `${order.orderNumber} (${order.customer}) needs ${line.qty} × ${product.sku} but 0 units are on hand.`
          : shortage > 0
            ? `${order.orderNumber} (${order.customer}) is ${shortage} unit(s) short of ${product.sku} — only ${available} of ${line.qty} units are available.`
            : unmet === 0
              ? `${order.orderNumber} (${order.customer}) is due in ${h}h and has not been picked yet.`
              : `${order.orderNumber} (${order.customer}) still needs ${unmet} × ${product.sku}.`;
      out.push({
        order,
        line,
        product,
        required: line.qty,
        available,
        shortage,
        coveredPct,
        deadlineHours,
        customerRisk,
        situation,
      });
    }
  }
  return out.sort(
    (a, b) =>
      scoreOrder(b.order, now) - scoreOrder(a.order, now) ||
      a.deadlineHours - b.deadlineHours,
  );
}

/* ---------------------------------------------------- decision options */

export type DecisionOptionId =
  | "allocate"
  | "reallocate"
  | "partial"
  | "wait"
  | "substitute";

export const DECISION_OPTION_ORDER: DecisionOptionId[] = [
  "reallocate",
  "allocate",
  "partial",
  "substitute",
  "wait",
];

export const DECISION_OPTION_LABEL: Record<DecisionOptionId, string> = {
  allocate: "Allocate available stock",
  reallocate: "Reallocate from lower-priority orders",
  partial: "Partial fulfillment",
  wait: "Wait for replenishment",
  substitute: "Alternative product",
};

export type DecisionContext = {
  products: ProductState[];
  orders: OrderState[];
  trustEntries: TrustEntry[];
  now: number;
  order: OrderState;
  line: OrderState["items"][number];
  product: ProductState;
  available: number;
  shortage: number;
};

export type AffectedOrder = { orderNumber: string; impact: string };

export type DecisionOption = {
  id: DecisionOptionId;
  label: string;
  description: string;
  feasible: boolean;
  whyNot?: string;
  requiresApproval: boolean;
  approvalNote?: string;
  preview?: {
    protectedOrder: string;
    affectedOrders: AffectedOrder[];
    complaints: "low" | "medium" | "high";
    revenueProtected: number;
  };
};

/**
 * §2 — the five realistic decision options, filtered by what the scenario
 * actually permits. "Reallocate" only exists when a trust-safe, profit-positive
 * donor holds reserved stock; "substitute" only when an approved same-category
 * alternative with enough available stock exists; "partial" only when there is
 * both stock to ship and a remainder to backorder; "wait" only when a
 * shortfall exists to wait out.
 */
export function buildDecisionOptions(ctx: DecisionContext): DecisionOption[] {
  const { order, line, product, available, shortage, orders, trustEntries, now } = ctx;
  const needed = shortage; // units still needed beyond available
  const plan = findReallocationPlan({
    targetOrder: order,
    product,
    allOrders: orders,
    trustEntries,
    now,
  });
  const donors = plan.donors.filter((d) => d.eligible);

  const substitute = findSubstitute(ctx);
  const drawn = Math.min(needed, plan.unitsAvailable);

  const options: DecisionOption[] = [
    {
      id: "allocate",
      label: DECISION_OPTION_LABEL.allocate,
      description:
        available > 0
          ? `Allocate all ${available} available unit(s) of ${product.sku} to ${order.orderNumber} now.`
          : `No usable stock exists for ${product.sku} — nothing to allocate.`,
      feasible: available > 0,
      whyNot: available <= 0 ? "No usable stock is available." : undefined,
      requiresApproval: false,
      preview: {
        protectedOrder: order.orderNumber,
        affectedOrders: [],
        complaints: "low",
        revenueProtected: Math.min(line.qty, available) * line.price,
      },
    },
    {
      id: "reallocate",
      label: DECISION_OPTION_LABEL.reallocate,
      description:
        donors.length > 0
          ? `Take ${drawn} unit(s) of reserved ${product.sku} from lower-priority orders and protect ${order.orderNumber}.`
          : plan.withheld
            ? "The only order holding this stock is trust-protected or profit-negative — Crisis Mode will not raid it."
            : "No other order holds reserved stock for this product.",
      feasible: donors.length > 0 && drawn > 0,
      whyNot:
        donors.length === 0
          ? plan.withheld
            ? "No trust-safe donor holds this stock."
            : "No donor order holds reserved stock."
          : undefined,
      requiresApproval: true,
      approvalNote:
        donors.length > 0
          ? `This will reduce inventory allocated to ${donors.length} lower-priority order(s).`
          : undefined,
      preview: {
        protectedOrder: order.orderNumber,
        affectedOrders: donors.map((d) => ({
          orderNumber: d.donorOrderNumber,
          impact: `Delayed — ${d.units} unit(s) reallocated`,
        })),
        complaints: "low",
        revenueProtected: drawn * line.price,
      },
    },
    {
      id: "partial",
      label: DECISION_OPTION_LABEL.partial,
      description:
        available > 0 && shortage > 0
          ? `Ship ${available} unit(s) now and backorder the remaining ${shortage}.`
          : available <= 0
            ? "There is no stock to ship — partial fulfillment is not possible."
            : "The order is fully covered — nothing to backorder.",
      feasible: available > 0 && shortage > 0,
      whyNot:
        available <= 0
          ? "No stock to ship."
          : shortage <= 0
            ? "Order is already fully covered."
            : undefined,
      requiresApproval: false,
      preview: {
        protectedOrder: order.orderNumber,
        affectedOrders: [
          { orderNumber: order.orderNumber, impact: `${shortage} unit(s) backordered` },
        ],
        complaints: "medium",
        revenueProtected: available * line.price,
      },
    },
    {
      id: "wait",
      label: DECISION_OPTION_LABEL.wait,
      description:
        shortage > 0
          ? `Hold ${order.orderNumber} until the ${product.reorderQty}-unit PO from ${product.supplier} lands (lead time ${product.leadTimeDays}d).`
          : "The order is fully covered — nothing to wait for.",
      feasible: shortage > 0,
      whyNot: shortage <= 0 ? "No shortfall to wait out." : undefined,
      requiresApproval: false,
      preview: {
        protectedOrder: order.orderNumber,
        affectedOrders: [
          {
            orderNumber: order.orderNumber,
            impact: `Held ${product.leadTimeDays}d — delivery deadline at risk`,
          },
        ],
        complaints: "high",
        revenueProtected: 0,
      },
    },
    {
      id: "substitute",
      label: DECISION_OPTION_LABEL.substitute,
      description: substitute
        ? `Fulfil with approved substitute ${substitute.sku} (${substitute.name}, ${substitute.price} each).`
        : "No approved substitute with enough available stock exists in the same category.",
      feasible: !!substitute,
      whyNot: substitute ? undefined : "No approved substitute available.",
      requiresApproval: true,
      approvalNote: substitute
        ? `Replaces the ordered product with ${substitute.sku} — the customer is notified of the substitution.`
        : undefined,
      preview: {
        protectedOrder: order.orderNumber,
        affectedOrders: substitute
          ? [
              {
                orderNumber: order.orderNumber,
                impact: `Fulfilled with ${substitute.sku} instead of ${product.sku}`,
              },
            ]
          : [],
        complaints: "medium",
        revenueProtected: substitute ? line.qty * substitute.price : 0,
      },
    },
  ];

  return options.sort(
    (a, b) =>
      Number(b.feasible) - Number(a.feasible) ||
      DECISION_OPTION_ORDER.indexOf(a.id) - DECISION_OPTION_ORDER.indexOf(b.id),
  );
}

/** §2-E — an approved substitute: same category, different SKU, enough
 *  available stock, price within ±50% of the ordered product. */
function findSubstitute(
  ctx: DecisionContext,
): ProductState | undefined {
  const { products, orders, product, line } = ctx;
  return products.find((p) => {
    if (p._id === product._id || p.sku === product.sku) return false;
    if (p.category !== product.category) return false;
    if (p.price < product.price * 0.5 || p.price > product.price * 1.5) return false;
    const reserved = computeReserved(p._id, orders);
    return p.onHand - reserved >= line.qty;
  });
}

/* ------------------------------------------------------- impact metrics */

export type ComplaintRisk = "low" | "medium" | "high";

export type ImpactMetrics = {
  revenueProtected: number;
  /** ESTIMATED — blended-margin share of revenue protected. */
  profitImpact: number;
  complaintRisk: ComplaintRisk;
  ordersProtected: number;
  ordersDelayed: number;
  fulfillmentRate: number;
  inventoryUtilization: number;
  /** ESTIMATED — labour + handling cost of the simulated state. */
  operationalCost: number;
  score: number;
  tradeOffs: string[];
};

export type DecisionSimulation = {
  optionId: DecisionOptionId;
  label: string;
  headline: string;
  why: string;
  metrics: ImpactMetrics;
  targetCoveredPct: number;
  outcomes: {
    orderNumber: string;
    customer: string;
    priority: string;
    outcome: "fulfilled" | "partial" | "blocked";
    allocatedPct: number;
    delayed: boolean;
  }[];
};

function revenueAtRisk(orders: OrderState[]): number {
  let sum = 0;
  for (const o of orders) {
    if (!OPEN_ORDER_STATUSES.includes(o.status)) continue;
    for (const item of o.items) {
      sum += Math.max(0, item.qty - item.allocated) * item.price;
    }
  }
  return sum;
}

function allocatedPct(order: OrderState): number {
  const total = order.items.reduce((s, i) => s + i.qty, 0);
  if (total <= 0) return 0;
  const alloc = order.items.reduce((s, i) => s + i.allocated, 0);
  return Math.round((alloc / total) * 100);
}

function orderDelayedByCapacity(order: OrderState, capacity: Capacity, now: number): boolean {
  if (order.items.some((i) => i.qty - i.allocated > 0)) return true;
  const capPerH = capacity.pickers * capacity.pickingCapacity;
  const packPerH = capacity.packingCapacity;
  const remainingPick = order.items.reduce((s, i) => s + Math.max(0, i.qty - i.picked), 0);
  const remainingPack = order.items.reduce((s, i) => s + Math.max(0, i.qty - i.packed), 0);
  const completion =
    (capPerH > 0 ? remainingPick / capPerH : Infinity) +
    (packPerH > 0 ? remainingPack / packPerH : Infinity);
  return !Number.isFinite(completion) || (order.deadline - now) / 3_600_000 < completion;
}

/**
 * §4/§6 — multi-objective decision score: reward protected revenue, protected
 * orders, fulfillment and inventory efficiency; penalize delays, complaint
 * risk, and every trade-off the decision creates. All inputs come from the
 * simulated state — the weights are documented business priorities.
 */
export function decisionScore(m: ImpactMetrics): number {
  const complaintPenalty =
    m.complaintRisk === "high" ? 8 : m.complaintRisk === "medium" ? 3 : 0;
  return Math.round(
    m.revenueProtected / 100 +
      2 * m.ordersProtected +
      0.5 * m.fulfillmentRate +
      0.1 * m.inventoryUtilization -
      1.5 * m.ordersDelayed -
      complaintPenalty -
      m.tradeOffs.length,
  );
}

function buildImpact(
  beforeWorld: { products: ProductState[]; orders: OrderState[] },
  afterOrders: OrderState[],
  afterProducts: ProductState[],
  revenueBefore: number,
  optionId: DecisionOptionId,
  ctx: DecisionContext,
): ImpactMetrics {
  const capacity = DEFAULT_CAPACITY;
  const before = countMetrics(beforeWorld.products, beforeWorld.orders, capacity, ctx.now);
  const after = countMetrics(afterProducts, afterOrders, capacity, ctx.now);
  const revenueAfter = revenueAtRisk(afterOrders);
  const revenueProtected = Math.max(0, revenueBefore - revenueAfter);
  const profitImpact = Math.round(revenueProtected * ESTIMATED_MARGIN);

  const beforeShort = new Set<string>();
  for (const o of beforeWorld.orders) {
    if (OPEN_ORDER_STATUSES.includes(o.status) && o.items.some((i) => i.qty - i.allocated > 0)) {
      beforeShort.add(o._id);
    }
  }
  let ordersProtected = 0;
  for (const o of afterOrders) {
    if (beforeShort.has(o._id) && !o.items.some((i) => i.qty - i.allocated > 0)) {
      ordersProtected += 1;
    }
  }

  const complaintRisk: ComplaintRisk =
    after.blocked > 0 ? "high" : after.delayed > 0 ? "medium" : "low";

  const onHand = Math.max(1, after.stockOnHand);
  const inventoryUtilization = Math.round(
    ((onHand - after.stockAvailable) / onHand) * 100,
  );

  const operationalCost = Math.round(
    after.pickingWorkload * PICK_COST_PER_UNIT + after.delayed * DELAY_HANDLING_COST,
  );

  const tradeOffs = buildTradeOffs(optionId, ctx, afterOrders, afterProducts, after);

  const metrics: ImpactMetrics = {
    revenueProtected,
    profitImpact,
    complaintRisk,
    ordersProtected,
    ordersDelayed: after.delayed,
    fulfillmentRate: after.fulfillmentRate,
    inventoryUtilization,
    operationalCost,
    score: 0,
    tradeOffs,
  };
  metrics.score = decisionScore(metrics);
  return metrics;
}

/**
 * §16 — surface the consequences of a decision honestly: every reallocation
 * that creates a new shortage, every backorder, every SKU that tips into
 * stockout. The system never pretends a decision has only positive outcomes.
 */
function buildTradeOffs(
  optionId: DecisionOptionId,
  ctx: DecisionContext,
  afterOrders: OrderState[],
  afterProducts: ProductState[],
  after: ReturnType<typeof countMetrics>,
): string[] {
  const out: string[] = [];
  const productById = new Map(afterProducts.map((p) => [p._id, p]));

  if (optionId === "reallocate") {
    for (const o of afterOrders) {
      for (const item of o.items) {
        const unmet = item.qty - item.allocated;
        if (unmet <= 0) continue;
        if (o._id === ctx.order._id) {
          if (unmet > 0) {
            out.push(
              `${ctx.order.orderNumber} is still ${unmet} unit(s) short of ${item.sku} after reallocation.`,
            );
          }
          continue;
        }
        const donorWasAllocated = ctx.orders
          .find((x) => x._id === o._id)
          ?.items.some((i) => i.sku === item.sku && i.allocated > 0);
        if (donorWasAllocated) {
          out.push(
            `Reallocating ${item.sku} protects ${ctx.order.orderNumber} but leaves ${o.orderNumber} (${o.customer}) ${unmet} unit(s) short.`,
          );
        }
      }
    }
  }
  if (optionId === "partial" || (optionId === "allocate" && ctx.shortage > 0)) {
    out.push(
      `${ctx.order.orderNumber} ships ${ctx.available} unit(s) now; ${Math.max(0, ctx.shortage)} unit(s) backordered until replenishment lands.`,
    );
  }
  if (optionId === "wait") {
    out.push(
      `Holding ${ctx.order.orderNumber} means ${ctx.line.qty} × ${ctx.product.sku} wait ${ctx.product.leadTimeDays} day(s) for the PO — the delivery deadline is at risk.`,
    );
  }
  if (optionId === "substitute") {
    const sub = afterProducts.find((p) => p.sku !== ctx.product.sku);
    if (sub) {
      out.push(
        `Substituting uses stock of ${sub.sku} — its projected on hand drops to ${Math.max(0, sub.onHand - ctx.line.qty)} unit(s).`,
      );
    }
  }
  for (const p of afterProducts) {
    if (p.onHand <= 0 && (productById.get(p._id)?.onHand ?? 0) > 0) {
      out.push(`${p.sku} tips into stockout in the simulated state.`);
    }
  }
  if (after.blocked > 0) {
    out.push(`${after.blocked} order(s) remain blocked with no stock to allocate.`);
  }
  return out;
}

/* ----------------------------------------------------- world simulation */

/**
 * Build the simulated world for a chosen option and run it through the SHARED
 * allocation engine. "wait" holds the order out of the wave entirely.
 */
function runOptionWorld(
  optionId: DecisionOptionId,
  ctx: DecisionContext,
): { products: ProductState[]; orders: OrderState[]; wave: WaveResult } {
  const products = ctx.products.map((p) => ({ ...p }));
  const orders = ctx.orders.map((o) => ({
    ...o,
    items: o.items.map((i) => ({ ...i })),
  }));
  const productById = new Map(products.map((p) => [p._id, p]));
  const target = orders.find((o) => o._id === ctx.order._id);
  const targetLine = target?.items.find((i) => i.sku === ctx.line.sku);

  if (optionId === "reallocate") {
    const plan = findReallocationPlan({
      targetOrder: ctx.order,
      product: ctx.product,
      allOrders: ctx.orders,
      trustEntries: ctx.trustEntries,
      now: ctx.now,
    });
    let need = ctx.shortage;
    for (const donor of plan.donors.filter((d) => d.eligible)) {
      if (need <= 0) break;
      const take = Math.min(need, donor.units);
      const donorOrder = orders.find((o) => o._id === donor.donorOrderId);
      const donorLine = donorOrder?.items.find((i) => i.sku === ctx.product.sku);
      if (donorLine) donorLine.allocated = Math.max(0, donorLine.allocated - take);
      if (targetLine) targetLine.allocated = Math.min(targetLine.qty, targetLine.allocated + take);
      need -= take;
    }
  } else if (optionId === "partial") {
    if (targetLine) targetLine.allocated = Math.min(targetLine.qty, ctx.available);
  } else if (optionId === "substitute") {
    const sub = findSubstitute(ctx);
    if (targetLine && sub) {
      targetLine.productId = sub._id;
      targetLine.sku = sub.sku;
      targetLine.name = sub.name;
      targetLine.price = sub.price;
      targetLine.allocated = 0;
      const subProduct = productById.get(sub._id);
      if (subProduct) subProduct.onHand = Math.max(0, subProduct.onHand - targetLine.qty);
    }
  }
  // "wait": the target order is held out of the wave entirely.
  const waveOrders =
    optionId === "wait"
      ? orders.filter((o) => o._id !== ctx.order._id)
      : orders;
  const wave = runAllocationWave(products, waveOrders, ctx.now);
  const mergedOrders =
    optionId === "wait" ? [...wave.orders, target!] : wave.orders;
  return { products: wave.products, orders: mergedOrders, wave };
}

/* ------------------------------------------------------------ simulate */

/**
 * §5/§6 — simulate a chosen decision option end-to-end and compute the
 * business impact, consequences, and the recommended-decision headline.
 */
export function simulateDecision(
  optionId: DecisionOptionId,
  ctx: DecisionContext,
): DecisionSimulation {
  const revenueBefore = revenueAtRisk(ctx.orders);
  const beforeWorld = { products: ctx.products, orders: ctx.orders };
  const { products, orders } = runOptionWorld(optionId, ctx);
  const metrics = buildImpact(beforeWorld, orders, products, revenueBefore, optionId, ctx);

  const capacity = DEFAULT_CAPACITY;
  const target = orders.find((o) => o._id === ctx.order._id);
  const targetCoveredPct = target ? allocatedPct(target) : 0;

  const outcomes: DecisionSimulation["outcomes"] = orders
    .filter((o) => OPEN_ORDER_STATUSES.includes(o.status))
    .map((o) => {
      const unmet = o.items.some((i) => i.qty - i.allocated > 0);
      const any = o.items.some((i) => i.allocated > 0);
      return {
        orderNumber: o.orderNumber,
        customer: o.customer,
        priority: o.priority,
        outcome: (unmet ? (any ? "partial" : "blocked") : "fulfilled") as "fulfilled" | "partial" | "blocked",
        allocatedPct: allocatedPct(o),
        delayed: orderDelayedByCapacity(o, capacity, ctx.now),
      };
    });

  const hours = Math.round(Math.max(0, (ctx.order.deadline - ctx.now) / 3_600_000));
  const reallocationPlan = findReallocationPlan({
    targetOrder: ctx.order,
    product: ctx.product,
    allOrders: ctx.orders,
    trustEntries: ctx.trustEntries,
    now: ctx.now,
  });
  const drawn = Math.min(ctx.shortage, reallocationPlan.unitsAvailable);
  const substitute = findSubstitute(ctx);
  const headline =
    optionId === "reallocate"
      ? `Protect ${ctx.order.orderNumber} by reallocating ${drawn} unit(s) from lower-priority orders.`
      : optionId === "allocate"
        ? `Allocate all ${ctx.available} available unit(s) of ${ctx.product.sku} to ${ctx.order.orderNumber}.`
        : optionId === "partial"
          ? `Ship ${ctx.available} unit(s) now and backorder ${ctx.shortage} for ${ctx.order.orderNumber}.`
          : optionId === "substitute" && substitute
            ? `Fulfil ${ctx.order.orderNumber} with approved substitute ${substitute.sku}.`
            : optionId === "substitute"
              ? `Substitution not possible — no approved alternative with stock.`
              : `Hold ${ctx.order.orderNumber} until replenishment lands.`;

  const why =
    optionId === "reallocate"
      ? `${ctx.order.orderNumber} is ${PRIORITY_LABEL[ctx.order.priority]} priority and due in ${hours}h with only ${ctx.available} of ${ctx.line.qty} ${ctx.product.sku} units available. Reallocating ${drawn} unit(s) from lower-priority orders covers the gap while causing only minor delays to those orders.`
      : optionId === "allocate"
        ? `${ctx.order.orderNumber} is ${PRIORITY_LABEL[ctx.order.priority]} priority and due in ${hours}h. All ${ctx.available} usable unit(s) of ${ctx.product.sku} are granted to it first under the current policy; the remaining ${ctx.shortage} unit(s) stay on backorder.`
        : optionId === "partial"
          ? `${ctx.order.orderNumber} is due in ${hours}h — shipping the ${ctx.available} available unit(s) now protects most of the order value while the ${ctx.shortage} unit(s) on backorder follow when stock arrives.`
          : optionId === "substitute"
            ? `No stock of ${ctx.product.sku} can cover ${ctx.order.orderNumber} in time, so ${substitute ? substitute.sku + " (an approved same-category alternative with enough stock) is used instead." : "no approved alternative is available."}`
            : `${ctx.order.orderNumber} waits ${ctx.product.leadTimeDays} day(s) for the ${ctx.product.reorderQty}-unit PO from ${ctx.product.supplier}; the ${hours}h deadline is likely missed.`;

  return {
    optionId,
    label: DECISION_OPTION_LABEL[optionId],
    headline,
    why,
    metrics,
    targetCoveredPct,
    outcomes,
  };
}

/* -------------------------------------------------------------- compare */

export type DecisionRow = {
  optionId: DecisionOptionId;
  label: string;
  feasible: boolean;
  profitImpact: number;
  fulfillmentRate: number;
  complaintRisk: ComplaintRisk;
  ordersDelayed: number;
  score: number;
  recommended: boolean;
};

export type DecisionComparison = {
  rows: DecisionRow[];
  recommended: DecisionOptionId;
  why: string;
};

/**
 * §7 — compare every feasible decision dynamically. The recommended option is
 * the one with the highest multi-objective score; ties break toward the
 * strategy order the engine prefers (reallocation first).
 */
export function compareDecisionOptions(ctx: DecisionContext): DecisionComparison {
  const options = buildDecisionOptions(ctx).filter((o) => o.feasible);
  const rows: DecisionRow[] = options.map((opt) => {
    const sim = simulateDecision(opt.id, ctx);
    return {
      optionId: opt.id,
      label: opt.label,
      feasible: true,
      profitImpact: sim.metrics.profitImpact,
      fulfillmentRate: sim.metrics.fulfillmentRate,
      complaintRisk: sim.metrics.complaintRisk,
      ordersDelayed: sim.metrics.ordersDelayed,
      score: sim.metrics.score,
      recommended: false,
    };
  });
  rows.sort(
    (a, b) =>
      b.score - a.score ||
      DECISION_OPTION_ORDER.indexOf(a.optionId) - DECISION_OPTION_ORDER.indexOf(b.optionId),
  );
  if (rows.length > 0) rows[0].recommended = true;
  const recommended = rows[0]?.optionId ?? "wait";
  const best = rows[0];
  const why = best
    ? `${DECISION_OPTION_LABEL[best.optionId]} scores ${best.score} — the best balance of protected revenue ($${best.profitImpact} estimated profit impact), fulfillment (${best.fulfillmentRate}%) and ${best.complaintRisk} complaint risk.`
    : "No decision option is currently feasible for this order.";
  return { rows, recommended, why };
}

/* ------------------------------------------------------- audit mutation */

/**
 * §17 — persist a manager decision to the audit trail (decisionLog). Called
 * after the manager approves and reviews the simulated impact.
 */
export const logManagerDecision = mutation({
  args: {
    optionId: v.string(),
    optionLabel: v.string(),
    orderNumber: v.string(),
    orderId: v.optional(v.string()),
    customer: v.string(),
    approval: v.string(),
    headline: v.string(),
    impact: v.string(),
    reason: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const createdAt = Date.now();
    await ctx.db.insert("decisionLog", {
      kind: "simulation",
      summary: `Manager decision: ${args.optionLabel} for ${args.orderNumber}`,
      detail: args.reason && args.reason.trim() ? args.reason.trim() : undefined,
      outcome: `${args.approval} — ${args.headline}. ${args.impact}`,
      customer: args.customer,
      refId: args.orderId,
      createdAt,
    });
    await logActivity(ctx, {
      eventType: "manager_decision",
      category: "decisions",
      description: `${args.approval} — ${args.optionLabel} for ${args.orderNumber}: ${args.headline}`,
      entityType: "order",
      entityId: args.orderId,
      orderId: args.orderId,
      newValue: args.approval,
      severity: args.approval === "Rejected" ? "warning" : "info",
      status: args.approval.toLowerCase(),
      timestamp: createdAt,
    });
    return { logged: true };
  },
});
