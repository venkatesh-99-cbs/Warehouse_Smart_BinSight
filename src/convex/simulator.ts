/**
 * simulator.ts — §7.6 what-if projection + the professional decision-support
 * report (scenario → exception → decision → resolution → impact) + Apply.
 *
 * Pure and deterministic (§7.6.1): every allocation run goes through the
 * exported engine functions in allocation.ts, trust math through domain.ts,
 * and every metric in the report is computed from the simulated state — never
 * hardcoded. The frontend runs `runSimulation`/`compareStrategies` client-side
 * for the interactive preview; `applySimulation` re-validates against live DB
 * state before committing (§11).
 */
import { v } from "convex/values";
import { mutation } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import {
  OPEN_ORDER_STATUSES,
  computeReserved,
  openDemand,
  type AlertSeverity,
  type OrderState,
  type Priority,
  type ProductState,
  type TrustEntry,
} from "./domain";
import {
  commitAllocationWave,
  findReallocationPlan,
  revenueComparison,
  runAllocationWave,
  runAllocationWaveWith,
  runFairAllocation,
  scoreOrder,
  scoreOrderBreakdown,
  type ReallocationPlan,
  type WaveResult,
} from "./allocation";
import { logDecision } from "./alerts";

/* ------------------------------------------------------------ input types */

export type SimAddLine = { sku: string; qty: number; priority: Priority; deadline: number };
export type SimPriorityOverride = { orderId: string; priority: Priority };
export type SimIncomingStock = { sku: string; qty: number };
export type SimStockAdjust = { sku: string; qty: number };
export type SimOrderDelay = { orderId: string; hours: number };
export type SimDisruption = "none" | "zone_offline" | "power_outage" | "staff_shortage";

export type SimInputs = {
  addLines: SimAddLine[];
  priorityOverrides: SimPriorityOverride[];
  incomingStock: SimIncomingStock[];
  damagedUnits: SimStockAdjust[];
  missingUnits: SimStockAdjust[];
  orderDelays: SimOrderDelay[];
  pickers: number;
  pickingCapacity: number;
  packingCapacity: number;
  disruption: SimDisruption;
};

/** Sensible defaults for the operational knobs — used when a field is absent. */
export const SIM_DEFAULTS = {
  pickers: 4,
  pickingCapacity: 30, // units per picker per hour
  packingCapacity: 60, // units per hour
  disruption: "none",
} as const;

export const simAddLineValidator = v.object({
  sku: v.string(),
  qty: v.number(),
  priority: v.union(v.literal("urgent"), v.literal("high"), v.literal("medium"), v.literal("low")),
  deadline: v.number(),
});
export const simPriorityOverrideValidator = v.object({
  orderId: v.string(),
  priority: v.union(v.literal("urgent"), v.literal("high"), v.literal("medium"), v.literal("low")),
});
export const simIncomingStockValidator = v.object({ sku: v.string(), qty: v.number() });
export const simStockAdjustValidator = v.object({ sku: v.string(), qty: v.number() });
export const simOrderDelayValidator = v.object({ orderId: v.string(), hours: v.number() });
export const simDisruptionValidator = v.union(
  v.literal("none"),
  v.literal("zone_offline"),
  v.literal("power_outage"),
  v.literal("staff_shortage"),
);

export const simInputsValidator = v.object({
  addLines: v.array(simAddLineValidator),
  priorityOverrides: v.array(simPriorityOverrideValidator),
  incomingStock: v.array(simIncomingStockValidator),
  damagedUnits: v.array(simStockAdjustValidator),
  missingUnits: v.array(simStockAdjustValidator),
  orderDelays: v.array(simOrderDelayValidator),
  pickers: v.number(),
  pickingCapacity: v.number(),
  packingCapacity: v.number(),
  disruption: simDisruptionValidator,
});

export type SimValidationError = { field: string; message: string };

/**
 * Validate EVERY input before projection (§2 of the simulator spec): whole,
 * positive quantities; SKUs/order ids must resolve (never silently ignore an
 * unknown SKU); damaged/missing must not exceed on-hand stock; deadlines must
 * be in the future; capacity knobs must be non-negative.
 */
export function validateSimInputs(
  inputs: SimInputs,
  products: ProductState[],
  orders: OrderState[],
  now = Date.now(),
): { ok: boolean; errors: SimValidationError[] } {
  const errors: SimValidationError[] = [];
  const skus = new Set(products.map((p) => p.sku));
  const bySku = new Map(products.map((p) => [p.sku, p]));
  const orderIds = new Set(orders.map((o) => o._id));

  const checkQty = (qty: number): string | null => {
    if (!Number.isFinite(qty)) return "quantity is required";
    if (qty <= 0) return "quantity must be greater than 0";
    if (!Number.isInteger(qty)) return "quantity must be a whole number";
    return null;
  };

  inputs.addLines.forEach((line, i) => {
    const qe = checkQty(line.qty);
    if (qe) errors.push({ field: `add.${i}.qty`, message: `Line ${i + 1}: ${qe}` });
    if (!skus.has(line.sku)) {
      errors.push({
        field: `add.${i}.sku`,
        message: `Line ${i + 1}: unknown SKU "${line.sku}" — enter an existing product SKU`,
      });
    }
    if (!Number.isFinite(line.deadline)) {
      errors.push({ field: `add.${i}.deadline`, message: `Line ${i + 1}: deadline is required` });
    } else if (line.deadline <= now) {
      errors.push({ field: `add.${i}.deadline`, message: `Line ${i + 1}: deadline must be in the future` });
    }
  });
  inputs.priorityOverrides.forEach((o, i) => {
    if (!orderIds.has(o.orderId as Id<"orders">)) {
      errors.push({
        field: `override.${i}.orderId`,
        message: `Override ${i + 1}: unknown order — pick an existing order`,
      });
    }
  });
  inputs.incomingStock.forEach((s, i) => {
    const qe = checkQty(s.qty);
    if (qe) errors.push({ field: `stock.${i}.qty`, message: `Stock ${i + 1}: ${qe}` });
    if (!skus.has(s.sku)) {
      errors.push({
        field: `stock.${i}.sku`,
        message: `Stock ${i + 1}: unknown SKU "${s.sku}" — enter an existing product SKU`,
      });
    }
  });
  inputs.damagedUnits.forEach((s, i) => {
    const qe = checkQty(s.qty);
    if (qe) errors.push({ field: `damaged.${i}.qty`, message: `Damaged ${i + 1}: ${qe}` });
    if (!skus.has(s.sku)) {
      errors.push({
        field: `damaged.${i}.sku`,
        message: `Damaged ${i + 1}: unknown SKU "${s.sku}"`,
      });
    } else {
      const onHand = bySku.get(s.sku)!.onHand;
      if (Number.isFinite(s.qty) && s.qty > onHand) {
        errors.push({
          field: `damaged.${i}.qty`,
          message: `Damaged ${i + 1}: ${s.qty} exceeds the ${onHand} unit(s) on hand for ${s.sku}`,
        });
      }
    }
  });
  inputs.missingUnits.forEach((s, i) => {
    const qe = checkQty(s.qty);
    if (qe) errors.push({ field: `missing.${i}.qty`, message: `Missing ${i + 1}: ${qe}` });
    if (!skus.has(s.sku)) {
      errors.push({
        field: `missing.${i}.sku`,
        message: `Missing ${i + 1}: unknown SKU "${s.sku}"`,
      });
    } else {
      const onHand = bySku.get(s.sku)!.onHand;
      if (Number.isFinite(s.qty) && s.qty > onHand) {
        errors.push({
          field: `missing.${i}.qty`,
          message: `Missing ${i + 1}: ${s.qty} exceeds the ${onHand} unit(s) on hand for ${s.sku}`,
        });
      }
    }
  });
  inputs.orderDelays.forEach((d, i) => {
    if (!orderIds.has(d.orderId as Id<"orders">)) {
      errors.push({ field: `delay.${i}.orderId`, message: `Delay ${i + 1}: unknown order` });
    }
    if (!Number.isFinite(d.hours) || d.hours <= 0 || d.hours > 720) {
      errors.push({
        field: `delay.${i}.hours`,
        message: `Delay ${i + 1}: hours must be between 1 and 720`,
      });
    }
  });
  if (!Number.isFinite(inputs.pickers) || inputs.pickers < 0 || inputs.pickers > 50) {
    errors.push({ field: "pickers", message: "Available pickers must be between 0 and 50" });
  }
  if (!Number.isFinite(inputs.pickingCapacity) || inputs.pickingCapacity < 0) {
    errors.push({ field: "pickingCapacity", message: "Picking capacity must be 0 or more" });
  }
  if (!Number.isFinite(inputs.packingCapacity) || inputs.packingCapacity < 0) {
    errors.push({ field: "packingCapacity", message: "Packing capacity must be 0 or more" });
  }

  return { ok: errors.length === 0, errors };
}

