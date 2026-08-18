import { describe, it, expect } from "vitest";
import {
  runAllocationWave,
  runFifoAllocation,
  runFairAllocation,
  runAllocationWaveWith,
  scoreOrder,
} from "./allocation";
import type { OrderState, ProductState } from "./domain";
import { computeReserved, HOLDING_STATUSES } from "./domain";

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
// ALLOCATION TESTS
// ============================================================================

describe("Allocation: Basic Wave Execution", () => {
  const now = Date.now();

  it("should allocate pending orders with available stock", () => {
    const product = mockProduct({ onHand: 10 });
    const order = mockOrder({
      items: [
        {
          productId: product._id,
          sku: product.sku,
          name: product.name,
          qty: 5,
          allocated: 0,
          picked: 0,
          packed: 0,
          price: 100,
        },
      ],
    });
    const result = runAllocationWave([product], [order], now);

    expect(result.orders[0].items[0].allocated).toBe(5);
    expect(result.orders[0].status).toBe("allocated");
    expect(result.stats.fullyAllocated).toBe(1);
  });

  it("should partially allocate when stock is insufficient", () => {
    const product = mockProduct({ onHand: 3 });
    const order = mockOrder({
      items: [
        {
          productId: product._id,
          sku: product.sku,
          name: product.name,
          qty: 5,
          allocated: 0,
          picked: 0,
          packed: 0,
          price: 100,
        },
      ],
    });
    const result = runAllocationWave([product], [order], now);

    expect(result.orders[0].items[0].allocated).toBe(3);
    expect(result.orders[0].status).toBe("review");
    expect(result.stats.partial).toBe(1);
  });

  it("should not allocate when stock is zero", () => {
    const product = mockProduct({ onHand: 0 });
    const order = mockOrder({
      items: [
        {
          productId: product._id,
          sku: product.sku,
          name: product.name,
          qty: 5,
          allocated: 0,
          picked: 0,
          packed: 0,
          price: 100,
        },
      ],
    });
    const result = runAllocationWave([product], [order], now);

    expect(result.orders[0].items[0].allocated).toBe(0);
    expect(result.orders[0].status).toBe("review");
    expect(result.stats.blocked).toBe(1);
  });

  it("should prioritize higher-urgency orders", () => {
    const product = mockProduct({ onHand: 5 });
    const now = Date.now();

    const urgentOrder = mockOrder({
      priority: "urgent" as const,
      items: [
        {
          productId: product._id,
          sku: product.sku,
          name: product.name,
          qty: 5,
          allocated: 0,
          picked: 0,
          packed: 0,
          price: 100,
        },
      ],
    });

    const lowOrder = mockOrder({
      priority: "low" as const,
      _id: "orders/low" as any,
      orderNumber: "ORD-002",
      items: [
        {
          productId: product._id,
          sku: product.sku,
          name: product.name,
          qty: 5,
          allocated: 0,
          picked: 0,
          packed: 0,
          price: 100,
        },
      ],
    });

    const result = runAllocationWave([product], [urgentOrder, lowOrder], now);

    // Urgent order should be allocated first
    const urgentOrderResult = result.orders.find((o) => o.priority === "urgent");
    const lowOrderResult = result.orders.find((o) => o.priority === "low");

    expect(urgentOrderResult?.items[0].allocated).toBeGreater(
      lowOrderResult?.items[0].allocated || 0,
    );
  });

  it("should handle multiple items in a single order", () => {
    const product1 = mockProduct({ onHand: 5, sku: "SKU-001", _id: "products/p1" as any });
    const product2 = mockProduct({ onHand: 3, sku: "SKU-002", _id: "products/p2" as any });

    const order = mockOrder({
      items: [
        {
          productId: product1._id,
          sku: product1.sku,
          name: product1.name,
          qty: 5,
          allocated: 0,
          picked: 0,
          packed: 0,
          price: 100,
        },
        {
          productId: product2._id,
          sku: product2.sku,
          name: product2.name,
          qty: 3,
          allocated: 0,
          picked: 0,
          packed: 0,
          price: 50,
        },
      ],
    });

    const result = runAllocationWave([product1, product2], [order], now);

    expect(result.orders[0].items[0].allocated).toBe(5);
    expect(result.orders[0].items[1].allocated).toBe(3);
    expect(result.orders[0].status).toBe("allocated");
  });

  it("should not allocate review orders twice", () => {
    const product = mockProduct({ onHand: 10 });
    const order = mockOrder({
      status: "review" as const,
      items: [
        {
          productId: product._id,
          sku: product.sku,
          name: product.name,
          qty: 5,
          allocated: 2, // Already partially allocated
          picked: 0,
          packed: 0,
          price: 100,
        },
      ],
    });

    const result = runAllocationWave([product], [order], now);

    // Should try to allocate the remaining 3 units
    expect(result.orders[0].items[0].allocated).toBeGreaterThanOrEqual(2);
  });
});

