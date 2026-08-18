/**
 * warehouse-utils.ts — Common utility functions for warehouse operations
 * 
 * Extracted pure functions to reduce duplication and improve testability
 */

import type { OrderState, ProductState } from "./domain";

// ============================================================================
// Inventory Utilities
// ============================================================================

export interface InventoryMetrics {
  totalOnHand: number;
  totalReserved: number;
  totalAvailable: number;
  lowStockCount: number;
  outOfStockCount: number;
  averageUtilization: number;
}

/**
 * Calculate aggregate inventory metrics across all products
 */
export function calculateInventoryMetrics(
  products: ProductState[],
  orders: OrderState[],
): InventoryMetrics {
  let totalOnHand = 0;
  let totalReserved = 0;
  let lowStockCount = 0;
  let outOfStockCount = 0;

  for (const product of products) {
    totalOnHand += product.onHand;

    if (product.onHand <= 0) {
      outOfStockCount += 1;
    } else if (product.onHand < product.reorderPoint) {
      lowStockCount += 1;
    }
  }

  // Calculate reserved from orders
  for (const order of orders) {
    for (const item of order.items) {
      if (order.status === "pending" || 
          order.status === "review" || 
          order.status === "allocated" || 
          order.status === "picking" || 
          order.status === "picked" || 
          order.status === "packed" || 
          order.status === "qc" || 
          order.status === "dispatched") {
        totalReserved += Math.max(0, item.allocated - item.picked);
      }
    }
  }

  const totalAvailable = Math.max(0, totalOnHand - totalReserved);
  const averageUtilization = totalOnHand > 0 ? Math.round((totalReserved / totalOnHand) * 100) : 0;

  return {
    totalOnHand,
    totalReserved,
    totalAvailable,
    lowStockCount,
    outOfStockCount,
    averageUtilization,
  };
}

// ============================================================================
// Order Utilities
// ============================================================================

export interface OrderMetrics {
  totalOrders: number;
  pendingCount: number;
  allocatedCount: number;
  pickingCount: number;
  dispatchedCount: number;
  fulfilledCount: number;
  avgFulfillmentRate: number;
}

/**
 * Calculate order fulfillment metrics
 */
export function calculateOrderMetrics(orders: OrderState[]): OrderMetrics {
  let pendingCount = 0;
  let allocatedCount = 0;
  let pickingCount = 0;
  let dispatchedCount = 0;
  let fulfilledCount = 0;
  let totalFulfillmentRate = 0;

  for (const order of orders) {
    switch (order.status) {
      case "pending":
      case "review":
        pendingCount += 1;
        break;
      case "allocated":
        allocatedCount += 1;
        break;
      case "picking":
      case "picked":
      case "packed":
      case "qc":
        pickingCount += 1;
        break;
      case "dispatched":
        dispatchedCount += 1;
        break;
      case "fulfilled":
        fulfilledCount += 1;
        break;
    }

    // Calculate fulfillment rate for this order
    const allocatedQty = order.items.reduce((sum, item) => sum + item.allocated, 0);
    const requestedQty = order.items.reduce((sum, item) => sum + item.qty, 0);
    if (requestedQty > 0) {
      totalFulfillmentRate += (allocatedQty / requestedQty) * 100;
    }
  }

  const avgFulfillmentRate = orders.length > 0 
    ? Math.round(totalFulfillmentRate / orders.length) 
    : 0;

  return {
    totalOrders: orders.length,
    pendingCount,
    allocatedCount,
    pickingCount,
    dispatchedCount,
    fulfilledCount,
    avgFulfillmentRate,
  };
}

// ============================================================================
// Time Utilities
// ============================================================================

/**
 * Format milliseconds to human-readable time remaining
 */
export function formatTimeRemaining(deadline: number, now: number): string {
  const msRemaining = deadline - now;
  if (msRemaining < 0) return "Overdue";
  
  const hoursRemaining = Math.round(msRemaining / 3_600_000);
  if (hoursRemaining < 1) return "< 1 hour";
  if (hoursRemaining < 24) return `${hoursRemaining}h`;
  
  const daysRemaining = Math.round(hoursRemaining / 24);
  return `${daysRemaining}d`;
}

/**
 * Calculate urgency score based on time to deadline
 */
export function getUrgencyLevel(deadline: number, now: number): "critical" | "high" | "medium" | "low" {
  const hoursRemaining = (deadline - now) / 3_600_000;
  
  if (hoursRemaining < 0) return "critical"; // Overdue
  if (hoursRemaining < 6) return "critical";
  if (hoursRemaining < 24) return "high";
  if (hoursRemaining < 72) return "medium";
  return "low";
}

// ============================================================================
// Fulfillment Utilities
// ============================================================================

export interface OrderFulfillmentBreakdown {
  orderNumber: string;
  customer: string;
  totalRequested: number;
  totalAllocated: number;
  totalPicked: number;
  totalPacked: number;
  fulfillmentRate: number;
  pickingRate: number;
  packingRate: number;
  status: string;
}