/* ------------------------------------------------------------- capacity */

export type Capacity = {
  pickers: number;
  pickingCapacity: number; // effective units per picker per hour (after disruption)
  packingCapacity: number; // effective units per hour (after disruption)
  disruption: SimDisruption;
};

/** Effective capacity — disruption penalties applied exactly once, here. */
export function capacityFrom(inputs: SimInputs): Capacity {
  let pickers = inputs.pickers ?? SIM_DEFAULTS.pickers;
  let pickingCapacity = inputs.pickingCapacity ?? SIM_DEFAULTS.pickingCapacity;
  let packingCapacity = inputs.packingCapacity ?? SIM_DEFAULTS.packingCapacity;
  const disruption = inputs.disruption ?? SIM_DEFAULTS.disruption;
  if (disruption === "staff_shortage") pickers = Math.max(0, pickers - 1);
  if (disruption === "zone_offline") pickingCapacity *= 0.5;
  if (disruption === "power_outage") {
    pickingCapacity *= 0.3;
    packingCapacity *= 0.3;
  }
  return { pickers, pickingCapacity, packingCapacity, disruption };
}

/* -------------------------------------------------------- world prep (§2) */

export type PreparedWorld = { products: ProductState[]; orders: OrderState[]; capacity: Capacity };

/**
 * Build the simulated world: clone, apply incoming stock, remove damaged +
 * missing units from usable stock, apply priority overrides + deadline delays,
 * then insert new order lines (synthetic ids — projected only, never persisted).
 */
export function prepareWorld(
  inputs: SimInputs,
  ctx: { products: ProductState[]; orders: OrderState[]; now: number },
): PreparedWorld {
  const { products: sourceProducts, orders: sourceOrders, now } = ctx;
  const products = sourceProducts.map((p) => ({ ...p }));
  const orders = sourceOrders.map((o) => ({ ...o, items: o.items.map((i) => ({ ...i })) }));
  const productBySku = new Map(products.map((p) => [p.sku, p]));

  for (const s of inputs.incomingStock) {
    const p = productBySku.get(s.sku);
    if (p) p.onHand += s.qty;
  }
  for (const s of inputs.damagedUnits) {
    const p = productBySku.get(s.sku);
    if (p) p.onHand = Math.max(0, p.onHand - s.qty);
  }
  for (const s of inputs.missingUnits) {
    const p = productBySku.get(s.sku);
    if (p) p.onHand = Math.max(0, p.onHand - s.qty);
  }
  for (const o of inputs.priorityOverrides) {
    const order = orders.find((x) => x._id === o.orderId);
    if (order) order.priority = o.priority;
  }
  for (const d of inputs.orderDelays) {
    const order = orders.find((x) => x._id === d.orderId);
    if (order) order.deadline += d.hours * 3_600_000;
  }

  let counter = 1;
  for (const line of inputs.addLines) {
    const p = productBySku.get(line.sku);
    if (!p) continue;
    const id = `sim-${counter++}` as Id<"orders">;
    orders.push({
      _id: id,
      _creationTime: now,
      orderNumber: `SIM-${String(1000 + counter).padStart(4, "0")}`,
      customer: "Simulation (what-if)",
      priority: line.priority,
      status: "pending",
      items: [
        {
          productId: p._id,
          sku: p.sku,
          name: p.name,
          qty: line.qty,
          allocated: 0,
          picked: 0,
          packed: 0,
          price: p.price,
        },
      ],
      deadline: line.deadline,
      createdAt: now,
      updatedAt: now,
    });
  }

  return { products, orders, capacity: capacityFrom(inputs) };
}

/* -------------------------------------------------------------- metrics */

export type BottleneckLevel = "none" | "warning" | "critical";
export type StrategyId = "policy" | "priority" | "deadline" | "fair";

export type MetricCore = {
  fullyFulfilled: number;
  partiallyFulfilled: number;
  delayed: number;
  blocked: number;
  unitsAllocated: number;
  unitsRemaining: number;
  backorderedUnits: number;
  stockoutCount: number;
  fulfillmentRate: number;
  pickingWorkload: number;
  pickHours: number;
  packHours: number;
  bottleneckLevel: BottleneckLevel;
  stockOnHand: number;
  stockReserved: number;
  stockAvailable: number;
};

export type StrategyMetrics = MetricCore & { strategy: StrategyId; label: string; score: number };

/** An order is delayed if it cannot ship by its deadline: blocked, partial, or
 *  fully allocated but past the projected picking+packing completion time. */
