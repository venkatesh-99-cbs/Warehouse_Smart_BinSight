/**
 * analytics.ts — reactive read side (§7.8): KPIs, pipeline funnel, stock
 * health, zone load, top shortfalls, latest exceptions, availability,
 * customer trust queries, and the revenue-captured-vs-FIFO comparison. All
 * `availability` / trust metrics are QUERIES (the client subscribes; it never
 * copies server state into local state).
 */
import { query, type QueryCtx } from "./_generated/server";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import {
  FLOW,
  OPEN_ORDER_STATUSES,
  computeReserved,
  customerTrustScore as computeCustomerTrust,
  recentDonorStrikes as countDonorStrikes,
  type TrustEntry,
} from "./domain";
import { revenueComparison } from "./allocation";

/* ------------------------------------------------------------ shared read */

const SEVERITY_RANK: Record<string, number> = { critical: 0, warning: 1, info: 2 };

async function readWorld(ctx: QueryCtx) {
  const [products, orders, tasks, alerts, shipments, decisionLog] = await Promise.all([
    ctx.db.query("products").collect(),
    ctx.db.query("orders").collect(),
    ctx.db.query("pickingTasks").collect(),
    ctx.db.query("alerts").collect(),
    ctx.db.query("shipments").collect(),
    ctx.db.query("decisionLog").collect(),
  ]);
  return { products, orders, tasks, alerts, shipments, decisionLog };
}

type World = Awaited<ReturnType<typeof readWorld>>;

/* ------------------------------------------------------------ kpis (§7.8) */

function computeKpis(w: World, now: number) {
  const openOrders = w.orders.filter((o) => OPEN_ORDER_STATUSES.includes(o.status));
  const atRisk = openOrders.filter((o) => (o.deadline - now) / 3_600_000 < 24);

  const fulfillmentEvents = w.decisionLog.filter(
    (e) =>
      e.trustEvent === "fulfilled_on_time" ||
      e.trustEvent === "fulfilled_early" ||
      e.trustEvent === "deadline_missed",
  );
  const onTime =
    fulfillmentEvents.length === 0
      ? 0
      : Math.round(
          (fulfillmentEvents.filter(
            (e) => e.trustEvent === "fulfilled_on_time" || e.trustEvent === "fulfilled_early",
          ).length /
            fulfillmentEvents.length) *
            100,
        );

  const pickingBacklog = w.tasks.filter((t) => t.status === "pending" || t.status === "in_progress").length;

  const shortfallSkus = new Set<string>();
  for (const o of openOrders) {
    for (const item of o.items) {
      if (item.qty - item.allocated > 0) shortfallSkus.add(item.sku);
    }
  }

  const openExceptions = w.alerts.filter((a) => a.status === "open").length;
  const awaitingDispatch = w.orders.filter((o) => o.status === "qc").length;

  let revenueAtRisk = 0;
  for (const o of openOrders) {
    for (const item of o.items) {
      revenueAtRisk += Math.max(0, item.qty - item.allocated) * item.price;
    }
  }

  const fifo = revenueComparison(w.products, w.orders, now);
  const trustSummary = computeTrustSummary(w, now);

  return {
    openOrders: openOrders.length,
    atRiskOrders: atRisk.length,
    onTimeFulfillmentPct: onTime,
    pickingBacklog,
    shortfallSkus: shortfallSkus.size,
    openExceptions,
    awaitingDispatch,
    revenueAtRisk,
    revenueCapturedVsFifo: fifo,
    trustIndex: trustSummary.averageTrust,
    trustProtected: trustSummary.belowFloor.map((c) => c.customer),
  };
}

function computeFunnel(w: World) {
  const counts = new Map<string, number>();
  for (const status of FLOW) counts.set(status, 0);
  for (const o of w.orders) counts.set(o.status, (counts.get(o.status) ?? 0) + 1);
  return FLOW.map((status) => ({ status, count: counts.get(status) ?? 0 }));
}

function computeStockHealth(w: World) {
  let healthy = 0;
  let low = 0;
  let out = 0;
  for (const p of w.products) {
    if (p.onHand <= 0) out += 1;
    else if (p.onHand < p.reorderPoint) low += 1;
    else healthy += 1;
  }
  return { healthy, low, out, total: w.products.length };
}

function computeZoneLoad(w: World) {
  const open = w.tasks.filter((t) => t.status === "pending" || t.status === "in_progress");
  const byZone = new Map<string, { open: number; activePickers: Set<string> }>();
  for (const t of open) {
    const entry = byZone.get(t.zone) ?? { open: 0, activePickers: new Set<string>() };
    entry.open += 1;
    if (t.status === "in_progress" && t.assignee) entry.activePickers.add(t.assignee);
    byZone.set(t.zone, entry);
  }
  return [...byZone.entries()]
    .map(([zone, e]) => ({
      zone,
      open: e.open,
      activePickers: e.activePickers.size,
      pickers: [...e.activePickers],
    }))
    .sort((a, b) => b.open - a.open);
}

function computeTopShortfalls(w: World) {
  const bySku = new Map<string, { sku: string; name: string; unfilled: number; price: number; productId: Id<"products"> }>();
  for (const o of w.orders) {
    if (!OPEN_ORDER_STATUSES.includes(o.status)) continue;
    for (const item of o.items) {
      const unfilled = Math.max(0, item.qty - item.allocated);
      if (unfilled <= 0) continue;
      const entry = bySku.get(item.sku) ?? {
        sku: item.sku,
        name: item.name,
        unfilled: 0,
        price: item.price,
        productId: item.productId,
      };
      entry.unfilled += unfilled;
      bySku.set(item.sku, entry);
    }
  }
  return [...bySku.values()].sort((a, b) => b.unfilled - a.unfilled).slice(0, 5);
}

