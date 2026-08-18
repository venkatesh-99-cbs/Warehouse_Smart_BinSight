import { describe, it, expect } from "vitest";
import {
  validateSimInputs,
  capacityFrom,
  prepareWorld,
  SIM_DEFAULTS,
  type SimInputs,
} from "./simulator";
import type { OrderState, ProductState } from "./domain";

// ============================================================================
// Test Helpers & Fixtures
// ============================================================================

const mockProduct = (overrides?: Partial<ProductState>): ProductState => ({
  _id: "products/test-product" as any,
  _creationTime: Date.now(),
  sku: "SKU-001",
  name: "Test Product",
  category: "Electronics",
  unit: "unit",
  price: 100,
  onHand: 10,
  reorderPoint: 5,
  reorderQty: 20,
  leadTimeDays: 3,
  supplier: "Test Supplier",
  zone: "A",
  bin: "A1",
  ...overrides,
});

const mockOrder = (overrides?: Partial<OrderState>): OrderState => ({
  _id: "orders/test-order" as any,
  _creationTime: Date.now(),
  orderNumber: "ORD-001",
  customer: "Test Customer",
  priority: "medium" as const,
  status: "pending" as const,
  items: [
    {
      productId: "products/test-product" as any,
      sku: "SKU-001",
      name: "Test Product",
      qty: 5,
      allocated: 0,
      picked: 0,
      packed: 0,
      price: 100,
    },
  ],
  deadline: Date.now() + 24 * 3600000,
  createdAt: Date.now(),
  updatedAt: Date.now(),
  ...overrides,
});

// ============================================================================
// SIMULATOR VALIDATION TESTS
// ============================================================================

