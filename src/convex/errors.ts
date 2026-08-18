/**
 * errors.ts — Centralized error handling and user-facing message generation
 * 
 * Provides consistent error classification, logging, and user-friendly messages
 * across the warehouse operations system.
 */

export type ErrorSeverity = "info" | "warning" | "critical";

export type ErrorCategory = 
  | "validation"
  | "inventory"
  | "allocation"
  | "fulfillment"
  | "authorization"
  | "system";

export class WarehouseError extends Error {
  constructor(
    public message: string,
    public category: ErrorCategory,
    public severity: ErrorSeverity,
    public details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "WarehouseError";
  }
}

// ============================================================================
// Error Classification & Messaging
// ============================================================================

/**
 * Inventory errors - when stock is insufficient or invalid
 */
export class InventoryError extends WarehouseError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, "inventory", "warning", details);
    this.name = "InventoryError";
  }
}

/**
 * Allocation errors - when allocation rules are violated
 */
export class AllocationError extends WarehouseError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, "allocation", "critical", details);
    this.name = "AllocationError";
  }
}

/**
 * Validation errors - when input fails validation
 */
export class ValidationError extends WarehouseError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, "validation", "warning", details);
    this.name = "ValidationError";
  }
}

/**
 * Fulfillment errors - when fulfillment workflow is violated
 */
export class FulfillmentError extends WarehouseError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, "fulfillment", "critical", details);
    this.name = "FulfillmentError";
  }
}

// ============================================================================
// Common Error Patterns
// ============================================================================

/**
 * Insufficient stock for allocation
 */
export function insufficientStockError(
  sku: string,
  requested: number,
  available: number,
): InventoryError {
  return new InventoryError(
    `Insufficient stock for ${sku}: requested ${requested}, available ${available}`,
    { sku, requested, available, shortage: requested - available },
  );
}

/**
 * Product not found
 */
export function productNotFoundError(sku: string): ValidationError {
  return new ValidationError(
    `Product not found: ${sku}`,
    { sku },
  );
}

/**
 * Order not found
 */
export function orderNotFoundError(orderNumber: string): ValidationError {
  return new ValidationError(
    `Order not found: ${orderNumber}`,
    { orderNumber },
  );
}

/**
 * Invalid order status for operation
 */
export function invalidOrderStatusError(
  orderNumber: string,
  currentStatus: string,
  requiredStatus: string,
): FulfillmentError {
  return new FulfillmentError(
    `Invalid order status: ${orderNumber} is ${currentStatus}, must be ${requiredStatus}`,
    { orderNumber, currentStatus, requiredStatus },
  );
}

/**
 * Over-allocation detected
 */
export function overAllocationError(
  orderId: string,
  allocated: number,
  available: number,
): AllocationError {
  return new AllocationError(
    `Over-allocation detected: allocated ${allocated} exceeds available ${available}`,
    { orderId, allocated, available },
  );
}

/**
 * Negative inventory detected (invariant violation)
 */
export function negativeInventoryError(
  sku: string,
  onHand: number,
): AllocationError {
  return new AllocationError(
    `Negative inventory invariant violation: ${sku} has ${onHand} on hand`,
    { sku, onHand },
  );
}

/**
 * Damaged/missing inventory exceeds on-hand
 */
export function damageMissingExceedsStockError(
  sku: string,
  onHand: number,
  damage: number,
  missing: number,
): InventoryError {
  return new InventoryError(
    `Damage + missing exceeds stock: ${sku} has ${onHand} on hand, but ${damage} damaged + ${missing} missing`,
    { sku, onHand, damage, missing },
  );
}

/**
 * Trust floor violation - customer cannot be raided
 */
export function trustFloorViolationError(
  customer: string,
  trustScore: number,
): FulfillmentError {
  return new FulfillmentError(
    `Cannot raid ${customer}: trust score ${trustScore} below protection floor (40)`,
    { customer, trustScore },
  );
}

/**
 * Recent raid lockout - customer was raided too recently
 */
export function recentRaidLockoutError(
  customer: string,
  strikeCount: number,
): FulfillmentError {
  return new FulfillmentError(
    `Cannot raid ${customer}: raided ${strikeCount} time(s) in last 24 hours`,
    { customer, strikeCount },
  );
}

// ============================================================================
// User-Facing Message Generation
// ============================================================================

/**
 * Generate a user-friendly message from a WarehouseError
 */
export function getUserMessage(error: Error): string {
  if (error instanceof InventoryError) {
    return `📦 Inventory Issue: ${error.message}`;
  }
  if (error instanceof AllocationError) {
    return `⚠️ Allocation Issue: ${error.message}`;
  }
  if (error instanceof ValidationError) {
    return `❌ Invalid Input: ${error.message}`;
  }
  if (error instanceof FulfillmentError) {
    return `🚨 Fulfillment Issue: ${error.message}`;
  }
  return `System Error: ${error.message}`;
}

/**
 * Format error details for logging
 */
export function formatErrorForLog(error: Error): object {
  if (error instanceof WarehouseError) {
    return {
      name: error.name,
      message: error.message,
      category: error.category,
      severity: error.severity,
      details: error.details,
      timestamp: new Date().toISOString(),
    };
  }
  return {
    name: error.name,
    message: error.message,
    timestamp: new Date().toISOString(),
  };
}

// ============================================================================
// Error Handling Utilities
// ============================================================================

/**
 * Safe execution wrapper with error handling
 */
export async function safeExecute<T>(
  operation: () => Promise<T>,
  fallback?: T,
): Promise<T | undefined> {
  try {
    return await operation();
  } catch (error) {
    console.error("Operation failed:", formatErrorForLog(error as Error));
    return fallback;
  }
}

/**
 * Validate inventory constraint and throw if violated
 */
export function assertValidInventory(
  sku: string,
  onHand: number,
  reserved: number,
): void {
  if (onHand < 0) {
    throw negativeInventoryError(sku, onHand);
  }
  if (reserved > onHand) {
    throw new AllocationError(
      `Reserved inventory exceeds on-hand: ${sku} reserved ${reserved} > ${onHand} on hand`,
      { sku, reserved, onHand },
    );
  }
}

/**
 * Validate allocation constraint and throw if violated
 */
export function assertValidAllocation(
  orderId: string,
  allocated: number,
  requested: number,
  available: number,
): void {
  if (allocated < 0) {
    throw new AllocationError(
      `Negative allocation: ${allocated}`,
      { orderId, allocated },
    );
  }
  if (allocated > requested) {
    throw new AllocationError(
      `Allocated exceeds requested: ${allocated} > ${requested}`,
      { orderId, allocated, requested },
    );
  }
  if (allocated > available) {
    throw overAllocationError(orderId, allocated, available);
  }
}

/**
 * Type guard for WarehouseError
 */
export function isWarehouseError(error: unknown): error is WarehouseError {
  return error instanceof WarehouseError;
}
