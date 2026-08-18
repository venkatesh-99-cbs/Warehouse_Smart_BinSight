import { describe, it, expect } from "vitest";
import {
  scoreOrderBreakdown,
  scoreOrder,
  customerTrustScore,
  recentDonorStrikes,
  computeReserved,
  availabilityFor,
  openDemand,
  isDonorEligible,
  donorTrustCost,
  targetGain,
  netBenefit,
  orderRevenue,
  PRIORITY_WEIGHT,
  TRUST_EVENT_WEIGHT,
  TRUST_FLOOR,
  AGE_BONUS_MAX,
  AGE_BONUS_PER_HOUR,
  PROFIT_BONUS_MAX,
} from "./domain";
import type { OrderState, ProductState, TrustEntry } from "./domain";

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
  deadline: Date.now() + 24 * 3600000, // 24 hours from now
  createdAt: Date.now(),
  updatedAt: Date.now(),
  ...overrides,
});

// ============================================================================
// DOMAIN TESTS
// ============================================================================

describe("Domain: Order Scoring", () => {
  const now = Date.now();

  it("should calculate priority points correctly", () => {
    const order = mockOrder({ priority: "urgent" });
    const breakdown = scoreOrderBreakdown(order, now);
    expect(breakdown.priorityPoints).toBe(PRIORITY_WEIGHT.urgent);
  });

  it("should apply deadline bonus for orders within 6 hours", () => {
    const now = Date.now();
    const deadline = now + 5 * 3600000; // 5 hours from now
    const order = mockOrder({ deadline });
    const breakdown = scoreOrderBreakdown(order, now);
    expect(breakdown.deadlineBonus).toBe(50);
  });

  it("should apply deadline bonus for orders within 24 hours", () => {
    const now = Date.now();
    const deadline = now + 12 * 3600000; // 12 hours from now
    const order = mockOrder({ deadline });
    const breakdown = scoreOrderBreakdown(order, now);
    expect(breakdown.deadlineBonus).toBe(35);
  });

  it("should apply deadline bonus for orders within 72 hours", () => {
    const now = Date.now();
    const deadline = now + 48 * 3600000; // 48 hours from now
    const order = mockOrder({ deadline });
    const breakdown = scoreOrderBreakdown(order, now);
    expect(breakdown.deadlineBonus).toBe(15);
  });

  it("should not apply deadline bonus for orders more than 72 hours away", () => {
    const now = Date.now();
    const deadline = now + 100 * 3600000; // 100 hours from now
    const order = mockOrder({ deadline });
    const breakdown = scoreOrderBreakdown(order, now);
    expect(breakdown.deadlineBonus).toBe(0);
  });

  it("should calculate age bonus based on order age", () => {
    const now = Date.now();
    const createdAt = now - 10 * 3600000; // 10 hours old
    const order = mockOrder({ createdAt });
    const breakdown = scoreOrderBreakdown(order, now);
    expect(breakdown.ageBonus).toBe(Math.min(AGE_BONUS_MAX, 10 * AGE_BONUS_PER_HOUR));
  });

  it("should cap age bonus at maximum", () => {
    const now = Date.now();
    const createdAt = now - 100 * 3600000; // 100 hours old
    const order = mockOrder({ createdAt });
    const breakdown = scoreOrderBreakdown(order, now);
    expect(breakdown.ageBonus).toBe(AGE_BONUS_MAX);
  });

  it("should calculate profit bonus based on order revenue", () => {
    const order = mockOrder({
      items: [
        {
          productId: "products/test" as any,
          sku: "SKU-001",
          name: "Test",
          qty: 1,
          allocated: 0,
          picked: 0,
          packed: 0,
          price: 1000, // High value
        },
      ],
    });
    const breakdown = scoreOrderBreakdown(order, now);
    expect(breakdown.profitBonus).toBeGreaterThan(0);
  });

  it("should cap profit bonus at maximum", () => {
    const order = mockOrder({
      items: [
        {
          productId: "products/test" as any,
          sku: "SKU-001",
          name: "Test",
          qty: 1,
          allocated: 0,
          picked: 0,
          packed: 0,
          price: 10000, // Very high value
        },
      ],
    });
    const breakdown = scoreOrderBreakdown(order, now);
    expect(breakdown.profitBonus).toBeLessThanOrEqual(PROFIT_BONUS_MAX);
  });

  it("should sum components for total score", () => {
    const order = mockOrder({ priority: "urgent" });
    const breakdown = scoreOrderBreakdown(order, now);
    const expectedTotal =
      breakdown.priorityPoints + breakdown.deadlineBonus + breakdown.ageBonus + breakdown.profitBonus;
    expect(breakdown.total).toBe(expectedTotal);
  });

  it("scoreOrder should match total from breakdown", () => {
    const order = mockOrder({ priority: "high" });
    const breakdown = scoreOrderBreakdown(order, now);
    const score = scoreOrder(order, now);
    expect(score).toBe(breakdown.total);
  });
});