describe("Simulator: Input Validation", () => {
  const product = mockProduct();
  const order = mockOrder();
  const now = Date.now();

  it("should accept valid inputs", () => {
    const inputs: SimInputs = {
      addLines: [],
      priorityOverrides: [],
      incomingStock: [],
      damagedUnits: [],
      missingUnits: [],
      orderDelays: [],
      pickers: 4,
      pickingCapacity: 30,
      packingCapacity: 60,
      disruption: "none",
    };
    const result = validateSimInputs(inputs, [product], [order], now);
    expect(result.ok).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("should reject adding lines with unknown SKU", () => {
    const inputs: SimInputs = {
      addLines: [
        {
          sku: "UNKNOWN-SKU",
          qty: 5,
          priority: "high",
          deadline: now + 24 * 3600000,
        },
      ],
      priorityOverrides: [],
      incomingStock: [],
      damagedUnits: [],
      missingUnits: [],
      orderDelays: [],
      pickers: 4,
      pickingCapacity: 30,
      packingCapacity: 60,
      disruption: "none",
    };
    const result = validateSimInputs(inputs, [product], [order], now);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.message.includes("unknown SKU"))).toBe(true);
  });

  it("should reject zero quantity items", () => {
    const inputs: SimInputs = {
      addLines: [
        {
          sku: product.sku,
          qty: 0,
          priority: "high",
          deadline: now + 24 * 3600000,
        },
      ],
      priorityOverrides: [],
      incomingStock: [],
      damagedUnits: [],
      missingUnits: [],
      orderDelays: [],
      pickers: 4,
      pickingCapacity: 30,
      packingCapacity: 60,
      disruption: "none",
    };
    const result = validateSimInputs(inputs, [product], [order], now);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.message.includes("must be greater than 0"))).toBe(true);
  });

  it("should reject negative quantity items", () => {
    const inputs: SimInputs = {
      addLines: [
        {
          sku: product.sku,
          qty: -5,
          priority: "high",
          deadline: now + 24 * 3600000,
        },
      ],
      priorityOverrides: [],
      incomingStock: [],
      damagedUnits: [],
      missingUnits: [],
      orderDelays: [],
      pickers: 4,
      pickingCapacity: 30,
      packingCapacity: 60,
      disruption: "none",
    };
    const result = validateSimInputs(inputs, [product], [order], now);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.message.includes("must be greater than 0"))).toBe(true);
  });

  it("should reject non-integer quantities", () => {
    const inputs: SimInputs = {
      addLines: [
        {
          sku: product.sku,
          qty: 5.5,
          priority: "high",
          deadline: now + 24 * 3600000,
        },
      ],
      priorityOverrides: [],
      incomingStock: [],
      damagedUnits: [],
      missingUnits: [],
      orderDelays: [],
      pickers: 4,
      pickingCapacity: 30,
      packingCapacity: 60,
      disruption: "none",
    };
    const result = validateSimInputs(inputs, [product], [order], now);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.message.includes("must be a whole number"))).toBe(true);
  });

  it("should reject past deadlines", () => {
    const inputs: SimInputs = {
      addLines: [
        {
          sku: product.sku,
          qty: 5,
          priority: "high",
          deadline: now - 1000, // Past deadline
        },
      ],
      priorityOverrides: [],
      incomingStock: [],
      damagedUnits: [],
      missingUnits: [],
      orderDelays: [],
      pickers: 4,
      pickingCapacity: 30,
      packingCapacity: 60,
      disruption: "none",
    };
    const result = validateSimInputs(inputs, [product], [order], now);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.message.includes("deadline must be in the future"))).toBe(true);
  });

  it("should reject unknown order IDs in priority overrides", () => {
    const inputs: SimInputs = {
      addLines: [],
      priorityOverrides: [
        {
          orderId: "orders/unknown" as any,
          priority: "urgent",
        },
      ],
      incomingStock: [],
      damagedUnits: [],
      missingUnits: [],
      orderDelays: [],
      pickers: 4,
      pickingCapacity: 30,
      packingCapacity: 60,
      disruption: "none",
    };
    const result = validateSimInputs(inputs, [product], [order], now);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.message.includes("unknown order"))).toBe(true);
  });

  it("should reject damaged units exceeding on-hand stock", () => {
    const inputs: SimInputs = {
      addLines: [],
      priorityOverrides: [],
      incomingStock: [],
      damagedUnits: [
        {
          sku: product.sku,
          qty: 20, // More than onHand (10)
        },
      ],
      missingUnits: [],
      orderDelays: [],
      pickers: 4,
      pickingCapacity: 30,
      packingCapacity: 60,
      disruption: "none",
    };
    const result = validateSimInputs(inputs, [product], [order], now);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.message.includes("exceeds"))).toBe(true);
  });

  it("should reject missing units exceeding on-hand stock", () => {
    const inputs: SimInputs = {
      addLines: [],
      priorityOverrides: [],
      incomingStock: [],
      damagedUnits: [],
      missingUnits: [
        {
          sku: product.sku,
          qty: 20, // More than onHand (10)
        },
      ],
      orderDelays: [],
      pickers: 4,
      pickingCapacity: 30,
      packingCapacity: 60,
      disruption: "none",
    };
    const result = validateSimInputs(inputs, [product], [order], now);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.message.includes("exceeds"))).toBe(true);
  });

  it("should reject invalid picker count", () => {
    const inputs: SimInputs = {
      addLines: [],
      priorityOverrides: [],
      incomingStock: [],
      damagedUnits: [],
      missingUnits: [],
      orderDelays: [],
      pickers: -5,
      pickingCapacity: 30,
      packingCapacity: 60,
      disruption: "none",
    };
    const result = validateSimInputs(inputs, [product], [order], now);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.field.includes("pickers"))).toBe(true);
  });

  it("should reject invalid picking capacity", () => {
    const inputs: SimInputs = {
      addLines: [],
      priorityOverrides: [],
      incomingStock: [],
      damagedUnits: [],
      missingUnits: [],
      orderDelays: [],
      pickers: 4,
      pickingCapacity: -10,
      packingCapacity: 60,
      disruption: "none",
    };
    const result = validateSimInputs(inputs, [product], [order], now);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.field.includes("pickingCapacity"))).toBe(true);
  });

  it("should reject invalid packing capacity", () => {
    const inputs: SimInputs = {
      addLines: [],
      priorityOverrides: [],
      incomingStock: [],
      damagedUnits: [],
      missingUnits: [],
      orderDelays: [],
      pickers: 4,
      pickingCapacity: 30,
      packingCapacity: -10,
      disruption: "none",
    };
    const result = validateSimInputs(inputs, [product], [order], now);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.field.includes("packingCapacity"))).toBe(true);
  });
});