describe("Allocation: Reserved Stock Logic", () => {
  const now = Date.now();

  it("should not over-allocate by accounting for reserved stock", () => {
    const product = mockProduct({ onHand: 10 });
    const productId = product._id;

    // First order already allocated and holding
    const order1 = mockOrder({
      status: "allocated" as const,
      items: [
        {
          productId,
          sku: product.sku,
          name: product.name,
          qty: 8,
          allocated: 8,
          picked: 0,
          packed: 0,
          price: 100,
        },
      ],
    });

    // Second order pending - only 2 units available
    const order2 = mockOrder({
      status: "pending" as const,
      _id: "orders/order2" as any,
      orderNumber: "ORD-002",
      items: [
        {
          productId,
          sku: product.sku,
          name: product.name,
          qty: 5,
          allocated: 0,
          picked: 0,
          packed: 0,
          price: 100,
        },
      ],
    });

    const result = runAllocationWave([product], [order1, order2], now);

    // Order 2 should only get 2 units
    const order2Result = result.orders.find((o) => o.orderNumber === "ORD-002");
    expect(order2Result?.items[0].allocated).toBe(2);

    // Total allocated should not exceed onHand
    const reserved = computeReserved(productId, result.orders);
    expect(reserved).toBeLessThanOrEqual(product.onHand);
  });

  it("should account for picked units when calculating available stock", () => {
    const product = mockProduct({ onHand: 10 });
    const productId = product._id;

    // Order already in picking - partial picked
    const order1 = mockOrder({
      status: "picking" as const,
      items: [
        {
          productId,
          sku: product.sku,
          name: product.name,
          qty: 8,
          allocated: 8,
          picked: 5, // 5 already picked
          packed: 0,
          price: 100,
        },
      ],
    });

    // Pending order - should get remaining
    const order2 = mockOrder({
      status: "pending" as const,
      _id: "orders/order2" as any,
      orderNumber: "ORD-002",
      items: [
        {
          productId,
          sku: product.sku,
          name: product.name,
          qty: 5,
          allocated: 0,
          picked: 0,
          packed: 0,
          price: 100,
        },
      ],
    });

    const result = runAllocationWave([product], [order1, order2], now);

    // Order 2 should get up to 7 units (10 - (8-5) reserved)
    const order2Result = result.orders.find((o) => o.orderNumber === "ORD-002");
    expect(order2Result?.items[0].allocated).toBeLessThanOrEqual(7);
  });

  it("should not count picked/packed items toward holding", () => {
    const product = mockProduct({ onHand: 10 });
    const productId = product._id;

    // Fulfilled order - should not reserve
    const fulfillledOrder = mockOrder({
      status: "fulfilled" as const,
      items: [
        {
          productId,
          sku: product.sku,
          name: product.name,
          qty: 5,
          allocated: 5,
          picked: 5,
          packed: 5,
          price: 100,
        },
      ],
    });

    // Pending order - should get full stock
    const pendingOrder = mockOrder({
      status: "pending" as const,
      _id: "orders/order2" as any,
      orderNumber: "ORD-002",
      items: [
        {
          productId,
          sku: product.sku,
          name: product.name,
          qty: 10,
          allocated: 0,
          picked: 0,
          packed: 0,
          price: 100,
        },
      ],
    });

    const result = runAllocationWave([product], [fulfillledOrder, pendingOrder], now);

    const pendingResult = result.orders.find((o) => o.orderNumber === "ORD-002");
    expect(pendingResult?.items[0].allocated).toBe(10);
  });
});