/**
 * Breakdown fulfillment progress for a single order
 */
export function getOrderFulfillmentBreakdown(order: OrderState): OrderFulfillmentBreakdown {
  const totalRequested = order.items.reduce((sum, item) => sum + item.qty, 0);
  const totalAllocated = order.items.reduce((sum, item) => sum + item.allocated, 0);
  const totalPicked = order.items.reduce((sum, item) => sum + item.picked, 0);
  const totalPacked = order.items.reduce((sum, item) => sum + item.packed, 0);

  return {
    orderNumber: order.orderNumber,
    customer: order.customer,
    totalRequested,
    totalAllocated,
    totalPicked,
    totalPacked,
    fulfillmentRate: totalRequested > 0 ? Math.round((totalAllocated / totalRequested) * 100) : 0,
    pickingRate: totalAllocated > 0 ? Math.round((totalPicked / totalAllocated) * 100) : 0,
    packingRate: totalPicked > 0 ? Math.round((totalPacked / totalPicked) * 100) : 0,
    status: order.status,
  };
}

// ============================================================================
// Anomaly Detection
// ============================================================================

export interface WarehouseAnomalies {
  overAllocatedOrders: string[];
  negativeStockProducts: string[];
  missedDeadlines: string[];
  unusualOrderAges: string[];
}

/**
 * Detect operational anomalies
 */
export function detectAnomalies(
  products: ProductState[],
  orders: OrderState[],
  now: number,
): WarehouseAnomalies {
  const anomalies: WarehouseAnomalies = {
    overAllocatedOrders: [],
    negativeStockProducts: [],
    missedDeadlines: [],
    unusualOrderAges: [],
  };

  // Check for negative stock
  for (const product of products) {
    if (product.onHand < 0) {
      anomalies.negativeStockProducts.push(product.sku);
    }
  }

  // Check for over-allocated orders
  for (const order of orders) {
    for (const item of order.items) {
      if (item.allocated > item.qty) {
        anomalies.overAllocatedOrders.push(order.orderNumber);
        break;
      }
    }
  }

  // Check for missed deadlines and unusual ages
  for (const order of orders) {
    if (order.deadline < now && order.status !== "fulfilled" && order.status !== "cancelled") {
      anomalies.missedDeadlines.push(order.orderNumber);
    }

    const ageHours = (now - order.createdAt) / 3_600_000;
    if (ageHours > 72 && order.status === "pending") {
      anomalies.unusualOrderAges.push(`${order.orderNumber} (${Math.round(ageHours)}h old)`);
    }
  }

  return anomalies;
}

// ============================================================================
// Capacity Analysis
// ============================================================================

export interface OperationalCapacity {
  pickingCapacityUtilization: number;
  packingCapacityUtilization: number;
  estimatedPickingHoursNeeded: number;
  estimatedPackingHoursNeeded: number;
  bottleneck: "picking" | "packing" | "none";
}

/**
 * Analyze operational capacity based on current orders
 */
export function analyzeCapacity(
  orders: OrderState[],
  pickers: number = 4,
  pickingCapacityPerPicker: number = 30,
  packingCapacity: number = 60,
): OperationalCapacity {
  // Count items needing picking and packing
  let itemsForPicking = 0;
  let itemsForPacking = 0;

  for (const order of orders) {
    if (order.status === "allocated" || order.status === "picking") {
      for (const item of order.items) {
        const shortfall = Math.max(0, item.allocated - item.picked);
        itemsForPicking += shortfall;
      }
    }

    if (order.status === "picked" || order.status === "packed" || order.status === "qc") {
      for (const item of order.items) {
        const shortfall = Math.max(0, item.picked - item.packed);
        itemsForPacking += shortfall;
      }
    }
  }

  const totalPickingCapacity = pickers * pickingCapacityPerPicker;
  const estimatedPickingHoursNeeded = totalPickingCapacity > 0 
    ? itemsForPicking / pickingCapacityPerPicker
    : 0;
  const estimatedPackingHoursNeeded = packingCapacity > 0
    ? itemsForPacking / packingCapacity
    : 0;

  const pickingUtilization = totalPickingCapacity > 0
    ? Math.min(100, Math.round((itemsForPicking / totalPickingCapacity) * 100))
    : 0;
  const packingUtilization = packingCapacity > 0
    ? Math.min(100, Math.round((itemsForPacking / packingCapacity) * 100))
    : 0;

  let bottleneck: "picking" | "packing" | "none" = "none";
  if (pickingUtilization > 80) bottleneck = "picking";
  if (packingUtilization > 80 && (bottleneck === "none" || packingUtilization > pickingUtilization)) {
    bottleneck = "packing";
  }

  return {
    pickingCapacityUtilization: pickingUtilization,
    packingCapacityUtilization: packingUtilization,
    estimatedPickingHoursNeeded,
    estimatedPackingHoursNeeded,
    bottleneck,
  };
}