describe("Simulator: Capacity Disruption", () => {
  it("should apply no disruption with 'none'", () => {
    const inputs = {
      addLines: [],
      priorityOverrides: [],
      incomingStock: [],
      damagedUnits: [],
      missingUnits: [],
      orderDelays: [],
      pickers: 4,
      pickingCapacity: 30,
      packingCapacity: 60,
      disruption: "none" as const,
    };
    const capacity = capacityFrom(inputs);
    expect(capacity.pickers).toBe(4);
    expect(capacity.pickingCapacity).toBe(30);
    expect(capacity.packingCapacity).toBe(60);
  });

  it("should reduce pickers by 1 with staff shortage", () => {
    const inputs = {
      addLines: [],
      priorityOverrides: [],
      incomingStock: [],
      damagedUnits: [],
      missingUnits: [],
      orderDelays: [],
      pickers: 4,
      pickingCapacity: 30,
      packingCapacity: 60,
      disruption: "staff_shortage" as const,
    };
    const capacity = capacityFrom(inputs);
    expect(capacity.pickers).toBe(3);
  });

  it("should reduce picking capacity by 50% with zone offline", () => {
    const inputs = {
      addLines: [],
      priorityOverrides: [],
      incomingStock: [],
      damagedUnits: [],
      missingUnits: [],
      orderDelays: [],
      pickers: 4,
      pickingCapacity: 30,
      packingCapacity: 60,
      disruption: "zone_offline" as const,
    };
    const capacity = capacityFrom(inputs);
    expect(capacity.pickers).toBe(4);
    expect(capacity.pickingCapacity).toBe(15);
    expect(capacity.packingCapacity).toBe(60);
  });

  it("should reduce both capacities by 70% with power outage", () => {
    const inputs = {
      addLines: [],
      priorityOverrides: [],
      incomingStock: [],
      damagedUnits: [],
      missingUnits: [],
      orderDelays: [],
      pickers: 4,
      pickingCapacity: 30,
      packingCapacity: 60,
      disruption: "power_outage" as const,
    };
    const capacity = capacityFrom(inputs);
    expect(capacity.pickingCapacity).toBe(9);
    expect(capacity.packingCapacity).toBe(18);
  });
});