describe("Allocation: FIFO Strategy", () => {
  const now = Date.now();

  it("should allocate orders in FIFO order ignoring priority", () => {
    const product = mockProduct({ onHand: 10 });
    const productId = product._id;

    // Low priority but created first
    const firstOrder = mockOrder({
      priority: "low" as const,
      createdAt: now - 1000,
      items: [
        {
          productId,
          sku: product.sku,
          name: product.name,
          qty: 6,
          allocated: 0,
          picked: 0,
          packed: 0,
          price: 100,
        },
      ],
    });

    // Urgent but created later
    const secondOrder = mockOrder({
      priority: "urgent" as const,
      _id: "orders/order2" as any,
      orderNumber: "ORD-002",
      createdAt: now,
      items: [
        {
          productId,
          sku: product.sku,
          name: product.name,
          qty: 6,
          allocated: 0,
          picked: 0,
          packed: 0,
          price: 100,
        },
      ],
    });

    const result = runFifoAllocation([product], [firstOrder, secondOrder], now);

    // First order should get 6, second order should get 4
    expect(result.orders[0].items[0].allocated).toBe(6);
    expect(result.orders[1].items[0].allocated).toBe(4);
  });
});

describe("Allocation: Fair Allocation Strategy", () => {
  const now = Date.now();

  it("should distribute stock proportionally across orders", () => {
    const product = mockProduct({ onHand: 10 });
    const productId = product._id;

    const order1 = mockOrder({
      createdAt: now - 1000,
      items: [
        {
          productId,
          sku: product.sku,
          name: product.name,
          qty: 10,
          allocated: 0,
          picked: 0,
          packed: 0,
          price: 100,
        },
      ],
    });

    const order2 = mockOrder({
      _id: "orders/order2" as any,
      orderNumber: "ORD-002",
      createdAt: now - 500,
      items: [
        {
          productId,
          sku: product.sku,
          name: product.name,
          qty: 10,
          allocated: 0,
          picked: 0,
          packed: 0,
          price: 100,
        },
      ],
    });

    const result = runFairAllocation([product], [order1, order2], now);

    // Both orders should get 5 units (equal split)
    expect(result.orders[0].items[0].allocated).toBe(5);
    expect(result.orders[1].items[0].allocated).toBe(5);
  });

  it("should fully satisfy if sufficient stock", () => {
    const product = mockProduct({ onHand: 20 });
    const productId = product._id;

    const order1 = mockOrder({
      items: [
        {
          productId,
          sku: product.sku,
          name: product.name,
          qty: 10,
          allocated: 0,
          picked: 0,
          packed: 0,
          price: 100,
        },
      ],
    });

    const order2 = mockOrder({
      _id: "orders/order2" as any,
      orderNumber: "ORD-002",
      items: [
        {
          productId,
          sku: product.sku,
          name: product.name,
          qty: 10,
          allocated: 0,
          picked: 0,
          packed: 0,
          price: 100,
        },
      ],
    });

    const result = runFairAllocation([product], [order1, order2], now);

    expect(result.orders[0].items[0].allocated).toBe(10);
    expect(result.orders[1].items[0].allocated).toBe(10);
  });
});

describe("Allocation: Strategy Comparison", () => {
  const now = Date.now();

  it("should allow score-based strategy", () => {
    const product = mockProduct({ onHand: 10 });
    const order = mockOrder({
      items: [
        {
          productId: product._id,
          sku: product.sku,
          name: product.name,
          qty: 5,
          allocated: 0,
          picked: 0,
          packed: 0,
          price: 100,
        },
      ],
    });

    const result = runAllocationWaveWith([product], [order], now, "score");
    expect(result.orders[0].items[0].allocated).toBeGreaterThan(0);
  });

  it("should allow priority-based strategy", () => {
    const product = mockProduct({ onHand: 10 });
    const order = mockOrder({
      items: [
        {
          productId: product._id,
          sku: product.sku,
          name: product.name,
          qty: 5,
          allocated: 0,
          picked: 0,
          packed: 0,
          price: 100,
        },
      ],
    });

    const result = runAllocationWaveWith([product], [order], now, "priority");
    expect(result.orders[0].items[0].allocated).toBeGreaterThan(0);
  });

  it("should allow deadline-based strategy", () => {
    const product = mockProduct({ onHand: 10 });
    const order = mockOrder({
      items: [
        {
          productId: product._id,
          sku: product.sku,
          name: product.name,
          qty: 5,
          allocated: 0,
          picked: 0,
          packed: 0,
          price: 100,
        },
      ],
    });

    const result = runAllocationWaveWith([product], [order], now, "deadline");
    expect(result.orders[0].items[0].allocated).toBeGreaterThan(0);
  });
});

