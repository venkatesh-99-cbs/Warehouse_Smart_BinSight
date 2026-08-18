/**
 * alerts.ts — alert lifecycle (§7.5): deduped upserts, ack / resolve /
 * dismiss, plus the inventory actions that create or clear alerts (reorder,
 * receive stock). Suggestion copy is always generated from the real referenced
 * entity's fields — never a static template.
 */
import { v } from "convex/values";
import { mutation, type MutationCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { ALERT_TYPE_META, type AlertInput, type DecisionInput } from "./domain";
import { logActivity } from "./activities";

/* ------------------------------------------------------------ helpers */

export async function findOpenAlert(
  ctx: MutationCtx,
  dedupeKey: string,
): Promise<Doc<"alerts"> | null> {
  const existing = await ctx.db
    .query("alerts")
    .withIndex("by_dedupe", (q) => q.eq("dedupeKey", dedupeKey))
    .filter((q) => q.eq(q.field("status"), "open"))
    .first();
  return existing ?? null;
}

/**
 * Upsert an alert by dedupeKey (`<type>:<refId>`). Reuses an open alert if one
 * exists (refreshing its copy), otherwise inserts a new one.
 */
export async function upsertAlert(
  ctx: MutationCtx,
  input: AlertInput,
  now: number,
): Promise<Id<"alerts">> {
  if (input.dedupeKey) {
    const existing = await findOpenAlert(ctx, input.dedupeKey);
    if (existing) {
      await ctx.db.patch(existing._id, {
        type: input.type,
        severity: input.severity,
        title: input.title,
        message: input.message,
        suggestion: input.suggestion,
      });
      return existing._id;
    }
  }
  return await ctx.db.insert("alerts", {
    type: input.type,
    severity: input.severity,
    status: "open",
    title: input.title,
    message: input.message,
    suggestion: input.suggestion,
    refType: input.refType,
    refId: input.refId,
    dedupeKey: input.dedupeKey,
    createdAt: now,
  });
}

/** Log a decision. `customer` must be set on reallocation/fulfillment/exception entries. */
export async function logDecision(ctx: MutationCtx, entry: DecisionInput): Promise<void> {
  await ctx.db.insert("decisionLog", entry);
}

/** Resolve any open alert matching a dedupeKey (used to clear e.g. low_stock). */
export async function resolveAlertByDedupeKey(
  ctx: MutationCtx,
  dedupeKey: string,
  now: number,
  decision: string,
): Promise<void> {
  const existing = await ctx.db
    .query("alerts")
    .withIndex("by_dedupe", (q) => q.eq("dedupeKey", dedupeKey))
    .filter((q) => q.eq(q.field("status"), "open"))
    .first();
  if (existing) {
    await ctx.db.patch(existing._id, {
      status: "resolved",
      resolvedAt: now,
      decision,
    });
  }
}

/* ------------------------------------------------------------ mutations */

export const acknowledgeAlert = mutation({
  args: { id: v.id("alerts") },
  handler: async (ctx, { id }) => {
    const alert = await ctx.db.get(id);
    if (!alert) return { applied: false, reason: "alert not found" };
    if (alert.status !== "open") return { applied: false, reason: `alert is ${alert.status}` };
    await ctx.db.patch(id, { status: "acknowledged" });
    await logActivity(ctx, {
      eventType: "crisis_acknowledged",
      category: "crisis",
      description: `Crisis acknowledged: ${alert.title}`,
      entityType: alert.refType,
      entityId: alert.refId,
      orderId: alert.refType === "order" ? alert.refId : undefined,
      severity: alert.severity,
      status: "acknowledged",
    });
    return { applied: true };
  },
});

/** §7.5 — resolve an alert with an operator decision; logs a decision entry. */
export const resolveAlert = mutation({
  args: { id: v.id("alerts"), decision: v.string() },
  handler: async (ctx, { id, decision }) => {
    const now = Date.now();
    const alert = await ctx.db.get(id);
    if (!alert) return { applied: false, reason: "alert not found" };
    if (alert.status === "resolved" || alert.status === "dismissed") {
      return { applied: false, reason: `alert is ${alert.status}` };
    }
    await ctx.db.patch(id, {
      status: "resolved",
      resolvedAt: now,
      decision,
    });
    // Log the resolution; attach the customer when the alert references an order
    // (exception entries must carry `customer` — §6.2).
    let customer: string | undefined;
    if (alert.refType === "order" && alert.refId) {
      const order = await ctx.db.get(alert.refId as Id<"orders">);
      customer = order?.customer;
    }
    await logDecision(ctx, {
      kind: "exception",
      summary: `${ALERT_TYPE_META[alert.type].label} resolved: ${alert.title}`,
      outcome: decision,
      customer,
      refId: alert.refId,
      createdAt: now,
    });
    await logActivity(ctx, {
      eventType: "crisis_resolved",
      category: "crisis",
      description: `Crisis resolved: ${alert.title} — ${decision}`,
      entityType: alert.refType,
      entityId: alert.refId,
      orderId: alert.refType === "order" ? alert.refId : undefined,
      severity: alert.severity,
      status: "resolved",
      newValue: decision,
    });
    return { applied: true };
  },
});

export const dismissAlert = mutation({
  args: { id: v.id("alerts") },
  handler: async (ctx, { id }) => {
    const alert = await ctx.db.get(id);
    if (!alert) return { applied: false, reason: "alert not found" };
    if (alert.status === "resolved" || alert.status === "dismissed") {
      return { applied: false, reason: `alert is ${alert.status}` };
    }
    await ctx.db.patch(id, { status: "dismissed" });
    return { applied: true };
  },
});

/** Inventory action: raise a reorder decision + reorder_due alert. */
export const raiseReorder = mutation({
  args: { productId: v.id("products") },
  handler: async (ctx, { productId }) => {
    const now = Date.now();
    const product = await ctx.db.get(productId);
    if (!product) return { applied: false, reason: "product not found" };
    await upsertAlert(
      ctx,
      {
        type: "reorder_due",
        severity: "info",
        title: `Reorder due: ${product.sku}`,
        message: `${product.sku} — ${product.onHand} on hand vs reorder point ${product.reorderPoint}`,
        suggestion: `Reorder ${product.reorderQty} units with ${product.supplier} (lead time ${product.leadTimeDays}d)`,
        refType: "product",
        refId: product._id,
        dedupeKey: `reorder_due:${product._id}`,
      },
      now,
    );
    await logDecision(ctx, {
      kind: "reorder",
      summary: `Reorder triggered: ${product.sku}`,
      detail: `${product.onHand} on hand, reorder point ${product.reorderPoint}`,
      outcome: `PO raised for ${product.reorderQty} units with ${product.supplier} (lead time ${product.leadTimeDays}d)`,
      refId: product._id,
      createdAt: now,
    });
    await logActivity(ctx, {
      eventType: "reorder_raised",
      category: "inventory",
      description: `Reorder raised for ${product.sku} — PO for ${product.reorderQty} units with ${product.supplier}`,
      entityType: "product",
      entityId: product._id,
      sku: product.sku,
      previousValue: `${product.onHand} on hand (reorder point ${product.reorderPoint})`,
      newValue: `PO ${product.reorderQty} units · lead time ${product.leadTimeDays}d`,
      severity: "warning",
      status: "open",
    });
    return { applied: true };
  },
});

/** Inventory action: receive stock, clear low/out alerts when healthy again. */
export const receiveStock = mutation({
  args: { productId: v.id("products"), qty: v.number() },
  handler: async (ctx, { productId, qty }) => {
    const now = Date.now();
    if (!Number.isFinite(qty) || qty <= 0) {
      return { applied: false, reason: "quantity must be greater than 0" };
    }
    const product = await ctx.db.get(productId);
    if (!product) return { applied: false, reason: "product not found" };
    const newOnHand = product.onHand + qty;
    await ctx.db.patch(productId, { onHand: newOnHand });
    await logDecision(ctx, {
      kind: "restock",
      summary: `Stock received: ${product.sku} +${qty}`,
      outcome: `${product.sku} on hand is now ${newOnHand} (was ${product.onHand})`,
      refId: product._id,
      createdAt: now,
    });
    await logActivity(ctx, {
      eventType: "stock_received",
      category: "inventory",
      description: `Stock received for ${product.sku}: +${qty} units`,
      entityType: "product",
      entityId: product._id,
      sku: product.sku,
      previousValue: `${product.onHand} on hand`,
      newValue: `${newOnHand} on hand`,
      severity: "info",
      status: "received",
    });
    if (newOnHand >= product.reorderPoint) {
      await resolveAlertByDedupeKey(ctx, `low_stock:${product._id}`, now, "stock received above reorder point");
    }
    if (newOnHand > 0) {
      await resolveAlertByDedupeKey(ctx, `stockout:${product._id}`, now, "stock received");
    }
    return { applied: true, onHand: newOnHand };
  },
});
