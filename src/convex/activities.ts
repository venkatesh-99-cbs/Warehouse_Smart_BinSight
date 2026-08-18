/**
 * activities.ts — the Activity Logs / audit center (§13–§15).
 *
 * One reusable event structure (schema `activities` table) that every
 * meaningful mutation writes through `logActivity`. The UI only reads what the
 * system actually recorded — no fabricated entries. `logEvent` exists so the
 * frontend can log manager-driven steps (simulation started, strategy
 * selected, approval requested) that only exist in the UI flow.
 */
import { v } from "convex/values";
import { mutation, query, type MutationCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { activityCategoryValidator, alertSeverityValidator } from "./schema";

export type ActivityCategory =
  | "orders"
  | "inventory"
  | "operations"
  | "shipments"
  | "crisis"
  | "decisions"
  | "system";

export type ActivityInput = {
  eventType: string;
  category: ActivityCategory;
  description: string;
  actor?: string;
  actorRole?: string;
  entityType?: "order" | "product" | "zone" | "shipment" | "system";
  entityId?: string;
  orderId?: string;
  sku?: string;
  previousValue?: string;
  newValue?: string;
  status?: string;
  severity?: "info" | "warning" | "critical";
  metadata?: Record<string, string | number | boolean>;
  timestamp?: number;
};

/** Resolve the acting user from the auth identity; fall back to the operator role. */
async function actorFrom(ctx: MutationCtx): Promise<{ actor: string; actorRole: string }> {
  try {
    const identity = await ctx.auth.getUserIdentity();
    if (identity) {
      const name = identity.name ?? identity.email ?? "";
      if (name) return { actor: name, actorRole: "Warehouse Manager" };
    }
  } catch {
    // identity unavailable — fall through to the operator default
  }
  return { actor: "Warehouse Manager", actorRole: "Warehouse Manager" };
}

/** Internal-only: write one activity row (call from mutations, never from the client). */
export async function logActivity(ctx: MutationCtx, input: ActivityInput): Promise<Id<"activities">> {
  const { actor, actorRole } = await actorFrom(ctx);
  return ctx.db.insert("activities", {
    eventType: input.eventType,
    category: input.category,
    actor: input.actor ?? actor,
    actorRole: input.actorRole ?? actorRole,
    description: input.description,
    entityType: input.entityType,
    entityId: input.entityId,
    orderId: input.orderId,
    sku: input.sku,
    previousValue: input.previousValue,
    newValue: input.newValue,
    status: input.status,
    severity: input.severity,
    metadata: input.metadata ? JSON.stringify(input.metadata) : undefined,
    timestamp: input.timestamp ?? Date.now(),
  });
}

/* ------------------------------------------------------------ mutations */

/**
 * Client-facing logger for manager-driven steps that exist only in the UI flow
 * (simulation started, strategy selected, approval requested). Descriptions
 * must reference real values from the running scenario.
 */
export const logEvent = mutation({
  args: {
    eventType: v.string(),
    category: activityCategoryValidator,
    description: v.string(),
    orderId: v.optional(v.string()),
    sku: v.optional(v.string()),
    severity: v.optional(alertSeverityValidator),
    status: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await logActivity(ctx, args);
    return { logged: true };
  },
});

/* ------------------------------------------------------------ queries */

/** Latest activities, newest first, filtered by category / time window / search. */
export const listActivities = query({
  args: {
    category: v.optional(activityCategoryValidator),
    search: v.optional(v.string()),
    since: v.optional(v.number()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    let rows = await ctx.db
      .query("activities")
      .withIndex("by_timestamp")
      .order("desc")
      .take(500);
    const since = args.since;
    if (since) rows = rows.filter((a) => a.timestamp >= since);
    const category = args.category;
    if (category) rows = rows.filter((a) => a.category === category);
    const q = args.search?.trim().toLowerCase();
    if (q) {
      rows = rows.filter((a) =>
        [a.description, a.eventType, a.actor, a.actorRole, a.orderId, a.sku, a.status, a.entityId ?? "", a.metadata ?? ""]
          .some((f) => f?.toLowerCase().includes(q)),
      );
    }
    return rows.slice(0, args.limit ?? 200);
  },
});

/** KPI counts for the Activity Logs overview (§10). */
export const activityOverview = query({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const dayStart = new Date(now);
    dayStart.setHours(0, 0, 0, 0);
    const start = dayStart.getTime();
    const rows = await ctx.db
      .query("activities")
      .withIndex("by_timestamp")
      .order("desc")
      .take(500);
    const today = rows.filter((a) => a.timestamp >= start);
    const yesterday = rows.filter((a) => a.timestamp >= start - 86_400_000 && a.timestamp < start);
    const count = (cat: ActivityCategory) => today.filter((a) => a.category === cat).length;
    return {
      today: today.length,
      yesterday: yesterday.length,
      orders: count("orders"),
      inventory: count("inventory"),
      operations: count("operations"),
      shipments: count("shipments"),
      crisis: count("crisis"),
      decisions: count("decisions"),
      system: count("system"),
    };
  },
});
