/**
 * simulator.ts — pure, deterministic what-if projection (§7.6) + Apply.
 *
 * The projection runs ENTIRELY through the shared functions from allocation.ts
 * (`runAllocationWave`, `findReallocationPlan`, `revenueComparison`) — it has
 * no copy of the scoring formula, the greedy loop, or the trust/netBenefit
 * math (§7.6.1). The frontend runs `simulateScenario` client-side for previews;
 * `applySimulation` re-validates against live DB state before committing.
 */
import { v } from "convex/values";
import { mutation } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import {
  OPEN_ORDER_STATUSES,
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
  type ReallocationPlan,
} from "./allocation";
import { logDecision } from "./alerts";

/* ------------------------------------------------------------ input types */

export type SimAddLine = { sku: string; qty: number; priority: Priority; deadline: number };
export type SimPriorityOverride = { orderId: string; priority: Priority };
export type SimIncomingStock = { sku: string; qty: number };

export type SimInputs = {
  addLines: SimAddLine[];
  priorityOverrides: SimPriorityOverride[];
  incomingStock: SimIncomingStock[];
};

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

export const simInputsValidator = v.object({
  addLines: v.array(simAddLineValidator),
  priorityOverrides: v.array(simPriorityOverrideValidator),
  incomingStock: v.array(simIncomingStockValidator),
});

export type SimValidationError = { field: string; message: string };

/**
 * §7.6 — validate every input BEFORE projection: qty > 0 (inline field error
 * otherwise), sku must resolve to an existing product (never silently ignore
 * an unknown SKU), override orderIds must exist.
 */
export function validateSimInputs(
  inputs: SimInputs,
  products: ProductState[],
  orders: OrderState[],
): { ok: boolean; errors: SimValidationError[] } {
  const errors: SimValidationError[] = [];
  const skus = new Set(products.map((p) => p.sku));
  const orderIds = new Set(orders.map((o) => o._id));

  inputs.addLines.forEach((line, i) => {
    if (!Number.isFinite(line.qty) || line.qty <= 0) {
      errors.push({
        field: `add.${i}.qty`,
        message: `Line ${i + 1}: quantity must be greater than 0`,
      });
    }
    if (!skus.has(line.sku)) {
      errors.push({
        field: `add.${i}.sku`,
        message: `Line ${i + 1}: unknown SKU "${line.sku}" — enter an existing product SKU`,
      });
    }
    if (!Number.isFinite(line.deadline)) {
      errors.push({ field: `add.${i}.deadline`, message: `Line ${i + 1}: deadline is required` });
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
    if (!Number.isFinite(s.qty) || s.qty <= 0) {
      errors.push({
        field: `stock.${i}.qty`,
        message: `Stock ${i + 1}: quantity must be greater than 0`,
      });
    }
    if (!skus.has(s.sku)) {
      errors.push({
        field: `stock.${i}.sku`,
        message: `Stock ${i + 1}: unknown SKU "${s.sku}" — enter an existing product SKU`,
      });
    }
  });

  return { ok: errors.length === 0, errors };
}

/* ------------------------------------------------------------- projection */

export type SimOrderOutcome = {
  orderId: string;
  orderNumber: string;
  customer: string;
  priority: Priority;
  outcome: "fulfilled" | "partial" | "blocked";
  allocatedPct: number;
  revenue: number;
  isNew: boolean;
};

export type SimRecommendation = {
  id: string;
  severity: AlertSeverity;
  title: string;
  detail: string;
};

export type SimulationResult = {
  inputs: SimInputs;
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
 * §7.6 — run the what-if. Pure and deterministic: clones state, applies inputs,
 * runs the EXACT production functions, and returns before/after revenue at
 * risk, captured-vs-FIFO, per-SKU deltas, per-order outcomes, shortfall plans,
 * and ranked recommendations.
 */
export function simulateScenario(
  inputs: SimInputs,
  ctx: { products: ProductState[]; orders: OrderState[]; trustEntries: TrustEntry[]; now: number },
): SimulationResult {
  const { products: sourceProducts, orders: sourceOrders, trustEntries, now } = ctx;

  // clone into mutable working state
  const products = sourceProducts.map((p) => ({ ...p }));
  const orders = sourceOrders.map((o) => ({ ...o, items: o.items.map((i) => ({ ...i })) }));
  const productBySku = new Map(products.map((p) => [p.sku, p]));
  const productById = new Map(products.map((p) => [p._id, p]));

  // incoming stock
  for (const s of inputs.incomingStock) {
    const p = productBySku.get(s.sku);
    if (p) p.onHand += s.qty;
  }

  // priority overrides
  for (const o of inputs.priorityOverrides) {
    const order = orders.find((x) => x._id === o.orderId);
    if (order) order.priority = o.priority;
  }

  // new order lines (projected only — ids are synthetic, never persisted)
  const newOrderIds = new Set<Id<"orders">>();
  let counter = 1;
  for (const line of inputs.addLines) {
    const p = productBySku.get(line.sku);
    if (!p) continue;
    const id = `sim-${counter++}` as Id<"orders">;
    newOrderIds.add(id);
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

  const revenueAtRiskBefore = revenueAtRisk(sourceOrders);

  // the exact production function — not a re-implementation
  const wave = runAllocationWave(products, orders, now);
  const projectedOrders = wave.orders;
  const revenueAtRiskAfter = revenueAtRisk(projectedOrders);
  const capturedVsFifo = revenueComparison(products, orders, now);

  // per-SKU inventory deltas (projected onHand − current onHand)
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

  // per-order outcomes for every order with demand (was pending/review or new)
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
      };
    });

  // shortfall plans + ranked recommendations
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

  // blocked orders with zero stock → PO recommendation
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

  // low-stock products still below reorder point after incoming stock
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

/* ------------------------------------------------------------- apply */

/**
 * §7.6 Apply — re-validates inputs against CURRENT DB state (not the client's
 * cached projection), commits the accepted changes, re-runs the allocation
 * wave through the shared writer, and logs one `simulation` decision entry
 * summarizing applied vs previewed work.
 */
export const applySimulation = mutation({
  args: { inputs: simInputsValidator },
  handler: async (ctx, { inputs }) => {
    const now = Date.now();
    const [products, orders] = await Promise.all([
      ctx.db.query("products").collect(),
      ctx.db.query("orders").collect(),
    ]);

    const validation = validateSimInputs(inputs, products, orders);
    if (!validation.ok) {
      return { applied: false, errors: validation.errors };
    }

    const productBySku = new Map(products.map((p) => [p.sku, p]));
    const orderNumbers = new Set(orders.map((o) => o.orderNumber));

    let restocks = 0;
    for (const s of inputs.incomingStock) {
      const p = productBySku.get(s.sku);
      if (!p) continue;
      await ctx.db.patch(p._id, { onHand: p.onHand + s.qty });
      restocks += 1;
    }

    let overrides = 0;
    for (const o of inputs.priorityOverrides) {
      const order = orders.find((x) => x._id === o.orderId);
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
    await logDecision(ctx, {
      kind: "simulation",
      summary: `Simulation applied: ${inserted} order(s), ${overrides} priority change(s), ${restocks} restock(s)`,
      detail: `Allocation wave re-run — ${stats.processed} order(s) processed.`,
      outcome: `${inserted} new order(s) committed · ${restocks} stock line(s) received · allocation re-run`,
      createdAt: now,
    });

    return { applied: true, stats, inserted, overrides, restocks };
  },
});