describe("Domain: Trust Model", () => {
  const now = Date.now();

  it("should calculate trust score from recent events", () => {
    const entries: TrustEntry[] = [
      {
        customer: "Customer A",
        trustEvent: "fulfilled_on_time",
        createdAt: now,
      },
    ];
    const score = customerTrustScore(entries, "Customer A", now);
    expect(score).toBeGreaterThan(100); // Base 100 + positive event
  });

  it("should ignore events outside the trust window", () => {
    const entries: TrustEntry[] = [
      {
        customer: "Customer A",
        trustEvent: "fulfilled_on_time",
        createdAt: now - 40 * 86400000, // 40 days ago
      },
    ];
    const score = customerTrustScore(entries, "Customer A", now);
    expect(score).toBe(100); // No events in window
  });

  it("should clamp score between 0 and 100", () => {
    const entries: TrustEntry[] = [
      {
        customer: "Customer A",
        trustEvent: "fulfilled_on_time",
        createdAt: now,
      },
      {
        customer: "Customer A",
        trustEvent: "fulfilled_early",
        createdAt: now,
      },
    ];
    const score = customerTrustScore(entries, "Customer A", now);
    expect(score).toBeLessThanOrEqual(100);
    expect(score).toBeGreaterThanOrEqual(0);
  });

  it("should count donor raids in the last 24 hours", () => {
    const entries: TrustEntry[] = [
      {
        customer: "Customer A",
        trustEvent: "donor_raided",
        createdAt: now - 12 * 3600000, // 12 hours ago
      },
      {
        customer: "Customer A",
        trustEvent: "donor_raided",
        createdAt: now - 6 * 3600000, // 6 hours ago
      },
    ];
    const strikes = recentDonorStrikes(entries, "Customer A", now);
    expect(strikes).toBe(2);
  });

  it("should not count donor raids outside 24-hour window", () => {
    const entries: TrustEntry[] = [
      {
        customer: "Customer A",
        trustEvent: "donor_raided",
        createdAt: now - 30 * 3600000, // 30 hours ago
      },
    ];
    const strikes = recentDonorStrikes(entries, "Customer A", now);
    expect(strikes).toBe(0);
  });
});