describe("Allocation: Edge Cases", () => {
  const now = Date.now();

  it("should handle empty product list", () => {
    const order = mockOrder();
    const result = runAllocationWave([], [order], now);
    expect(result.orders[0].items[0].allocated).toBe(0);
  });

  it("should handle empty order list", () => {
    const product = mockProduct({ onHand: 10 });
    const result = runAllocationWave([product], [], now);
    expect(result.stats.processed).toBe(0);
  });

  it("should handle zero quantity items", () => {
    const product = mockProduct({ onHand: 10 });
    const order = mockOrder({
      items: [
        {
          productId: product._id,
          sku: product.sku,
          name: product.name,
          qty: 0,
          allocated: 0,
          picked: 0,
          packed: 0,
          price: 100,
        },
      ],
    });
    const result = runAllocationWave([product], [order], now);
    expect(result.orders[0].items[0].allocated).toBe(0);
  });

  it("should never create negative allocated quantities", () => {
    const product = mockProduct({ onHand: 5 });
    const order = mockOrder({
      items: [
        {
          productId: product._id,
          sku: product.sku,
          name: product.name,
          qty: 10,
          allocated: 0,
          picked: 0,
          packed: 0,
          price: 100,
        },
      ],
    });
    const result = runAllocationWave([product], [order], now);
    expect(result.orders[0].items[0].allocated).toBeGreaterThanOrEqual(0);
    expect(result.orders[0].items[0].allocated).toBeLessThanOrEqual(product.onHand);
  });

  it("should never allocate more than requested", () => {
    const product = mockProduct({ onHand: 100 });
    const order = mockOrder({
      items: [
        {
          productId: product._id,
          sku: product.sku,
          name: product.name,
          qty: 5,
          allocated: 0,
          picked: 0,
          packed: 0,
          price: 100,
        },
      ],
    });
    const result = runAllocationWave([product], [order], now);
    expect(result.orders[0].items[0].allocated).toBeLessThanOrEqual(5);
  });

  it("should never allocate more than available", () => {
    const product = mockProduct({ onHand: 3 });
    const order = mockOrder({
      items: [
        {
          productId: product._id,
          sku: product.sku,
          name: product.name,
          qty: 10,
          allocated: 0,
          picked: 0,
          packed: 0,
          price: 100,
        },
      ],
    });
    const result = runAllocationWave([product], [order], now);
    expect(result.orders[0].items[0].allocated).toBeLessThanOrEqual(3);
  });
});

describe("Allocation: Multi-Order Scenarios", () => {
  const now = Date.now();

  it("should handle high demand with limited stock", () => {
    const product = mockProduct({ onHand: 7 });
    const productId = product._id;

    const criticalOrder = mockOrder({
      priority: "urgent" as const,
      items: [
        {
          productId,
          sku: product.sku,
          name: product.name,
          qty: 10,
          allocated: 0,
          picked: 0,
          packed: 0,
          price: 100,
        },
      ],
    });

    const normalOrder = mockOrder({
      priority: "normal" as const,
      _id: "orders/order2" as any,
      orderNumber: "ORD-002",
      items: [
        {
          productId,
          sku: product.sku,
          name: product.name,
          qty: 5,
          allocated: 0,
          picked: 0,
          packed: 0,
          price: 100,
        },
      ],
    });

    const result = runAllocationWave([product], [criticalOrder, normalOrder], now);

    // Urgent order should get priority
    expect(result.orders[0].items[0].allocated).toBeGreater(0);
    // Both should not exceed available stock
    const totalAllocated =
      result.orders[0].items[0].allocated + result.orders[1].items[0].allocated;
    expect(totalAllocated).toBeLessThanOrEqual(7);
  });
});
