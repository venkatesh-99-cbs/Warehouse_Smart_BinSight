/**
 * fulfillment.ts — the order lifecycle (§7.4): picking tasks, stock committed
 * at pick time, packing / QC / dispatch / delivery, and the issue (missing /
 * damaged) path. Every transition re-reads state at execution time (§11) and
 * logs to decisionLog. Exports nothing scoring-related (§7.6.1).
 */
import { v } from "convex/values";
import { mutation, type MutationCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import type { OrderState, OrderItemState } from "./domain";
import { logDecision, resolveAlertByDedupeKey, upsertAlert } from "./alerts";

/* ------------------------------------------------------------ helpers */

async function patchOrderStatus(
  ctx: MutationCtx,
  order: OrderState,
  status: OrderState["status"],
  now: number,
): Promise<void> {
  await ctx.db.patch(order._id, { status, updatedAt: now });
}

/* ------------------------------------------------------------ mutations */

/** §7.4 — create one picking task per order line; order → picking. */
export const startPicking = mutation({
  args: { orderId: v.id("orders") },
  handler: async (ctx, { orderId }) => {
    const now = Date.now();
    const order = await ctx.db.get(orderId);
    if (!order) return { applied: false, reason: "order not found" };
    if (order.status !== "allocated") {
      return { applied: false, reason: `order must be allocated to start picking (current: ${order.status})` };
    }
    const existing = await ctx.db
      .query("pickingTasks")
      .withIndex("by_order", (q) => q.eq("orderId", orderId))
      .first();
    if (existing) return { applied: false, reason: "picking tasks already exist" };

    for (const item of order.items) {
      const product = await ctx.db.get(item.productId);
      if (!product) continue;
      await ctx.db.insert("pickingTasks", {
        orderId,
        productId: item.productId,
        sku: item.sku,
        name: item.name,
        zone: product.zone,
        bin: product.bin,
        qty: item.qty,
        picked: 0,
        status: "pending",
        createdAt: now,
        updatedAt: now,
      });
    }
    await patchOrderStatus(ctx, order, "picking", now);
    await logDecision(ctx, {
      kind: "fulfillment",
      summary: `Picking started for ${order.orderNumber}`,
      outcome: `${order.items.length} picking task(s) created for ${order.customer}`,
      customer: order.customer,
      refId: order._id,
      createdAt: now,
    });
    return { applied: true };
  },
});

/** §7.4 — claim a task (assignee), task → in_progress. */
export const claimTask = mutation({
  args: { taskId: v.id("pickingTasks"), assignee: v.string() },
  handler: async (ctx, { taskId, assignee }) => {
    const now = Date.now();
    const task = await ctx.db.get(taskId);
    if (!task) return { applied: false, reason: "task not found" };
    if (task.status === "picked") return { applied: false, reason: "task already completed" };
    await ctx.db.patch(taskId, {
      status: "in_progress",
      assignee,
      updatedAt: now,
    });
    return { applied: true };
  },
});

/** §7.4 — complete a task: stock is committed at pick time. */
export const completeTask = mutation({
  args: { taskId: v.id("pickingTasks"), pickedQty: v.number() },
  handler: async (ctx, { taskId, pickedQty }) => {
    const now = Date.now();
    if (!Number.isFinite(pickedQty) || pickedQty <= 0) {
      return { applied: false, reason: "picked quantity must be greater than 0" };
    }
    const task = await ctx.db.get(taskId);
    if (!task) return { applied: false, reason: "task not found" };
    if (task.status === "picked") return { applied: false, reason: "task already completed" };
    if (pickedQty > task.qty) {
      return { applied: false, reason: `picked quantity cannot exceed ${task.qty}` };
    }
    const product = await ctx.db.get(task.productId);
    const order = await ctx.db.get(task.orderId);
    if (!product || !order) return { applied: false, reason: "referenced entity not found" };
    if (product.onHand < pickedQty) {
      return { applied: false, reason: `only ${product.onHand} unit(s) of ${product.sku} on hand` };
    }

    // Commit stock at pick time. `reserved` is derived (computeReserved), not
    // stored on the product — §6.2 defines no reserved field, so the §7.4
    // `product.reserved -= pickedQty` step is satisfied implicitly: picking
    // raises item.picked, which lowers computeReserved on the next read.
    await ctx.db.patch(product._id, { onHand: product.onHand - pickedQty });

    const items: OrderItemState[] = order.items.map((item) =>
      item.productId === task.productId
        ? { ...item, picked: Math.min(item.qty, item.picked + pickedQty) }
        : item,
    );
    const fullyPicked = items.every((i) => i.picked >= i.qty);
    await ctx.db.patch(order._id, {
      items,
      status: fullyPicked ? "picked" : order.status,
      updatedAt: now,
    });
    await ctx.db.patch(taskId, {
      picked: pickedQty,
      status: pickedQty >= task.qty ? "picked" : "in_progress",
      updatedAt: now,
    });

    await logDecision(ctx, {
      kind: "fulfillment",
      summary: `Picked ${pickedQty} × ${task.sku} for ${order.orderNumber}`,
      outcome: `${task.zone} / ${task.bin} — ${order.items.find((i) => i.productId === task.productId)?.picked ?? pickedQty} of ${task.qty} picked`,
      customer: order.customer,
      refId: order._id,
      createdAt: now,
    });
    return { applied: true, fullyPicked, orderStatus: fullyPicked ? "picked" : order.status };
  },
});

/** §7.4 — pack a fully picked order. */
export const packOrder = mutation({
  args: { orderId: v.id("orders") },
  handler: async (ctx, { orderId }) => {
    const now = Date.now();
    const order = await ctx.db.get(orderId);
    if (!order) return { applied: false, reason: "order not found" };
    if (order.status !== "picked") {
      return { applied: false, reason: `order must be picked before packing (current: ${order.status})` };
    }
    await patchOrderStatus(ctx, order, "packed", now);
    await logDecision(ctx, {
      kind: "fulfillment",
      summary: `Packed ${order.orderNumber}`,
      outcome: `${order.items.length} line(s) packed for ${order.customer}`,
      customer: order.customer,
      refId: order._id,
      createdAt: now,
    });
    return { applied: true };
  },
});

/** §7.4 — QC an order; auto-resolves any open deadline_risk alert. */
export const qcOrder = mutation({
  args: { orderId: v.id("orders") },
  handler: async (ctx, { orderId }) => {
    const now = Date.now();
    const order = await ctx.db.get(orderId);
    if (!order) return { applied: false, reason: "order not found" };
    if (order.status !== "packed") {
      return { applied: false, reason: `order must be packed before QC (current: ${order.status})` };
    }
    await patchOrderStatus(ctx, order, "qc", now);
    await resolveAlertByDedupeKey(ctx, `deadline_risk:${order._id}`, now, "passed QC — proceeding to dispatch");
    await logDecision(ctx, {
      kind: "fulfillment",
      summary: `QC passed for ${order.orderNumber}`,
      outcome: `${order.orderNumber} passed quality control for ${order.customer}`,
      customer: order.customer,
      refId: order._id,
      createdAt: now,
    });
    return { applied: true };
  },
});

/** §7.4 — dispatch: creates an in_transit shipment, order → dispatched. */
export const dispatchOrder = mutation({
  args: { orderId: v.id("orders"), carrier: v.string(), tracking: v.string() },
  handler: async (ctx, { orderId, carrier, tracking }) => {
    const now = Date.now();
    if (!carrier.trim() || !tracking.trim()) {
      return { applied: false, reason: "carrier and tracking number are required" };
    }
    const order = await ctx.db.get(orderId);
    if (!order) return { applied: false, reason: "order not found" };
    if (order.status !== "qc") {
      return { applied: false, reason: `order must pass QC before dispatch (current: ${order.status})` };
    }
    await patchOrderStatus(ctx, order, "dispatched", now);
    await ctx.db.insert("shipments", {
      orderId,
      carrier,
      tracking,
      status: "in_transit",
      dispatchedAt: now,
    });
    await logDecision(ctx, {
      kind: "fulfillment",
      summary: `Dispatched ${order.orderNumber}`,
      outcome: `${carrier} / ${tracking} — in transit`,
      customer: order.customer,
      refId: order._id,
      createdAt: now,
    });
    return { applied: true };
  },
});

/** §7.4 — delivery: logs the trust event (early / on time / missed). */
export const markDelivered = mutation({
  args: { shipmentId: v.id("shipments") },
  handler: async (ctx, { shipmentId }) => {
    const now = Date.now();
    const shipment = await ctx.db.get(shipmentId);
    if (!shipment) return { applied: false, reason: "shipment not found" };
    if (shipment.status === "delivered") return { applied: false, reason: "shipment already delivered" };
    const order = await ctx.db.get(shipment.orderId);
    if (!order) return { applied: false, reason: "order not found" };

    await ctx.db.patch(shipmentId, { status: "delivered", deliveredAt: now });
    await patchOrderStatus(ctx, order, "fulfilled", now);

    const hoursBeforeDeadline = (order.deadline - now) / 3_600_000;
    // §7.4: delivered >6h before deadline → fulfilled_early; within deadline →
    // fulfilled_on_time; past deadline → deadline_missed.
    const trustEvent =
      hoursBeforeDeadline > 6
        ? ("fulfilled_early" as const)
        : hoursBeforeDeadline >= 0
          ? ("fulfilled_on_time" as const)
          : ("deadline_missed" as const);

    await logDecision(ctx, {
      kind: "fulfillment",
      summary: `Delivered ${order.orderNumber} (${trustEvent.replace(/_/g, " ")})`,
      outcome: `${shipment.carrier} / ${shipment.tracking} delivered to ${order.customer} — ${
        trustEvent === "fulfilled_early"
          ? `${Math.round(hoursBeforeDeadline)}h before deadline`
          : trustEvent === "fulfilled_on_time"
            ? "within deadline"
            : `${Math.round(-hoursBeforeDeadline)}h past deadline`
      }`,
      customer: order.customer,
      refId: order._id,
      trustEvent,
      createdAt: now,
    });
    return { applied: true, trustEvent };
  },
});

/** §7.4 — issue on a task (missing/damaged): raises an alert, task stays open. */
export const issueTask = mutation({
  args: { taskId: v.id("pickingTasks"), issue: v.union(v.literal("missing"), v.literal("damaged")) },
  handler: async (ctx, { taskId, issue }) => {
    const now = Date.now();
    const task = await ctx.db.get(taskId);
    if (!task) return { applied: false, reason: "task not found" };
    if (task.status === "picked") return { applied: false, reason: "task already completed" };
    const order = await ctx.db.get(task.orderId);
    if (!order) return { applied: false, reason: "order not found" };

    const type = issue === "missing" ? "missing_item" : "damaged_item";
    await upsertAlert(
      ctx,
      {
        type,
        severity: "warning",
        title: `${type === "missing_item" ? "Missing" : "Damaged"} item: ${task.sku}`,
        message: `${order.orderNumber} (${order.customer}): ${issue === "missing" ? "1 unit missing" : "units damaged"} — ${task.sku} at ${task.bin}`,
        suggestion:
          issue === "missing"
            ? `Re-pick from ${task.bin}, then cycle-count zone ${task.zone}`
            : `Write off the damaged units, adjust stock, re-pick from ${task.bin}`,
        refType: "order",
        refId: order._id,
        dedupeKey: `${type}:${order._id}`,
      },
      now,
    );
    // §7.4 — log the exception with the order's customer for visibility; this
    // does NOT emit a donor_raided-class trust event (the customer did not
    // cause the issue, and must not be penalized as if they did).
    await logDecision(ctx, {
      kind: "exception",
      summary: `${type === "missing_item" ? "Missing" : "Damaged"} item on ${order.orderNumber}`,
      outcome: `${task.sku} at ${task.bin} — ${issue === "missing" ? "re-pick + cycle count" : "write off + re-pick"} required`,
      customer: order.customer,
      refId: order._id,
      createdAt: now,
    });
    return { applied: true };
  },
});