function computeLatestAlerts(w: World, limit = 8) {
  return w.alerts
    .filter((a) => a.status === "open" || a.status === "acknowledged")
    .sort(
      (a, b) =>
        SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || b.createdAt - a.createdAt,
    )
    .slice(0, limit);
}

function computeTrustSummary(w: World, now: number) {
  const trustEntries: TrustEntry[] = w.decisionLog;
  // customers with any open order or any order created in the last 30 days
  const cutoff = now - 30 * 86_400_000;
  const customers = new Set<string>();
  for (const o of w.orders) {
    if (OPEN_ORDER_STATUSES.includes(o.status) || o.createdAt >= cutoff) {
      customers.add(o.customer);
    }
  }
  const scores = [...customers].map((customer) => ({
    customer,
    score: computeCustomerTrust(trustEntries, customer, now),
    strikes: countDonorStrikes(trustEntries, customer, now),
  }));
  scores.sort((a, b) => a.score - b.score);
  const averageTrust =
    scores.length === 0 ? 100 : Math.round(scores.reduce((s, c) => s + c.score, 0) / scores.length);
  const belowFloor = scores.filter((c) => c.score < 40);
  return { averageTrust, belowFloor, scores };
}

/* ------------------------------------------------------------ queries */

export const overview = query({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const w = await readWorld(ctx);
    return {
      kpis: computeKpis(w, now),
      funnel: computeFunnel(w),
      stockHealth: computeStockHealth(w),
      zoneLoad: computeZoneLoad(w),
      topShortfalls: computeTopShortfalls(w),
      latestAlerts: computeLatestAlerts(w, 8),
      trustSummary: computeTrustSummary(w, now),
    };
  },
});

export const kpis = query({
  args: {},
  handler: async (ctx) => computeKpis(await readWorld(ctx), Date.now()),
});

export const funnel = query({
  args: {},
  handler: async (ctx) => computeFunnel(await readWorld(ctx)),
});

export const stockHealth = query({
  args: {},
  handler: async (ctx) => computeStockHealth(await readWorld(ctx)),
});

export const zoneLoad = query({
  args: {},
  handler: async (ctx) => computeZoneLoad(await readWorld(ctx)),
});

export const topShortfalls = query({
  args: {},
  handler: async (ctx) => computeTopShortfalls(await readWorld(ctx)),
});

export const latestAlerts = query({
  args: {},
  handler: async (ctx) => computeLatestAlerts(await readWorld(ctx)),
});

export const fifoComparison = query({
  args: {},
  handler: async (ctx) => {
    const w = await readWorld(ctx);
    return revenueComparison(w.products, w.orders, Date.now());
  },
});

export const customerTrustSummary = query({
  args: {},
  handler: async (ctx) => {
    const w = await readWorld(ctx);
    return computeTrustSummary(w, Date.now());
  },
});

/** §7.8 — live availability for a product (query, for the Orders detail sheet). */
export const availability = query({
  args: { productId: v.id("products") },
  handler: async (ctx, { productId }) => {
    const [product, orders] = await Promise.all([
      ctx.db.get(productId),
      ctx.db.query("orders").collect(),
    ]);
    if (!product) return null;
    const reserved = computeReserved(product._id, orders);
    return {
      onHand: product.onHand,
      reserved,
      available: Math.max(0, product.onHand - reserved),
      reorderPoint: product.reorderPoint,
      sku: product.sku,
    };
  },
});

/** §7.7 — customer trust score, computed entirely from decisionLog. */
export const customerTrustScore = query({
  args: { customer: v.string() },
  handler: async (ctx, { customer }) => {
    const entries = await ctx.db.query("decisionLog").collect();
    return {
      customer,
      score: computeCustomerTrust(entries, customer, Date.now()),
      strikes: countDonorStrikes(entries, customer, Date.now()),
    };
  },
});

/* ------------------------------------------------------------ list queries */

export const listProducts = query({
  args: {},
  handler: async (ctx) => {
    const w = await readWorld(ctx);
    return w.products.sort((a, b) => a.sku.localeCompare(b.sku));
  },
});

export const listOrders = query({
  args: {},
  handler: async (ctx) => {
    const w = await readWorld(ctx);
    return w.orders;
  },
});

export const listTasks = query({
  args: {},
  handler: async (ctx) => {
    const w = await readWorld(ctx);
    return w.tasks.sort((a, b) => a.createdAt - b.createdAt);
  },
});

export const listAlerts = query({
  args: {},
  handler: async (ctx) => {
    const w = await readWorld(ctx);
    return w.alerts.sort(
      (a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || b.createdAt - a.createdAt,
    );
  },
});

export const listShipments = query({
  args: {},
  handler: async (ctx) => {
    const w = await readWorld(ctx);
    return w.shipments.sort((a, b) => b.dispatchedAt - a.dispatchedAt);
  },
});

export const listDecisionLog = query({
  args: {},
  handler: async (ctx) => {
    const w = await readWorld(ctx);
    return w.decisionLog.sort((a, b) => b.createdAt - a.createdAt);
  },
});

/** §7.8 — orders with per-order computed availability (for the Orders page). */
export const ordersWithAvailability = query({
  args: {},
  handler: async (ctx) => {
    const w = await readWorld(ctx);
    return w.orders.map((o) => ({
      order: o,
      lines: o.items.map((item) => {
        const reserved = computeReserved(item.productId, w.orders);
        const product = w.products.find((p) => p._id === item.productId);
        return {
          item,
          onHand: product?.onHand ?? 0,
          reserved,
          available: Math.max(0, (product?.onHand ?? 0) - reserved),
        };
      }),
    }));
  },
});