function orderDelayed(order: OrderState, capacity: Capacity, now: number): boolean {
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
 * Count every §4 metric from a (possibly simulated) world. Internal consistency
 * is guaranteed by construction: allocated ≤ qty, usable = onHand − reserved,
 * remaining = usable − newly allocated — all derived, never stored.
 */
export function countMetrics(
  products: ProductState[],
  orders: OrderState[],
  capacity: Capacity,
  now: number,
): MetricCore {
  const open = orders.filter((o) => OPEN_ORDER_STATUSES.includes(o.status));
  const pickReady = orders.filter(
    (o) => o.status === "allocated" || o.status === "picking" || o.status === "picked",
  );
  const packQueue = orders.filter(
    (o) => o.status === "picked" || o.status === "packed" || o.status === "qc",
  );

  let fully = 0;
  let partial = 0;
  let blocked = 0;
  let delayed = 0;
  let allocatedUnits = 0;
  let orderedUnits = 0;
  let backordered = 0;
  for (const o of open) {
    const unmet = o.items.some((i) => i.qty - i.allocated > 0);
    const any = o.items.some((i) => i.allocated > 0);
    allocatedUnits += o.items.reduce((s, i) => s + i.allocated, 0);
    orderedUnits += o.items.reduce((s, i) => s + i.qty, 0);
    backordered += o.items.reduce((s, i) => s + Math.max(0, i.qty - i.allocated), 0);
    if (!unmet) fully += 1;
    else if (any) partial += 1;
    else blocked += 1;
    if (orderDelayed(o, capacity, now)) delayed += 1;
  }

  const pickingWorkload = pickReady.reduce(
    (s, o) => s + o.items.reduce((acc, i) => acc + Math.max(0, i.qty - i.picked), 0),
    0,
  );
  const packWorkload = packQueue.reduce(
    (s, o) => s + o.items.reduce((acc, i) => acc + Math.max(0, i.qty - i.packed), 0),
    0,
  );
  const capPerH = capacity.pickers * capacity.pickingCapacity;
  const packPerH = capacity.packingCapacity;
  const pickHours = capPerH > 0 ? pickingWorkload / capPerH : Infinity;
  const packHours = packPerH > 0 ? packWorkload / packPerH : Infinity;

  let stockOnHand = 0;
  let stockReserved = 0;
  let stockAvailable = 0;
  let stockoutCount = 0;
  for (const p of products) {
    const reserved = computeReserved(p._id, orders);
    stockOnHand += p.onHand;
    stockReserved += reserved;
    stockAvailable += Math.max(0, p.onHand - reserved);
    if (p.onHand <= 0 && openDemand(p._id, orders) > 0) stockoutCount += 1;
  }

  return {
    fullyFulfilled: fully,
    partiallyFulfilled: partial,
    delayed,
    blocked,
    unitsAllocated: allocatedUnits,
    unitsRemaining: stockAvailable,
    backorderedUnits: backordered,
    stockoutCount,
    fulfillmentRate: orderedUnits > 0 ? Math.round((allocatedUnits / orderedUnits) * 100) : 100,
    pickingWorkload,
    pickHours,
    packHours,
    bottleneckLevel: !Number.isFinite(pickHours) || pickHours > 8 ? "critical" : pickHours > 4 ? "warning" : "none",
    stockOnHand,
    stockReserved,
    stockAvailable,
  };
}

/**
 * Weighted strategy score — the selection rule for Compare Strategies (§4).
 * Weights are deliberately simple and documented: fulfillment is rewarded,
 * delays/blockages/stockouts are penalized, and a critical bottleneck is a
 * hard demerit so a numerically "full" allocation can't hide a broken floor.
 */
export function strategyScore(m: MetricCore): number {
  return (
    m.fulfillmentRate +
    3 * m.fullyFulfilled -
    1 * m.partiallyFulfilled -
    2 * m.delayed -
    3 * m.blocked -
    2 * m.stockoutCount -
    (m.bottleneckLevel === "critical" ? 6 : m.bottleneckLevel === "warning" ? 3 : 0)
  );
}

const STRATEGY_ORDER: StrategyId[] = ["policy", "priority", "deadline", "fair"];

export const STRATEGY_LABEL: Record<StrategyId, string> = {
  policy: "Current policy (score)",
  priority: "Priority first",
  deadline: "Deadline first",
  fair: "Fair allocation",
};

/* ------------------------------------------------------- strategy compare */

export function compareStrategies(
  inputs: SimInputs,
  ctx: { products: ProductState[]; orders: OrderState[]; now: number },
): { strategies: StrategyMetrics[]; recommended: StrategyId; why: string } {
  const { products, orders, capacity } = prepareWorld(inputs, ctx);
  const now = ctx.now;
  const runs: { id: StrategyId; wave: WaveResult }[] = [
    { id: "policy", wave: runAllocationWave(products, orders, now) },
    { id: "priority", wave: runAllocationWaveWith(products, orders, now, "priority") },
    { id: "deadline", wave: runAllocationWaveWith(products, orders, now, "deadline") },
    { id: "fair", wave: runFairAllocation(products, orders, now) },
  ];
  const strategies: StrategyMetrics[] = runs.map((r) => {
    const core = countMetrics(r.wave.products, r.wave.orders, capacity, now);
    return { ...core, strategy: r.id, label: STRATEGY_LABEL[r.id], score: strategyScore(core) };
  });
  const best = [...strategies].sort(
    (a, b) => b.score - a.score || STRATEGY_ORDER.indexOf(a.strategy) - STRATEGY_ORDER.indexOf(b.strategy),
  )[0];
  const baseline = strategies.find((s) => s.strategy === "policy")!;
  const why =
    best.strategy === "policy"
      ? `The current policy already scores highest (${best.score}): it captures a ${baseline.fulfillmentRate}% fulfillment rate with ${baseline.fullyFulfilled} order(s) fully fulfilled, ${baseline.delayed} delayed, and ${baseline.stockoutCount} stockout(s).`
      : `${best.label} scores ${best.score} vs ${baseline.score} for the current policy — ${best.fulfillmentRate}% fulfillment (${best.fullyFulfilled} fulfilled, ${best.delayed} delayed, ${best.stockoutCount} stockout(s)) versus ${baseline.fulfillmentRate}% (${baseline.fullyFulfilled} fulfilled, ${baseline.delayed} delayed, ${baseline.stockoutCount} stockout(s)). Selection uses a weighted score: +3 per fully fulfilled order, −2 per delayed, −3 per blocked, −2 per stockout, minus the bottleneck penalty.`;
  return { strategies, recommended: best.strategy, why };
}

/* ------------------------------------------------------------ projection */

export type SimOrderOutcome = {
  orderId: string;
  orderNumber: string;
  customer: string;
  priority: Priority;
  outcome: "fulfilled" | "partial" | "blocked";
  allocatedPct: number;
  revenue: number;
  isNew: boolean;
  delayed: boolean;
};

export type SimRecommendation = {
  id: string;
  severity: AlertSeverity;
  title: string;
  detail: string;
};

export type SimulationResult = {
  inputs: SimInputs;
  products: ProductState[];
  orders: OrderState[];
  capacity: Capacity;
  revenueAtRiskBefore: number;
  revenueAtRiskAfter: number;
  capturedVsFifo: { scoreCaptured: number; fifoCaptured: number; delta: number };
  skuDeltas: { sku: string; name: string; before: number; after: number; delta: number }[];
  outcomes: SimOrderOutcome[];
  shortfallPlans: ReallocationPlan[];
  recommendations: SimRecommendation[];
  processed: number;
};

function revenueAtRisk(orders: OrderState[]): number {
  let sum = 0;
  for (const order of orders) {
    if (!OPEN_ORDER_STATUSES.includes(order.status)) continue;
    for (const item of order.items) {
      sum += Math.max(0, item.qty - item.allocated) * item.price;
    }
  }
  return sum;
}

function orderAllocatedPct(order: OrderState): number {
  const total = order.items.reduce((s, i) => s + i.qty, 0);
  if (total <= 0) return 0;
  const alloc = order.items.reduce((s, i) => s + i.allocated, 0);
  return Math.round((alloc / total) * 100);
}

function orderRevenue(order: OrderState): number {
  return order.items.reduce((s, i) => s + i.qty * i.price, 0);
}

/**
 * §7.6 — run the what-if under the CURRENT warehouse policy (score-ordered).
 * Pure and deterministic: clones state, applies inputs, runs the EXACT
 * production engine, and returns before/after revenue at risk, per-SKU deltas,
 * per-order outcomes (with delay risk from capacity), shortfall plans, and
 * ranked recommendations.
 */
export function simulateScenario(
  inputs: SimInputs,
  ctx: { products: ProductState[]; orders: OrderState[]; trustEntries: TrustEntry[]; now: number },
): SimulationResult {
  const { products: sourceProducts, orders: sourceOrders, trustEntries, now } = ctx;
  const prepared = prepareWorld(inputs, ctx);
  const { products, orders, capacity } = prepared;

  const revenueAtRiskBefore = revenueAtRisk(sourceOrders);
  const wave = runAllocationWave(products, orders, now);
  const projectedOrders = wave.orders;
  const revenueAtRiskAfter = revenueAtRisk(projectedOrders);
  const capturedVsFifo = revenueComparison(products, orders, now);

  const productById = new Map(products.map((p) => [p._id, p]));
  const skuDeltas = products
    .map((p) => {
      const orig = productById.get(p._id);
      return {
        sku: p.sku,
        name: p.name,
        before: orig?.onHand ?? 0,
        after: p.onHand,
        delta: p.onHand - (orig?.onHand ?? 0),
      };
    })
    .sort((a, b) => a.delta - b.delta);

  const newOrderIds = new Set<Id<"orders">>(
    projectedOrders.filter((o) => o._id.toString().startsWith("sim-")).map((o) => o._id),
  );
  const processedIds = new Set([
    ...sourceOrders.filter((o) => o.status === "pending" || o.status === "review").map((o) => o._id),
    ...newOrderIds,
  ]);
  const outcomes: SimOrderOutcome[] = projectedOrders
    .filter((o) => processedIds.has(o._id))
    .map((o) => {
      const unmet = o.items.some((i) => i.qty - i.allocated > 0);
      const any = o.items.some((i) => i.allocated > 0);
      return {
        orderId: o._id,
        orderNumber: o.orderNumber,
        customer: o.customer,
        priority: o.priority,
        outcome: unmet ? (any ? "partial" : "blocked") : "fulfilled",
        allocatedPct: orderAllocatedPct(o),
        revenue: orderRevenue(o),
        isNew: newOrderIds.has(o._id),
        delayed: orderDelayed(o, capacity, now),
      };
    });

  const shortfallPlans: ReallocationPlan[] = [];
  const recommendations: SimRecommendation[] = [];
  for (const o of projectedOrders) {
    if (o.status !== "review" && o.status !== "pending") continue;
    for (const item of o.items) {
      const needed = item.qty - item.allocated;
      if (needed <= 0) continue;
      const product = productById.get(item.productId);
      if (!product) continue;
      const plan = findReallocationPlan({
        targetOrder: o,
        product,
        allOrders: projectedOrders,
        trustEntries,
        now,
      });
      shortfallPlans.push(plan);
      if (plan.withheld) {
        recommendations.push({
          id: `po-${o._id}-${product.sku}`,
          severity: "critical",
          title: `Raise emergency PO for ${product.sku}`,
          detail: `No trust-safe donor holds reserved ${product.sku} — PO of ${product.reorderQty} units from ${product.supplier} (lead time ${product.leadTimeDays}d) is the recommended path.`,
        });
      } else {
        recommendations.push({
          id: `realloc-${o._id}-${product.sku}`,
          severity: "warning",
          title: `Reallocate ${plan.unitsAvailable} × ${product.sku}`,
          detail: `${plan.donors
            .filter((d) => d.eligible)
            .map((d) => `${plan.unitsAvailable} unit(s) from ${d.donorOrderNumber} (${d.donorCustomer})`)
            .join(", ")} — profit-positive and trust-safe.`,
        });
      }
      break; // one plan per order (mirrors the live shortfall alert model)
    }
  }

  for (const o of projectedOrders) {
    if (o.status !== "pending" || !processedIds.has(o._id)) continue;
    for (const item of o.items) {
      if (item.qty - item.allocated <= 0) continue;
      const product = productById.get(item.productId);
      if (!product || product.onHand > 0) continue;
      recommendations.push({
        id: `stockout-${o._id}-${product.sku}`,
        severity: "critical",
        title: `No stock for ${product.sku} — raise PO`,
        detail: `${o.orderNumber} needs ${item.qty - item.allocated} unit(s) but ${product.sku} has 0 on hand. Raise urgent PO (${product.reorderQty} units) with ${product.supplier}.`,
      });
      break;
    }
  }

  for (const p of products) {
    if (p.onHand > 0 && p.onHand < p.reorderPoint) {
      recommendations.push({
        id: `low-${p.sku}`,
        severity: "info",
        title: `Top up ${p.sku}`,
        detail: `Projected on hand ${p.onHand} is still below the reorder point (${p.reorderPoint}). Add ${p.reorderQty} units of incoming stock or raise a PO with ${p.supplier}.`,
      });
    }
  }

  return {
    inputs,
    products: wave.products,
    orders: projectedOrders,
    capacity,
    revenueAtRiskBefore,
    revenueAtRiskAfter,
    capturedVsFifo,
    skuDeltas,
    outcomes,
    shortfallPlans,
    recommendations,
    processed: wave.stats.processed,
  };
}

/* -------------------------------------------------- decision-support report */

export type TimelineStage = {
  stage: string;
  status: "healthy" | "warning" | "exception" | "action";
  note: string;
};

export type SimulationReport = {
  inputs: SimInputs;
  capacity: Capacity;
  exception: { severity: AlertSeverity; title: string; detail: string };
  decision: { title: string; detail: string };
  reason: string;
  resolution: { title: string; items: string[] };
  why: string;
  impact: { positive: string[]; risks: string[]; actions: string[] };
  timeline: TimelineStage[];
  currentMetrics: StrategyMetrics;
  simulatedMetrics: StrategyMetrics;
  revenueAtRiskBefore: number;
  revenueAtRiskAfter: number;
  capturedVsFifo: { scoreCaptured: number; fifoCaptured: number; delta: number };
  skuDeltas: { sku: string; name: string; before: number; after: number; delta: number }[];
  outcomes: SimOrderOutcome[];
  strategies: StrategyMetrics[];
  recommendedStrategy: StrategyId;
  recommendationWhy: string;
  processed: number;
};

function fmtMoney(n: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(n);
}

function fmtHours(h: number): string {
  if (!Number.isFinite(h)) return "∞";
  if (h < 24) return `${h.toFixed(1)}h`;
  return `${(h / 24).toFixed(1)}d`;
}

/**
 * Assemble the decision-support report. EVERY string is derived from the
 * simulated world — the exception is the biggest shortfall/stockout/bottleneck
 * in the numbers, the decision and reason quote those exact values, and the
 * resolution/impact/timeline follow only from what actually happened.
 */
function buildReport(args: {
  inputs: SimInputs;
  sim: SimulationResult;
  capacity: Capacity;
  now: number;
  sourceOrders: OrderState[];
  currentMetrics: MetricCore;
  simulatedMetrics: MetricCore;
  comparison: ReturnType<typeof compareStrategies>;
}): SimulationReport {
  const { inputs, sim, capacity, now, sourceOrders, currentMetrics, simulatedMetrics, comparison } = args;
  const products = sim.products;
  const orders = sim.orders;
  const productById = new Map(products.map((p) => [p._id, p]));
  const open = orders.filter((o) => OPEN_ORDER_STATUSES.includes(o.status));

  /* -------- primary shortfall: highest-scoring open order with unmet demand.
   * When the scenario added orders, the exception focuses on those (so a preset
   * surfaces its own problem rather than a pre-existing dilemma); otherwise it
   * focuses on the highest-scoring unmet order overall. */
  let top: { order: OrderState; item: OrderState["items"][number]; product: ProductState; needed: number } | null = null;
  {
    const isNew = (o: OrderState) => o._id.toString().startsWith("sim-");
    const unmet = open.filter((o) => o.items.some((i) => i.qty - i.allocated > 0));
    const pool = unmet.some((o) => isNew(o)) ? unmet.filter((o) => isNew(o)) : unmet;
    for (const o of pool) {
      for (const item of o.items) {
        const needed = item.qty - item.allocated;
        if (needed <= 0) continue;
        const product = productById.get(item.productId);
        if (!product) continue;
        const beats =
          !top ||
          scoreOrder(o, now) > scoreOrder(top.order, now) ||
          (scoreOrder(o, now) === scoreOrder(top.order, now) && needed > top.needed);
        if (beats) top = { order: o, item, product, needed };
      }
    }
  }

  const stockouts = products.filter((p) => p.onHand <= 0 && openDemand(p._id, orders) > 0);
  const damagedTotal = inputs.damagedUnits.reduce((s, d) => s + d.qty, 0);
  const missingTotal = inputs.missingUnits.reduce((s, d) => s + d.qty, 0);
  const capPerH = capacity.pickers * capacity.pickingCapacity;
  const packPerH = capacity.packingCapacity;
  const tightestHours = open.reduce(
    (m, o) => Math.min(m, Math.max(0, (o.deadline - now) / 3_600_000)),
    Infinity,
  );
  const tightest = Number.isFinite(tightestHours) ? tightestHours : 0;

  const plan = top
    ? sim.shortfallPlans.find((p) => p.targetOrderId === top!.order._id && p.sku === top!.product.sku)
    : undefined;
  const drawable = plan ? plan.donors.filter((d) => d.eligible) : [];
  // Usable stock is measured against PRE-wave reservations (the target order's
  // own new allocation is not yet reserved when the decision is made), so the
  // decision always quotes what the wave actually granted.
  const reservedForTop = top ? computeReserved(top.product._id, sourceOrders) : 0;
  const usableForTop = top ? Math.max(0, top.product.onHand - reservedForTop) : 0;
  const grantedToTop = top ? Math.min(top.needed, usableForTop) : 0;
  // A purely operational scenario (no order/stock changes) surfaces capacity
  // problems as the headline instead of a pre-existing shortfall.
  const operationalOnly =
    inputs.addLines.length === 0 &&
    inputs.priorityOverrides.length === 0 &&
    inputs.orderDelays.length === 0 &&
    inputs.incomingStock.length === 0 &&
    inputs.damagedUnits.length === 0 &&
    inputs.missingUnits.length === 0;

  /* -------- 1. exception (stockout on the focus product beats the generic shortfall) */
  const productOut = top ? top.product.onHand <= 0 : false;
  let severity: AlertSeverity;
  let title: string;
  let detail: string;
  if (top && productOut) {
    severity = "critical";
    title = `Stockout: ${top.product.sku}`;
    detail = `${top.order.orderNumber} (${top.order.customer}) needs ${top.item.qty} × ${top.product.sku} but 0 units are on hand — no allocation is possible until replenishment lands.`;
  } else if (operationalOnly && simulatedMetrics.bottleneckLevel === "critical") {
    severity = "critical";
    title = "Picking bottleneck";
    detail = `Picking workload is ${simulatedMetrics.pickingWorkload} units but effective capacity is ${capPerH} unit(s)/hour (${capacity.pickers} picker(s) × ${capacity.pickingCapacity}${capacity.disruption !== "none" ? `, reduced by ${capacity.disruption.replace(/_/g, " ")}` : ""}), so the queue cannot clear within the tightest ${Math.round(tightest)}h deadline.`;
  } else if (top && (top.order.priority === "urgent" || top.order.priority === "high")) {
    severity = "critical";
    title = `Shortfall: ${top.order.orderNumber}`;
    detail = `${top.order.orderNumber} (${top.order.customer}) requires ${top.item.qty} × ${top.product.sku} but only ${usableForTop} usable unit(s) are available — ${top.needed} unit(s) short (${Math.round((grantedToTop / top.item.qty) * 100)}% of demand covered).`;
  } else if (stockouts.length > 0) {
    const p = stockouts[0];
    severity = "critical";
    title = `Stockout: ${p.sku}`;
    detail = `${p.sku} has 0 usable units against ${openDemand(p._id, orders)} unit(s) of open demand. No order can be fulfilled from this SKU until replenishment lands.`;
  } else if (simulatedMetrics.bottleneckLevel === "critical") {
    severity = "critical";
    title = "Picking bottleneck";
    detail = `Picking workload is ${simulatedMetrics.pickingWorkload} units but effective capacity is ${capPerH} unit(s)/hour (${capacity.pickers} picker(s) × ${capacity.pickingCapacity}${capacity.disruption !== "none" ? `, reduced by ${capacity.disruption.replace(/_/g, " ")}` : ""}), so the queue cannot clear within the tightest ${Math.round(tightest)}h deadline.`;
  } else if (top) {
    severity = "warning";
    title = `Partial allocation: ${top.order.orderNumber}`;
    detail = `${top.order.orderNumber} (${top.order.customer}) is short ${top.needed} × ${top.product.sku} — ${grantedToTop} of ${top.item.qty} allocated.`;
  } else if (simulatedMetrics.bottleneckLevel === "warning") {
    severity = "warning";
    title = "Picking pressure";
    detail = `Picking clears in ${fmtHours(simulatedMetrics.pickHours)} — inside the tightest ${Math.round(tightest)}h deadline, but with no slack. Consider adding capacity.`;
  } else if (damagedTotal + missingTotal > 0) {
    severity = "warning";
    title = "Inventory variance";
    detail = `${damagedTotal} damaged and ${missingTotal} missing unit(s) were removed from usable stock before allocation.`;
  } else {
    severity = "info";
    title = "No exception detected";
    detail = "The simulated state allocates all open demand and picking clears within the tightest deadline.";
  }

  /* -------- 2. decision + 3. reason + 4. resolution */
  let decisionTitle: string;
  let decisionDetail: string;
  if (top && productOut) {
    decisionTitle = `Raise urgent PO for ${top.product.sku}`;
    decisionDetail = `Order ${top.product.reorderQty} units from ${top.product.supplier} (lead time ${top.product.leadTimeDays}d) and expedite; ${top.order.orderNumber} cannot be fulfilled before it lands.`;
  } else if (operationalOnly && simulatedMetrics.bottleneckLevel !== "none") {
    const targetHours = Math.min(4, tightest || 4);
    const neededPickers =
      capacity.pickingCapacity > 0
        ? Math.max(1, Math.ceil(simulatedMetrics.pickingWorkload / (capacity.pickingCapacity * targetHours)))
        : capacity.pickers + 2;
    decisionTitle = `Add ${neededPickers} picker(s) or raise picking capacity`;
    decisionDetail = `At ${capPerH} unit(s)/hour the ${simulatedMetrics.pickingWorkload}-unit queue takes ${fmtHours(simulatedMetrics.pickHours)}; ${neededPickers} picker(s) would clear it within ${targetHours}h.`;
  } else if (top && drawable.length > 0 && plan) {
    const net = drawable.reduce((s, d) => s + d.netBenefit, 0);
    decisionTitle = `Reallocate ${plan.unitsAvailable} × ${top.product.sku}, backorder the rest`;
    decisionDetail = `Allocate all ${usableForTop} usable unit(s) to ${top.order.orderNumber}, then draw ${plan.unitsAvailable} unit(s) from ${drawable
      .map((d) => `${d.donorOrderNumber} (${d.donorCustomer})`)
      .join(", ")} — net +${fmtMoney(net)} with both donors above the 40-point trust floor — and place ${Math.max(0, top.needed - plan.unitsAvailable)} unit(s) on backorder.`;
  } else if (top) {
    decisionTitle = `Allocate ${usableForTop} × ${top.product.sku}, backorder ${top.needed}`;
    decisionDetail = `Allocate every usable unit to the order and place the remaining ${top.needed} unit(s) on backorder. ${
      plan?.withheld
        ? "Reallocation was withheld — the only holders are trust-protected or profit-negative, so Crisis Mode will not raid them."
        : ""
    }`;
  } else if (stockouts.length > 0) {
    const p = stockouts[0];
    decisionTitle = `Raise urgent PO for ${p.sku}`;
    decisionDetail = `Order ${p.reorderQty} units from ${p.supplier} (lead time ${p.leadTimeDays}d) and expedite the delivery.`;
  } else if (simulatedMetrics.bottleneckLevel !== "none") {
    const targetHours = Math.min(4, tightest || 4);
    const neededPickers =
      capacity.pickingCapacity > 0
        ? Math.max(1, Math.ceil(simulatedMetrics.pickingWorkload / (capacity.pickingCapacity * targetHours)))
        : capacity.pickers + 2;
    decisionTitle = `Add ${neededPickers} picker(s) or raise picking capacity`;
    decisionDetail = `At ${capPerH} unit(s)/hour the ${simulatedMetrics.pickingWorkload}-unit queue takes ${fmtHours(simulatedMetrics.pickHours)}; ${neededPickers} picker(s) would clear it within ${targetHours}h.`;
  } else {
    decisionTitle = "Proceed with the current allocation";
    decisionDetail = `All open demand is covered (${simulatedMetrics.fulfillmentRate}%) and picking clears in ${fmtHours(simulatedMetrics.pickHours)} — no intervention needed.`;
  }

  let reason: string;
  if (top && productOut) {
    reason = `${top.product.sku} has 0 units on hand and ${openDemand(top.product._id, orders)} units of open demand — replenishment is the only path to fulfillment (lead time ${top.product.leadTimeDays}d).`;
  } else if (operationalOnly && simulatedMetrics.bottleneckLevel !== "none") {
    reason = `${simulatedMetrics.pickingWorkload} units must be picked at ${capPerH} unit(s)/hour (${capacity.pickers} picker(s) × ${capacity.pickingCapacity}${
      capacity.disruption !== "none" ? `, reduced by ${capacity.disruption.replace(/_/g, " ")}` : ""
    }), taking ${fmtHours(simulatedMetrics.pickHours)} — beyond the ${Math.round(tightest)}h window to the tightest deadline.`;
  } else if (top) {
    const bd = scoreOrderBreakdown(top.order, now);
    const hours = Math.max(0, (top.order.deadline - now) / 3_600_000);
    reason = `${top.order.orderNumber} is ${top.order.priority} priority (${bd.priorityPoints} points) and due in ${Math.round(hours)}h, so it scores ${Math.round(bd.total)} — the highest in the queue. Only ${usableForTop} usable unit(s) of ${top.product.sku} exist after removing ${damagedTotal} damaged + ${missingTotal} missing and honoring ${reservedForTop} reserved unit(s), so the system allocates everything it can and flags the rest.`;
  } else if (stockouts.length > 0) {
    const p = stockouts[0];
    reason = `${p.sku} has ${p.onHand} units on hand and ${openDemand(p._id, orders)} units of open demand — replenishment is the only path to fulfillment (lead time ${p.leadTimeDays}d).`;
  } else if (simulatedMetrics.bottleneckLevel !== "none") {
    reason = `${simulatedMetrics.pickingWorkload} units must be picked at ${capPerH} unit(s)/hour (${capacity.pickers} picker(s) × ${capacity.pickingCapacity}${
      capacity.disruption !== "none" ? `, reduced by ${capacity.disruption.replace(/_/g, " ")}` : ""
    }), taking ${fmtHours(simulatedMetrics.pickHours)} — beyond the ${Math.round(tightest)}h window to the tightest deadline.`;
  } else {
    reason = `The current policy allocates ${simulatedMetrics.fulfillmentRate}% of ordered units with picking cleared in ${fmtHours(simulatedMetrics.pickHours)} — the scenario is healthy.`;
  }

  const resolutionItems: string[] = [];
  if (top) {
    resolutionItems.push(`Trigger replenishment: PO for ${top.product.reorderQty} × ${top.product.sku} with ${top.product.supplier} (lead ${top.product.leadTimeDays}d)`);
  }
  if (drawable.length > 0 && plan) {
    resolutionItems.push(`Reprioritize lower-priority orders: move ${plan.unitsAvailable} reserved unit(s) from ${drawable.map((d) => d.donorOrderNumber).join(", ")} via Crisis Mode`);
  }
  if (stockouts.length > 0) {
    const p = stockouts[0];
    resolutionItems.push(`Expedite the ${p.reorderQty}-unit PO with ${p.supplier} and prioritize receiving when it lands`);
  }
  if (simulatedMetrics.bottleneckLevel !== "none") {
    resolutionItems.push("Rebalance pickers or raise picking capacity before the next wave");
  }
  if (top || stockouts.length > 0) {
    resolutionItems.push("Continue picking already-allocated units so committed orders keep moving");
  }
  if (resolutionItems.length === 0) {
    resolutionItems.push("Keep the standard wave schedule and monitor KPIs for drift");
  }
  resolutionItems.push(`Monitor ${simulatedMetrics.delayed} order(s) at risk of delay and notify customers if deadlines slip`);

  /* -------- why (plain operational language, all numbers from the sim) */
  const capacitySentence =
    simulatedMetrics.pickingWorkload > 0
      ? `Picking workload is ${simulatedMetrics.pickingWorkload} units; ${capacity.pickers} picker(s) at ${capacity.pickingCapacity} unit(s)/hour each clear it in ${fmtHours(simulatedMetrics.pickHours)}, so picking is ${simulatedMetrics.bottleneckLevel === "critical" ? "critically bottlenecked" : simulatedMetrics.bottleneckLevel === "warning" ? "under pressure" : "healthy"}.`
      : `No pick-ready workload exists, so picking capacity does not constrain the simulated state.`;
  const whySentences: string[] = [];
  const opBottleneck = operationalOnly && simulatedMetrics.bottleneckLevel !== "none";
  if (opBottleneck) {
    whySentences.push(capacitySentence);
  }
  if (top) {
    const bd = scoreOrderBreakdown(top.order, now);
    const hours = Math.max(0, (top.order.deadline - now) / 3_600_000);
    whySentences.push(
      `Order ${top.order.orderNumber} (${top.order.priority}, due in ${Math.round(hours)}h) was prioritized because it has the highest priority weight (${bd.priorityPoints})${bd.deadlineBonus ? ` and a ${bd.deadlineBonus}-point deadline bonus` : ""}, giving it a score of ${Math.round(bd.total)}.`,
    );
    whySentences.push(
      `For ${top.product.sku}, ${top.product.onHand} unit(s) on hand minus ${reservedForTop} reserved (and ${damagedTotal + missingTotal} removed as damaged/missing) left ${usableForTop} usable; the system allocated ${grantedToTop} of the ${top.item.qty} required and identified a shortage of ${top.needed}.`,
    );
    if (plan?.withheld && plan.donors.length > 0) {
      const holder = plan.donors[0];
      whySentences.push(
        `Lower-priority orders were not raided because the only holder (${holder.donorCustomer}) has trust score ${holder.trustBefore}, below the 40-point protection floor — ${holder.ineligibleReason ?? "not trust-eligible"}.`,
      );
    } else if (drawable.length > 0) {
      whySentences.push(
        `Lower-priority donors (${drawable.map((d) => `${d.donorOrderNumber}, trust ${d.trustBefore}`).join("; ")}) hold reserved stock, but reallocation stays an operator decision in Crisis Mode — it is profit-positive (net +${fmtMoney(drawable.reduce((s, d) => s + d.netBenefit, 0))}) and trust-safe.`,
      );
    } else {
      whySentences.push(`No lower-priority order holds reserved ${top.product.sku}, so there is no reallocation conflict to resolve.`);
    }
  }
  if (!opBottleneck && simulatedMetrics.pickingWorkload > 0) {
    whySentences.push(capacitySentence);
  }
  if (whySentences.length === 0) {
    whySentences.push(`No order required intervention: the current policy allocated ${simulatedMetrics.fulfillmentRate}% of ordered units and picking clears in ${fmtHours(simulatedMetrics.pickHours)}.`);
  }

  /* -------- impact analysis */
  const positive: string[] = [];
  if (top && top.needed === grantedToTop) {
    positive.push(`${top.order.orderNumber} fully allocated — ${fmtMoney(top.item.qty * top.product.price)} protected`);
  } else if (top) {
    positive.push(`${grantedToTop} unit(s) of ${top.product.sku} allocated to ${top.order.orderNumber} — every usable unit deployed`);
  }
  if (sim.revenueAtRiskAfter < sim.revenueAtRiskBefore) {
    positive.push(`Revenue at risk reduced from ${fmtMoney(sim.revenueAtRiskBefore)} to ${fmtMoney(sim.revenueAtRiskAfter)}`);
  }
  if (simulatedMetrics.bottleneckLevel === "none" && currentMetrics.bottleneckLevel !== "none") {
    positive.push(`Picking bottleneck cleared — queue now clears in ${fmtHours(simulatedMetrics.pickHours)}`);
  }
  if (simulatedMetrics.fulfillmentRate > currentMetrics.fulfillmentRate) {
    positive.push(`Fulfillment rate up from ${currentMetrics.fulfillmentRate}% to ${simulatedMetrics.fulfillmentRate}%`);
  }
  if (positive.length === 0) {
    positive.push("The simulated state holds steady — no operational degradation detected");
  }

  const risks: string[] = [];
  if (simulatedMetrics.backorderedUnits > 0) {
    risks.push(`${simulatedMetrics.backorderedUnits} unit(s) backordered across open orders`);
  }
  if (simulatedMetrics.delayed > 0) {
    risks.push(`${simulatedMetrics.delayed} order(s) risk missing their deadline`);
  }
  if (stockouts.length > 0) {
    risks.push(`${stockouts.length} SKU(s) out of stock with open demand — ${stockouts.map((s) => s.sku).join(", ")}`);
  }
  if (damagedTotal + missingTotal > 0) {
    risks.push(`${damagedTotal} damaged + ${missingTotal} missing unit(s) removed from usable stock`);
  }
  if (drawable.length > 0 && plan) {
    risks.push(`Donor order(s) ${drawable.map((d) => d.donorOrderNumber).join(", ")} are backordered until restock`);
  }
  if (risks.length === 0) {
    risks.push("No material risks detected in the simulated state");
  }

  const actions: string[] = [];
  if (top) actions.push(`Replenish ${top.product.reorderQty} × ${top.product.sku} from ${top.product.supplier}`);
  if (drawable.length > 0 && plan) actions.push("Run the reallocation in Crisis Mode — profit-positive and trust-safe");
  if (simulatedMetrics.bottleneckLevel !== "none") actions.push("Add picking capacity before the next allocation wave");
  if (simulatedMetrics.delayed > 0) actions.push(`Expedite the ${simulatedMetrics.delayed} at-risk order(s) through picking and QC`);
  actions.push("Continue picking allocated units and monitor affected orders");

  /* -------- timeline */
  const bottleneckLabel =
    simulatedMetrics.bottleneckLevel === "critical"
      ? "critical"
      : simulatedMetrics.bottleneckLevel === "warning"
        ? "under pressure"
        : "healthy";
  const timeline: TimelineStage[] = [
    { stage: "Order Created", status: "healthy", note: `${open.length} order(s) in the queue` },
    {
      stage: "Priority Determined",
      status: inputs.priorityOverrides.length > 0 ? "action" : "healthy",
      note:
        inputs.priorityOverrides.length > 0
          ? `${inputs.priorityOverrides.length} priority override(s) applied before scoring`
          : "Priorities from the current policy",
    },
    {
      stage: "Inventory Checked",
      status: damagedTotal + missingTotal > 0 ? "warning" : stockouts.length > 0 ? "exception" : "healthy",
      note: `Usable stock = on hand − reservations${damagedTotal + missingTotal > 0 ? ` (${damagedTotal} damaged + ${missingTotal} missing removed)` : ""}`,
    },
    { stage: "Exception Detected", status: severity === "info" ? "healthy" : "exception", note: title },
    {
      stage: "Stock Allocated",
      status: simulatedMetrics.fulfillmentRate >= 100 ? "healthy" : "warning",
      note: `${simulatedMetrics.fulfillmentRate}% of ordered units allocated · ${simulatedMetrics.backorderedUnits} backordered`,
    },
    {
      stage: "Picking",
      status:
        simulatedMetrics.bottleneckLevel === "critical"
          ? "exception"
          : simulatedMetrics.bottleneckLevel === "warning"
            ? "warning"
            : "healthy",
      note: `${simulatedMetrics.pickingWorkload} units · ${capPerH} unit(s)/h → ${fmtHours(simulatedMetrics.pickHours)} (${bottleneckLabel})`,
    },
    {
      stage: "Packing",
      status: simulatedMetrics.packHours > 4 ? "warning" : "healthy",
      note: `${fmtHours(simulatedMetrics.packHours)} at ${packPerH} unit(s)/h`,
    },
    { stage: "Quality Check", status: "healthy", note: "QC ready for packed orders" },
    {
      stage: "Dispatch",
      status: simulatedMetrics.delayed > 0 ? "warning" : "healthy",
      note: `${simulatedMetrics.delayed} order(s) at risk of missing their deadline`,
    },
  ];

  const simulatedStrategy: StrategyMetrics = {
    ...simulatedMetrics,
    strategy: "policy",
    label: STRATEGY_LABEL.policy,
    score: strategyScore(simulatedMetrics),
  };
  const currentStrategy: StrategyMetrics = {
    ...currentMetrics,
    strategy: "policy",
    label: STRATEGY_LABEL.policy,
    score: strategyScore(currentMetrics),
  };

  return {
    inputs,
    capacity,
    exception: { severity, title, detail },
    decision: { title: decisionTitle, detail: decisionDetail },
    reason,
    resolution: { title: "Resolution path", items: resolutionItems },
    why: whySentences.join(" "),
    impact: { positive, risks, actions },
    timeline,
    currentMetrics: currentStrategy,
    simulatedMetrics: simulatedStrategy,
    revenueAtRiskBefore: sim.revenueAtRiskBefore,
    revenueAtRiskAfter: sim.revenueAtRiskAfter,
    capturedVsFifo: sim.capturedVsFifo,
    skuDeltas: sim.skuDeltas,
    outcomes: sim.outcomes,
    strategies: comparison.strategies,
    recommendedStrategy: comparison.recommended,
    recommendationWhy: comparison.why,
    processed: sim.processed,
  };
}

/**
 * §7.6 entry point for the decision-support report: current-policy projection
 * + before/after metrics + all four strategies + the full decision engine.
 */
export function runSimulation(
  inputs: SimInputs,
  ctx: { products: ProductState[]; orders: OrderState[]; trustEntries: TrustEntry[]; now: number },
): SimulationReport {
  const sim = simulateScenario(inputs, ctx);
  const currentMetrics = countMetrics(ctx.products, ctx.orders, sim.capacity, ctx.now);
  const comparison = compareStrategies(inputs, ctx);
  return buildReport({
    inputs,
    sim,
    capacity: sim.capacity,
    now: ctx.now,
    sourceOrders: ctx.orders,
    currentMetrics,
    simulatedMetrics: countMetrics(sim.products, sim.orders, sim.capacity, ctx.now),
    comparison,
  });
}

/* ------------------------------------------------------------- apply */

/**
 * §7.6 Apply — re-validates inputs against CURRENT DB state (not the client's
 * cached projection), commits the accepted changes (damaged/missing write-offs,
 * deadline delays, incoming stock, priority overrides, new orders), re-runs the
 * allocation wave through the shared writer, and logs a `simulation` decision
 * entry. Capacity/disruption knobs are operational what-if parameters and are
 * intentionally not persisted (no schema change).
 */
export const applySimulation = mutation({
  args: { inputs: simInputsValidator },
  handler: async (ctx, { inputs }) => {
    const now = Date.now();
    const [products, orders] = await Promise.all([
      ctx.db.query("products").collect(),
      ctx.db.query("orders").collect(),
    ]);

    const validation = validateSimInputs(inputs, products, orders, now);
    if (!validation.ok) {
      return { applied: false, errors: validation.errors };
    }

    const productBySku = new Map(products.map((p) => [p.sku, p]));
    const orderById = new Map(orders.map((o) => [o._id, o]));
    const orderNumbers = new Set(orders.map((o) => o.orderNumber));

    let damaged = 0;
    let missing = 0;
    let delays = 0;
    let restocks = 0;

    for (const s of inputs.damagedUnits) {
      const p = productBySku.get(s.sku);
      if (!p) continue;
      await ctx.db.patch(p._id, { onHand: Math.max(0, p.onHand - s.qty) });
      damaged += s.qty;
    }
    for (const s of inputs.missingUnits) {
      const p = productBySku.get(s.sku);
      if (!p) continue;
      await ctx.db.patch(p._id, { onHand: Math.max(0, p.onHand - s.qty) });
      missing += s.qty;
    }
    for (const d of inputs.orderDelays) {
      const o = orderById.get(d.orderId as Id<"orders">);
      if (!o) continue;
      await ctx.db.patch(o._id, { deadline: o.deadline + d.hours * 3_600_000, updatedAt: now });
      delays += 1;
    }
    for (const s of inputs.incomingStock) {
      const p = productBySku.get(s.sku);
      if (!p) continue;
      await ctx.db.patch(p._id, { onHand: p.onHand + s.qty });
      restocks += 1;
    }

    let overrides = 0;
    for (const o of inputs.priorityOverrides) {
      const order = orderById.get(o.orderId as Id<"orders">);
      if (!order || order.priority === o.priority) continue;
      await ctx.db.patch(order._id, { priority: o.priority, updatedAt: now });
      overrides += 1;
    }

    let inserted = 0;
    for (const line of inputs.addLines) {
      const p = productBySku.get(line.sku);
      if (!p) continue;
      let n = 3001;
      while (orderNumbers.has(`SIM-${n}`)) n += 1;
      const orderNumber = `SIM-${n}`;
      orderNumbers.add(orderNumber);
      await ctx.db.insert("orders", {
        orderNumber,
        customer: "Simulation (what-if)",
        priority: line.priority,
        status: "pending",
        items: [
          {
            productId: p._id,
            sku: p.sku,
            name: p.name,
            qty: line.qty,
            allocated: 0,
            picked: 0,
            packed: 0,
            price: p.price,
          },
        ],
        deadline: line.deadline,
        createdAt: now,
        updatedAt: now,
      });
      inserted += 1;
    }

    const stats = await commitAllocationWave(ctx, now);

    if (damaged > 0) {
      await logDecision(ctx, {
        kind: "exception",
        summary: `Simulation: ${damaged} damaged unit(s) written off`,
        outcome: `${damaged} unit(s) removed from usable stock across ${inputs.damagedUnits.length} SKU(s)`,
        createdAt: now,
      });
    }
    if (missing > 0) {
      await logDecision(ctx, {
        kind: "exception",
        summary: `Simulation: ${missing} missing unit(s) adjusted`,
        outcome: `${missing} unit(s) removed pending cycle count across ${inputs.missingUnits.length} SKU(s)`,
        createdAt: now,
      });
    }
    await logDecision(ctx, {
      kind: "simulation",
      summary: `Simulation applied: ${inserted} order(s), ${overrides} priority change(s), ${restocks} restock(s), ${damaged} damaged, ${missing} missing, ${delays} delay(s)`,
      detail: `Allocation wave re-run — ${stats.processed} order(s) processed.`,
      outcome: `${inserted} new order(s) committed · ${restocks} stock line(s) received · allocation re-run`,
      createdAt: now,
    });

    return { applied: true, stats, inserted, overrides, restocks, damaged, missing, delays };
  },
});