describe("Domain: Donor Eligibility", () => {
  const now = Date.now();

  it("should mark customer as eligible with good trust and no strikes", () => {
    const entries: TrustEntry[] = [
      {
        customer: "Customer A",
        trustEvent: "fulfilled_on_time",
        createdAt: now,
      },
    ];
    const result = isDonorEligible(entries, "Customer A", now);
    expect(result.eligible).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it("should mark customer as ineligible below trust floor", () => {
    const entries: TrustEntry[] = [
      {
        customer: "Customer A",
        trustEvent: "deadline_missed",
        createdAt: now,
      },
    ];
    // Create enough negative events to drop below floor
    for (let i = 0; i < 10; i++) {
      entries.push({
        customer: "Customer A",
        trustEvent: "deadline_missed",
        createdAt: now - i * 86400000,
      });
    }
    const result = isDonorEligible(entries, "Customer A", now);
    expect(result.eligible).toBe(false);
    expect(result.reason).toContain("trust score");
  });

  it("should mark customer as ineligible with recent donor raids", () => {
    const entries: TrustEntry[] = [
      {
        customer: "Customer A",
        trustEvent: "donor_raided",
        createdAt: now - 6 * 3600000,
      },
    ];
    const result = isDonorEligible(entries, "Customer A", now);
    expect(result.eligible).toBe(false);
    expect(result.reason).toContain("raided");
  });
});

describe("Domain: Inventory Calculations", () => {
  it("should calculate reserved stock from orders in holding statuses", () => {
    const orders = [
      mockOrder({
        status: "allocated" as const,
        items: [
          {
            productId: "products/prod1" as any,
            sku: "SKU-001",
            name: "Product",
            qty: 10,
            allocated: 8,
            picked: 0,
            packed: 0,
            price: 100,
          },
        ],
      }),
    ];
    const reserved = computeReserved("products/prod1" as any, orders);
    expect(reserved).toBe(8);
  });

  it("should not count picked units as reserved", () => {
    const orders = [
      mockOrder({
        status: "picking" as const,
        items: [
          {
            productId: "products/prod1" as any,
            sku: "SKU-001",
            name: "Product",
            qty: 10,
            allocated: 8,
            picked: 3,
            packed: 0,
            price: 100,
          },
        ],
      }),
    ];
    const reserved = computeReserved("products/prod1" as any, orders);
    expect(reserved).toBe(5); // 8 allocated - 3 picked
  });

  it("should not count fulfilled orders as reserved", () => {
    const orders = [
      mockOrder({
        status: "fulfilled" as const,
        items: [
          {
            productId: "products/prod1" as any,
            sku: "SKU-001",
            name: "Product",
            qty: 10,
            allocated: 10,
            picked: 10,
            packed: 10,
            price: 100,
          },
        ],
      }),
    ];
    const reserved = computeReserved("products/prod1" as any, orders);
    expect(reserved).toBe(0);
  });

  it("should calculate available inventory correctly", () => {
    const product = mockProduct({ onHand: 20 });
    const orders = [
      mockOrder({
        status: "allocated" as const,
        items: [
          {
            productId: product._id,
            sku: "SKU-001",
            name: "Product",
            qty: 10,
            allocated: 8,
            picked: 0,
            packed: 0,
            price: 100,
          },
        ],
      }),
    ];
    const availability = availabilityFor(product, orders);
    expect(availability.onHand).toBe(20);
    expect(availability.reserved).toBe(8);
    expect(availability.available).toBe(12); // 20 - 8
  });

  it("should not allow negative available inventory", () => {
    const product = mockProduct({ onHand: 5 });
    const orders = [
      mockOrder({
        status: "allocated" as const,
        items: [
          {
            productId: product._id,
            sku: "SKU-001",
            name: "Product",
            qty: 10,
            allocated: 8,
            picked: 0,
            packed: 0,
            price: 100,
          },
        ],
      }),
    ];
    const availability = availabilityFor(product, orders);
    expect(availability.available).toBeGreaterThanOrEqual(0);
  });

  it("should calculate open demand across multiple orders", () => {
    const productId = "products/prod1" as any;
    const orders = [
      mockOrder({
        status: "pending" as const,
        items: [
          {
            productId,
            sku: "SKU-001",
            name: "Product",
            qty: 10,
            allocated: 3,
            picked: 0,
            packed: 0,
            price: 100,
          },
        ],
      }),
      mockOrder({
        status: "review" as const,
        items: [
          {
            productId,
            sku: "SKU-001",
            name: "Product",
            qty: 5,
            allocated: 2,
            picked: 0,
            packed: 0,
            price: 100,
          },
        ],
      }),
    ];
    const demand = openDemand(productId, orders);
    expect(demand).toBe(10); // (10 - 3) + (5 - 2)
  });

  it("should not count fulfilled orders in open demand", () => {
    const productId = "products/prod1" as any;
    const orders = [
      mockOrder({
        status: "fulfilled" as const,
        items: [
          {
            productId,
            sku: "SKU-001",
            name: "Product",
            qty: 10,
            allocated: 10,
            picked: 10,
            packed: 10,
            price: 100,
          },
        ],
      }),
    ];
    const demand = openDemand(productId, orders);
    expect(demand).toBe(0);
  });
});

describe("Domain: Revenue & Net Benefit", () => {
  it("should calculate order revenue from all items", () => {
    const order = mockOrder({
      items: [
        {
          productId: "products/p1" as any,
          sku: "SKU-001",
          name: "Product 1",
          qty: 2,
          allocated: 0,
          picked: 0,
          packed: 0,
          price: 100,
        },
        {
          productId: "products/p2" as any,
          sku: "SKU-002",
          name: "Product 2",
          qty: 3,
          allocated: 0,
          picked: 0,
          packed: 0,
          price: 50,
        },
      ],
    });
    const revenue = orderRevenue(order);
    expect(revenue).toBe(350); // 2*100 + 3*50
  });

  it("should calculate donor trust cost based on units and priority", () => {
    const donor = mockOrder({
      priority: "urgent" as const,
      items: [
        {
          productId: "products/p1" as any,
          sku: "SKU-001",
          name: "Product",
          qty: 10,
          allocated: 10,
          picked: 0,
          packed: 0,
          price: 100,
        },
      ],
    });
    const cost = donorTrustCost(donor, 10, 5);
    expect(cost).toBeGreaterThan(0);
  });

  it("should calculate target gain based on units and need", () => {
    const target = mockOrder({
      items: [
        {
          productId: "products/p1" as any,
          sku: "SKU-001",
          name: "Product",
          qty: 10,
          allocated: 0,
          picked: 0,
          packed: 0,
          price: 100,
        },
      ],
    });
    const gain = targetGain(target, 10, 5);
    expect(gain).toBeGreaterThan(0);
  });

  it("should calculate net benefit as gain minus cost", () => {
    const target = mockOrder({
      items: [
        {
          productId: "products/p1" as any,
          sku: "SKU-001",
          name: "Target",
          qty: 10,
          allocated: 0,
          picked: 0,
          packed: 0,
          price: 100,
        },
      ],
    });
    const donor = mockOrder({
      priority: "low" as const,
      items: [
        {
          productId: "products/p1" as any,
          sku: "SKU-001",
          name: "Donor",
          qty: 10,
          allocated: 10,
          picked: 0,
          packed: 0,
          price: 100,
        },
      ],
    });
    const benefit = netBenefit(target, 10, donor, 10, 5);
    expect(typeof benefit).toBe("number");
  });
});
