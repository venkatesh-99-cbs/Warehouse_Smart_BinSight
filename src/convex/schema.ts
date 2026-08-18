import { authTables } from "@convex-dev/auth/server";
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

// default user roles. can add / remove based on the project as needed
export const ROLES = {
  ADMIN: "admin",
  USER: "user",
  MEMBER: "member",
} as const;

export const roleValidator = v.union(
  v.literal(ROLES.ADMIN),
  v.literal(ROLES.USER),
  v.literal(ROLES.MEMBER),
);

/* ------------------------------------------------ §6.1 enum validators */

export const priorityValidator = v.union(
  v.literal("urgent"),
  v.literal("high"),
  v.literal("medium"),
  v.literal("low"),
);

export const orderStatusValidator = v.union(
  v.literal("pending"),
  v.literal("review"),
  v.literal("allocated"),
  v.literal("picking"),
  v.literal("picked"),
  v.literal("packed"),
  v.literal("qc"),
  v.literal("dispatched"),
  v.literal("fulfilled"),
  v.literal("cancelled"),
);

export const alertTypeValidator = v.union(
  v.literal("low_stock"),
  v.literal("stockout"),
  v.literal("shortfall"),
  v.literal("missing_item"),
  v.literal("damaged_item"),
  v.literal("bottleneck"),
  v.literal("deadline_risk"),
  v.literal("reorder_due"),
);

export const alertSeverityValidator = v.union(
  v.literal("critical"),
  v.literal("warning"),
  v.literal("info"),
);

export const alertStatusValidator = v.union(
  v.literal("open"),
  v.literal("acknowledged"),
  v.literal("resolved"),
  v.literal("dismissed"),
);

export const taskStatusValidator = v.union(
  v.literal("pending"),
  v.literal("in_progress"),
  v.literal("picked"),
);

export const shipmentStatusValidator = v.union(
  v.literal("in_transit"),
  v.literal("delivered"),
);

export const decisionKindValidator = v.union(
  v.literal("allocation"),
  v.literal("reallocation"),
  v.literal("reorder"),
  v.literal("restock"),
  v.literal("priority"),
  v.literal("exception"),
  v.literal("simulation"),
  v.literal("fulfillment"),
);

export const trustEventValidator = v.union(
  v.literal("donor_raided"),
  v.literal("deadline_missed"),
  v.literal("partial_fulfilled"),
  v.literal("fulfilled_on_time"),
  v.literal("fulfilled_early"),
);

export const orderItemValidator = v.object({
  productId: v.id("products"),
  sku: v.string(),
  name: v.string(),
  qty: v.number(),
  allocated: v.number(),
  picked: v.number(),
  packed: v.number(),
  price: v.number(),
});

const schema = defineSchema(
  {
    // default auth tables using convex auth.
    ...authTables, // do not remove or modify

    // the users table is the default users table that is brought in by the authTables
    users: defineTable({
      name: v.optional(v.string()), // name of the user. do not remove
      image: v.optional(v.string()), // image of the user. do not remove
      email: v.optional(v.string()), // email of the user. do not remove
      emailVerificationTime: v.optional(v.number()), // email verification time. do not remove
      isAnonymous: v.optional(v.boolean()), // is the user anonymous. do not remove

      role: v.optional(roleValidator), // role of the user. do not remove
    }).index("email", ["email"]), // index for the email. do not remove or modify

    /* ------------------------------------------------ §6.2 WarehouseOS tables */

    products: defineTable({
      sku: v.string(),
      name: v.string(),
      category: v.string(),
      unit: v.string(),
      price: v.number(),
      onHand: v.number(),
      reorderPoint: v.number(),
      reorderQty: v.number(),
      leadTimeDays: v.number(),
      supplier: v.string(),
      zone: v.string(),
      bin: v.string(),
    })
      .index("by_sku", ["sku"])
      .index("by_zone", ["zone"]),

    orders: defineTable({
      orderNumber: v.string(),
      customer: v.string(),
      priority: priorityValidator,
      status: orderStatusValidator,
      items: v.array(orderItemValidator),
      deadline: v.number(),
      createdAt: v.number(),
      updatedAt: v.number(),
      notes: v.optional(v.string()),
      // display-only flag (§10.3): marks the two canonical demo dilemmas
      isDemoScenario: v.optional(v.boolean()),
    })
      .index("by_status", ["status"])
      .index("by_priority", ["priority"])
      .index("by_created", ["createdAt"])
      .index("by_customer", ["customer"]),

    pickingTasks: defineTable({
      orderId: v.id("orders"),
      productId: v.id("products"),
      sku: v.string(),
      name: v.string(),
      zone: v.string(),
      bin: v.string(),
      qty: v.number(),
      picked: v.number(),
      status: taskStatusValidator,
      assignee: v.optional(v.string()),
      createdAt: v.number(),
      updatedAt: v.number(),
    })
      .index("by_status", ["status"])
      .index("by_order", ["orderId"])
      .index("by_zone", ["zone"]),

    alerts: defineTable({
      type: alertTypeValidator,
      severity: alertSeverityValidator,
      status: alertStatusValidator,
      title: v.string(),
      message: v.string(),
      suggestion: v.string(),
      refType: v.union(
        v.literal("order"),
        v.literal("product"),
        v.literal("zone"),
        v.literal("system"),
      ),
      refId: v.optional(v.string()),
      dedupeKey: v.optional(v.string()),
      decision: v.optional(v.string()),
      // set on a shortfall alert once a reallocation has drawn from a donor,
      // so the UI can link target ↔ donor without re-deriving it from the log.
      donorOrderId: v.optional(v.id("orders")),
      createdAt: v.number(),
      resolvedAt: v.optional(v.number()),
    })
      .index("by_status", ["status"])
      .index("by_type", ["type"])
      .index("by_dedupe", ["dedupeKey"]),

    shipments: defineTable({
      orderId: v.id("orders"),
      carrier: v.string(),
      tracking: v.string(),
      status: shipmentStatusValidator,
      dispatchedAt: v.number(),
      deliveredAt: v.optional(v.number()),
    }).index("by_order", ["orderId"]),

    decisionLog: defineTable({
      kind: decisionKindValidator,
      summary: v.string(),
      detail: v.optional(v.string()),
      outcome: v.string(),
      // customer + refId are REQUIRED on reallocation/fulfillment/exception
      // entries — the trust model aggregates this table, and a missing
      // customer silently breaks trust scoring (§6.2).
      customer: v.optional(v.string()),
      refId: v.optional(v.string()),
      trustEvent: v.optional(trustEventValidator),
      createdAt: v.number(),
    })
      .index("by_created", ["createdAt"])
      .index("by_customer", ["customer"]),
  },
  {
    schemaValidation: false,
  },
);

export default schema;