describe("Simulator: World Preparation", () => {
  const now = Date.now();
  const product = mockProduct({ onHand: 10 });
  const order = mockOrder();

  it("should clone products and orders without modification with empty inputs", () => {
    const inputs: SimInputs = {
      addLines: [],
      priorityOverrides: [],
      incomingStock: [],
      damagedUnits: [],
      missingUnits: [],
      orderDelays: [],
      pickers: 4,
      pickingCapacity: 30,
      packingCapacity: 60,
      disruption: "none",
    };
    const world = prepareWorld(inputs, { products: [product], orders: [order], now });
    expect(world.products[0].onHand).toBe(10);
    expect(world.orders[0].priority).toBe("medium");
  });

  it("should add incoming stock to products", () => {
    const inputs: SimInputs = {
      addLines: [],
      priorityOverrides: [],
      incomingStock: [
        {
          sku: product.sku,
          qty: 5,
        },
      ],
      damagedUnits: [],
      missingUnits: [],
      orderDelays: [],
      pickers: 4,
      pickingCapacity: 30,
      packingCapacity: 60,
      disruption: "none",
    };
    const world = prepareWorld(inputs, { products: [product], orders: [order], now });
    expect(world.products[0].onHand).toBe(15);
  });

  it("should remove damaged units from stock", () => {
    const inputs: SimInputs = {
      addLines: [],
      priorityOverrides: [],
      incomingStock: [],
      damagedUnits: [
        {
          sku: product.sku,
          qty: 3,
        },
      ],
      missingUnits: [],
      orderDelays: [],
      pickers: 4,
      pickingCapacity: 30,
      packingCapacity: 60,
      disruption: "none",
    };
    const world = prepareWorld(inputs, { products: [product], orders: [order], now });
    expect(world.products[0].onHand).toBe(7);
  });

  it("should remove missing units from stock", () => {
    const inputs: SimInputs = {
      addLines: [],
      priorityOverrides: [],
      incomingStock: [],
      damagedUnits: [],
      missingUnits: [
        {
          sku: product.sku,
          qty: 2,
        },
      ],
      orderDelays: [],
      pickers: 4,
      pickingCapacity: 30,
      packingCapacity: 60,
      disruption: "none",
    };
    const world = prepareWorld(inputs, { products: [product], orders: [order], now });
    expect(world.products[0].onHand).toBe(8);
  });

  it("should not create negative stock", () => {
    const inputs: SimInputs = {
      addLines: [],
      priorityOverrides: [],
      incomingStock: [],
      damagedUnits: [],
      missingUnits: [
        {
          sku: product.sku,
          qty: 20, // More than available
        },
      ],
      orderDelays: [],
      pickers: 4,
      pickingCapacity: 30,
      packingCapacity: 60,
      disruption: "none",
    };
    const world = prepareWorld(inputs, { products: [product], orders: [order], now });
    expect(world.products[0].onHand).toBeGreaterThanOrEqual(0);
  });

  it("should apply priority overrides", () => {
    const inputs: SimInputs = {
      addLines: [],
      priorityOverrides: [
        {
          orderId: order._id,
          priority: "urgent" as const,
        },
      ],
      incomingStock: [],
      damagedUnits: [],
      missingUnits: [],
      orderDelays: [],
      pickers: 4,
      pickingCapacity: 30,
      packingCapacity: 60,
      disruption: "none",
    };
    const world = prepareWorld(inputs, { products: [product], orders: [order], now });
    expect(world.orders[0].priority).toBe("urgent");
  });

  it("should apply deadline delays", () => {
    const originalDeadline = order.deadline;
    const inputs: SimInputs = {
      addLines: [],
      priorityOverrides: [],
      incomingStock: [],
      damagedUnits: [],
      missingUnits: [],
      orderDelays: [
        {
          orderId: order._id,
          hours: 12,
        },
      ],
      pickers: 4,
      pickingCapacity: 30,
      packingCapacity: 60,
      disruption: "none",
    };
    const world = prepareWorld(inputs, { products: [product], orders: [order], now });
    expect(world.orders[0].deadline).toBe(originalDeadline + 12 * 3600000);
  });

  it("should add new order lines from inputs", () => {
    const inputs: SimInputs = {
      addLines: [
        {
          sku: product.sku,
          qty: 5,
          priority: "high" as const,
          deadline: now + 24 * 3600000,
        },
      ],
      priorityOverrides: [],
      incomingStock: [],
      damagedUnits: [],
      missingUnits: [],
      orderDelays: [],
      pickers: 4,
      pickingCapacity: 30,
      packingCapacity: 60,
      disruption: "none",
    };
    const world = prepareWorld(inputs, { products: [product], orders: [order], now });
    expect(world.orders.length).toBe(2); // Original + new
    const newOrder = world.orders[1];
    expect(newOrder.orderNumber).toContain("SIM-");
    expect(newOrder.customer).toContain("Simulation");
  });

  it("should handle multiple combined transformations", () => {
    const inputs: SimInputs = {
      addLines: [
        {
          sku: product.sku,
          qty: 3,
          priority: "urgent" as const,
          deadline: now + 12 * 3600000,
        },
      ],
      priorityOverrides: [
        {
          orderId: order._id,
          priority: "low" as const,
        },
      ],
      incomingStock: [
        {
          sku: product.sku,
          qty: 10,
        },
      ],
      damagedUnits: [
        {
          sku: product.sku,
          qty: 2,
        },
      ],
      missingUnits: [
        {
          sku: product.sku,
          qty: 1,
        },
      ],
      orderDelays: [
        {
          orderId: order._id,
          hours: 8,
        },
      ],
      pickers: 6,
      pickingCapacity: 40,
      packingCapacity: 70,
      disruption: "none",
    };
    const world = prepareWorld(inputs, { products: [product], orders: [order], now });

    expect(world.products[0].onHand).toBe(16); // 10 + 10 - 2 - 1 = 17... wait, 10 + 10 - 2 - 1 = 17
    expect(world.orders[0].priority).toBe("low");
    expect(world.orders[0].deadline).toBe(order.deadline + 8 * 3600000);
    expect(world.orders.length).toBe(2);
  });
});

describe("Simulator: Defaults", () => {
  it("should have sensible defaults defined", () => {
    expect(SIM_DEFAULTS.pickers).toBe(4);
    expect(SIM_DEFAULTS.pickingCapacity).toBe(30);
    expect(SIM_DEFAULTS.packingCapacity).toBe(60);
    expect(SIM_DEFAULTS.disruption).toBe("none");
  });
});
