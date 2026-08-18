import { describe, it, expect } from "vitest";
import {
  scoreOrder,
  computeReserved,
  availabilityFor,
  openDemand,
  orderRevenue,
} from "./domain";
import { runAllocationWave, runFairAllocation, runFifoAllocation } from "./allocation";
import type { OrderState, ProductState } from "./domain";

// ============================================================================
// INTEGRATION TESTS - Complex Warehouse Scenarios
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

describe("Integration: Complex Warehouse Scenarios", () => {
  const now = Date.now();

  describe("Scenario 1: Critical Order vs. High Demand", () => {
    it("should prioritize critical order with limited stock", () => {
      const product = mockProduct({ onHand: 7, sku: "SKU-001", _id: "products/p1" as any });

      const criticalOrder = mockOrder({
        _id: "orders/critical" as any,
        orderNumber: "ORD-CRIT-001",
        priority: "urgent" as const,
        customer: "VIP Customer",
        deadline: now + 2 * 3600000, // 2 hours
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

      const normalOrder = mockOrder({
        _id: "orders/normal" as any,
        orderNumber: "ORD-NORMAL-001",
        priority: "low" as const,
        customer: "Regular Customer",
        deadline: now + 72 * 3600000,
        items: [
          {
            productId: product._id,
            sku: product.sku,
            name: product.name,
            qty: 5,
            allocated: 0,
            picked: 0,
            packed: 0,
            price: 50,
          },
        ],
      });

      const result = runAllocationWave([product], [criticalOrder, normalOrder], now);

      // Critical order should get more than normal order
      const criticalAllocated = result.orders[0].items[0].allocated;
      const normalAllocated = result.orders[1].items[0].allocated;

      expect(criticalAllocated).toBeGreaterThan(normalAllocated);
      expect(criticalAllocated + normalAllocated).toBeLessThanOrEqual(7);
    });
  });

  describe("Scenario 2: Zero Inventory Handling", () => {
    it("should not allow allocation when stock is zero", () => {
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
      expect(result.orders[0].status).toBe("review"); // Partial/blocked
      expect(result.stats.blocked).toBeGreaterThan(0);
    });
  });

  describe("Scenario 3: Damaged/Missing Inventory Impact", () => {
    it("should account for usable inventory after removing damaged units", () => {
      // Physical inventory: 10 units
      // Damaged: 3 units
      // Missing: 2 units
      // Usable: 5 units
      const product = mockProduct({
        onHand: 10,
        _id: "products/p1" as any,
        sku: "SKU-001",
      });

      const order1 = mockOrder({
        _id: "orders/o1" as any,
        orderNumber: "ORD-001",
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

      // Simulate damaged and missing by reducing onHand
      const damagedProduct = {
        ...product,
        onHand: 10 - 3 - 2, // Simulate after damage/missing
      };

      const result = runAllocationWave([damagedProduct], [order1], now);

      // Should only allocate 5 from 5 usable
      expect(result.orders[0].items[0].allocated).toBe(5);
    });
  });

  describe("Scenario 4: Partial Fulfillment with Multiple Demands", () => {
    it("should partially fulfill multiple orders with limited stock", () => {
      const product = mockProduct({ onHand: 7 });

      const order1 = mockOrder({
        _id: "orders/o1" as any,
        orderNumber: "ORD-001",
        priority: "high" as const,
        items: [
          {
            productId: product._id,
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

      const order2 = mockOrder({
        _id: "orders/o2" as any,
        orderNumber: "ORD-002",
        priority: "medium" as const,
        items: [
          {
            productId: product._id,
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

      const result = runAllocationWave([product], [order1, order2], now);

      // Both should be in review status
      expect(result.orders[0].status).toBe("allocated");
      expect(result.orders[1].status).toBe("review"); // Partial

      // Total allocated should not exceed 7
      const total = result.orders[0].items[0].allocated + result.orders[1].items[0].allocated;
      expect(total).toBe(7);
    });
  });

  describe("Scenario 5: Reserved Stock From Holding Orders", () => {
    it("should prevent over-allocation by respecting reserved stock", () => {
      const product = mockProduct({ onHand: 10 });

      // Order 1: Already allocated and in picking (reserves 8 units)
      const order1 = mockOrder({
        _id: "orders/o1" as any,
        status: "picking" as const,
        items: [
          {
            productId: product._id,
            sku: product.sku,
            name: product.name,
            qty: 10,
            allocated: 8,
            picked: 2, // 2 picked, 6 still reserved
            packed: 0,
            price: 100,
          },
        ],
      });

      // Order 2: Pending (should only get remaining available)
      const order2 = mockOrder({
        _id: "orders/o2" as any,
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

      const result = runAllocationWave([product], [order1, order2], now);

      // Order 2 should get at most 4 units (10 - (8-2) reserved)
      expect(result.orders[1].items[0].allocated).toBeLessThanOrEqual(4);

      // Verify the availability calculation
      const reserved = computeReserved(product._id, result.orders);
      expect(reserved).toBeLessThanOrEqual(product.onHand);
    });
  });

  describe("Scenario 6: Allocation Strategy Comparison", () => {
    it("should show different outcomes for different strategies", () => {
      const product = mockProduct({ onHand: 10 });

      // Older order with normal priority
      const olderOrder = mockOrder({
        _id: "orders/older" as any,
        orderNumber: "ORD-OLDER",
        priority: "low" as const,
        createdAt: now - 10000,
        items: [
          {
            productId: product._id,
            sku: product.sku,
            name: product.name,
            qty: 8,
            allocated: 0,
            picked: 0,
            packed: 0,
            price: 100,
          },
        ],
      });

      // Newer order with urgent priority
      const newerOrder = mockOrder({
        _id: "orders/newer" as any,
        orderNumber: "ORD-NEWER",
        priority: "urgent" as const,
        createdAt: now,
        items: [
          {
            productId: product._id,
            sku: product.sku,
            name: product.name,
            qty: 8,
            allocated: 0,
            picked: 0,
            packed: 0,
            price: 100,
          },
        ],
      });

      // Score-based: Urgent new order wins
      const scoreResult = runAllocationWave([product], [olderOrder, newerOrder], now);
      const scoreNewerAllocated = scoreResult.orders[1].items[0].allocated;

      // FIFO: Older order wins
      const fifoResult = runFifoAllocation([product], [olderOrder, newerOrder], now);
      const fifoOlderAllocated = fifoResult.orders[0].items[0].allocated;

      // Fair: Both get equal shares
      const fairResult = runFairAllocation([product], [olderOrder, newerOrder], now);
      const fairOlderAllocated = fairResult.orders[0].items[0].allocated;
      const fairNewerAllocated = fairResult.orders[1].items[0].allocated;

      // Score-based should favor newer urgent order
      expect(scoreNewerAllocated).toBeGreaterThan(0);

      // FIFO should favor older order
      expect(fifoOlderAllocated).toBeGreaterThanOrEqual(fifoResult.orders[1].items[0].allocated);

      // Fair should split roughly equally
      expect(Math.abs(fairOlderAllocated - fairNewerAllocated)).toBeLessThanOrEqual(2);
    });
  });

  describe("Scenario 7: Multi-Product Order", () => {
    it("should handle orders requiring multiple products", () => {
      const product1 = mockProduct({
        _id: "products/p1" as any,
        sku: "SKU-001",
        name: "Product 1",
        onHand: 5,
      });
      const product2 = mockProduct({
        _id: "products/p2" as any,
        sku: "SKU-002",
        name: "Product 2",
        onHand: 3,
      });

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

      // Both items should be fully allocated
      expect(result.orders[0].items[0].allocated).toBe(5);
      expect(result.orders[0].items[1].allocated).toBe(3);
      expect(result.orders[0].status).toBe("allocated");
    });
  });

  describe("Scenario 8: Availability Visibility", () => {
    it("should correctly show availability snapshot", () => {
      const product = mockProduct({ onHand: 20 });
      const order1 = mockOrder({
        _id: "orders/o1" as any,
        status: "allocated" as const,
        items: [
          {
            productId: product._id,
            sku: product.sku,
            name: product.name,
            qty: 10,
            allocated: 10,
            picked: 0,
            packed: 0,
            price: 100,
          },
        ],
      });

      const order2 = mockOrder({
        _id: "orders/o2" as any,
        status: "picking" as const,
        items: [
          {
            productId: product._id,
            sku: product.sku,
            name: product.name,
            qty: 5,
            allocated: 5,
            picked: 2,
            packed: 0,
            price: 100,
          },
        ],
      });

      const availability = availabilityFor(product, [order1, order2]);

      expect(availability.onHand).toBe(20);
      expect(availability.reserved).toBe(13); // 10 + (5 - 2)
      expect(availability.available).toBe(7); // 20 - 13
    });
  });

  describe("Scenario 9: Open Demand Calculation", () => {
    it("should calculate total unmet demand across all orders", () => {
      const product = mockProduct({
        _id: "products/p1" as any,
        sku: "SKU-001",
      });

      const order1 = mockOrder({
        _id: "orders/o1" as any,
        items: [
          {
            productId: product._id,
            sku: product.sku,
            name: product.name,
            qty: 10,
            allocated: 3,
            picked: 0,
            packed: 0,
            price: 100,
          },
        ],
      });

      const order2 = mockOrder({
        _id: "orders/o2" as any,
        items: [
          {
            productId: product._id,
            sku: product.sku,
            name: product.name,
            qty: 5,
            allocated: 2,
            picked: 0,
            packed: 0,
            price: 100,
          },
        ],
      });

      const demand = openDemand(product._id, [order1, order2]);

      // (10 - 3) + (5 - 2) = 10
      expect(demand).toBe(10);
    });
  });

  describe("Scenario 10: Revenue-Based Scoring", () => {
    it("should factor order revenue into scoring", () => {
      const highValueOrder = mockOrder({
        items: [
          {
            productId: "products/p1" as any,
            sku: "SKU-001",
            name: "Product",
            qty: 1,
            allocated: 0,
            picked: 0,
            packed: 0,
            price: 5000, // High value
          },
        ],
      });

      const lowValueOrder = mockOrder({
        _id: "orders/low" as any,
        items: [
          {
            productId: "products/p1" as any,
            sku: "SKU-001",
            name: "Product",
            qty: 1,
            allocated: 0,
            picked: 0,
            packed: 0,
            price: 50, // Low value
          },
        ],
      });

      const highScore = scoreOrder(highValueOrder, now);
      const lowScore = scoreOrder(lowValueOrder, now);

      // High value order should score higher due to profit bonus
      expect(highScore).toBeGreaterThan(lowScore);
    });
  });
});
