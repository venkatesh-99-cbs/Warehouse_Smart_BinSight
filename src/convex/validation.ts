/**
 * validation.ts — Centralized validation utilities for warehouse operations
 * 
 * Provides reusable validation functions for orders, products, and allocations
 * to reduce duplication and ensure consistency.
 */

import type { OrderState, ProductState, Priority } from "./domain";

// ============================================================================
// Validation Result Types
// ============================================================================

export interface ValidationResult<T> {
  valid: boolean;
  value?: T;
  errors: ValidationError[];
}

export interface ValidationError {
  field: string;
  message: string;
  value?: unknown;
}

// ============================================================================
// Basic Type Validators
// ============================================================================

/**
 * Validate a string is non-empty
 */
export function validateString(
  value: unknown,
  fieldName: string,
  maxLength?: number,
): ValidationError | null {
  if (typeof value !== "string") {
    return { field: fieldName, message: "Must be a string", value };
  }
  if (value.trim().length === 0) {
    return { field: fieldName, message: "Cannot be empty", value };
  }
  if (maxLength && value.length > maxLength) {
    return { field: fieldName, message: `Cannot exceed ${maxLength} characters`, value };
  }
  return null;
}

/**
 * Validate a number is positive integer
 */
export function validatePositiveInteger(
  value: unknown,
  fieldName: string,
): ValidationError | null {
  if (!Number.isFinite(value)) {
    return { field: fieldName, message: "Must be a number", value };
  }
  const num = value as number;
  if (!Number.isInteger(num)) {
    return { field: fieldName, message: "Must be a whole number", value };
  }
  if (num <= 0) {
    return { field: fieldName, message: "Must be greater than 0", value };
  }
  return null;
}

/**
 * Validate a number is non-negative
 */
export function validateNonNegative(
  value: unknown,
  fieldName: string,
): ValidationError | null {
  if (!Number.isFinite(value)) {
    return { field: fieldName, message: "Must be a number", value };
  }
  const num = value as number;
  if (num < 0) {
    return { field: fieldName, message: "Cannot be negative", value };
  }
  return null;
}

/**
 * Validate a timestamp is in the future
 */
export function validateFutureTimestamp(
  value: unknown,
  fieldName: string,
  now: number = Date.now(),
): ValidationError | null {
  if (!Number.isFinite(value)) {
    return { field: fieldName, message: "Must be a valid timestamp", value };
  }
  const ts = value as number;
  if (ts <= now) {
    return { field: fieldName, message: "Must be in the future", value };
  }
  return null;
}

/**
 * Validate a priority value
 */
export function validatePriority(value: unknown): ValidationError | null {
  const valid = ["urgent", "high", "medium", "low"].includes(value as string);
  if (!valid) {
    return { 
      field: "priority", 
      message: "Must be one of: urgent, high, medium, low", 
      value 
    };
  }
  return null;
}

// ============================================================================
// Business Logic Validators
// ============================================================================

/**
 * Validate that allocated quantity does not exceed requested
 */
export function validateAllocationBounds(
  allocated: number,
  requested: number,
  fieldName: string = "allocation",
): ValidationError | null {
  if (allocated > requested) {
    return {
      field: fieldName,
      message: `Allocated (${allocated}) exceeds requested (${requested})`,
      value: allocated,
    };
  }
  return null;
}

/**
 * Validate that inventory constraint is satisfied
 */
export function validateInventoryConstraint(
  product: ProductState,
  orders: OrderState[],
): ValidationError | null {
  // Calculate total reserved for this product
  let totalReserved = 0;
  for (const order of orders) {
    for (const item of order.items) {
      if (item.productId === product._id) {
        // Only count allocated that hasn't been picked yet
        totalReserved += Math.max(0, item.allocated - item.picked);
      }
    }
  }

  if (totalReserved > product.onHand) {
    return {
      field: "inventory",
      message: `Reserved (${totalReserved}) exceeds on-hand (${product.onHand}) for ${product.sku}`,
      value: { reserved: totalReserved, onHand: product.onHand },
    };
  }

  if (product.onHand < 0) {
    return {
      field: "inventory",
      message: `Negative inventory for ${product.sku}: ${product.onHand}`,
      value: product.onHand,
    };
  }

  return null;
}

/**
 * Validate that order has valid items
 */
export function validateOrderItems(order: OrderState): ValidationError[] {
  const errors: ValidationError[] = [];

  if (!Array.isArray(order.items) || order.items.length === 0) {
    errors.push({
      field: "items",
      message: "Order must have at least one item",
      value: order.items,
    });
    return errors;
  }

  for (let i = 0; i < order.items.length; i++) {
    const item = order.items[i];

    if (item.qty <= 0) {
      errors.push({
        field: `items[${i}].qty`,
        message: "Quantity must be greater than 0",
        value: item.qty,
      });
    }

    if (item.allocated > item.qty) {
      errors.push({
        field: `items[${i}].allocated`,
        message: `Allocated (${item.allocated}) exceeds quantity (${item.qty})`,
        value: item.allocated,
      });
    }

    if (item.picked > item.allocated) {
      errors.push({
        field: `items[${i}].picked`,
        message: `Picked (${item.picked}) exceeds allocated (${item.allocated})`,
        value: item.picked,
      });
    }

    if (item.packed > item.picked) {
      errors.push({
        field: `items[${i}].packed`,
        message: `Packed (${item.packed}) exceeds picked (${item.picked})`,
        value: item.packed,
      });
    }

    if (item.price < 0) {
      errors.push({
        field: `items[${i}].price`,
        message: "Price cannot be negative",
        value: item.price,
      });
    }
  }

  return errors;
}

/**
 * Validate product stock levels
 */
export function validateProductStock(product: ProductState): ValidationError[] {
  const errors: ValidationError[] = [];

  if (product.onHand < 0) {
    errors.push({
      field: "onHand",
      message: `Negative inventory: ${product.onHand}`,
      value: product.onHand,
    });
  }

  if (product.reorderPoint < 0) {
    errors.push({
      field: "reorderPoint",
      message: `Invalid reorder point: ${product.reorderPoint}`,
      value: product.reorderPoint,
    });
  }

  if (product.reorderQty <= 0) {
    errors.push({
      field: "reorderQty",
      message: `Reorder quantity must be positive: ${product.reorderQty}`,
      value: product.reorderQty,
    });
  }

  if (product.leadTimeDays < 0) {
    errors.push({
      field: "leadTimeDays",
      message: `Negative lead time: ${product.leadTimeDays}`,
      value: product.leadTimeDays,
    });
  }

  if (product.price < 0) {
    errors.push({
      field: "price",
      message: `Negative price: ${product.price}`,
      value: product.price,
    });
  }

  return errors;
}

// ============================================================================
// Composite Validators
// ============================================================================

/**
 * Validate complete order state
 */
export function validateOrder(order: OrderState): ValidationResult<OrderState> {
  const errors: ValidationError[] = [];

  // Basic string validation
  const orderNumberError = validateString(order.orderNumber, "orderNumber", 50);
  if (orderNumberError) errors.push(orderNumberError);

  const customerError = validateString(order.customer, "customer", 100);
  if (customerError) errors.push(customerError);

  // Validate priority
  const priorityError = validatePriority(order.priority);
  if (priorityError) errors.push(priorityError);

  // Validate timestamps
  const now = Date.now();
  if (order.createdAt > now) {
    errors.push({
      field: "createdAt",
      message: "Creation time cannot be in the future",
      value: order.createdAt,
    });
  }

  if (order.deadline <= now && order.status !== "fulfilled" && order.status !== "cancelled") {
    errors.push({
      field: "deadline",
      message: "Deadline has passed",
      value: order.deadline,
    });
  }

  // Validate items
  errors.push(...validateOrderItems(order));

  return {
    valid: errors.length === 0,
    value: errors.length === 0 ? order : undefined,
    errors,
  };
}

/**
 * Validate complete product state
 */
export function validateProduct(product: ProductState): ValidationResult<ProductState> {
  const errors: ValidationError[] = [];

  const skuError = validateString(product.sku, "sku", 50);
  if (skuError) errors.push(skuError);

  const nameError = validateString(product.name, "name", 200);
  if (nameError) errors.push(nameError);

  errors.push(...validateProductStock(product));

  return {
    valid: errors.length === 0,
    value: errors.length === 0 ? product : undefined,
    errors,
  };
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Check if validation passed
 */
export function isValid<T>(result: ValidationResult<T>): boolean {
  return result.valid && result.errors.length === 0;
}

/**
 * Get comma-separated error messages
 */
export function formatErrors(errors: ValidationError[]): string {
  return errors.map((e) => `${e.field}: ${e.message}`).join("; ");
}

/**
 * Assert validation passed or throw
 */
export function assertValid<T>(result: ValidationResult<T>, context: string): asserts result is ValidationResult<T> & { valid: true; value: T } {
  if (!result.valid) {
    throw new Error(`${context}: ${formatErrors(result.errors)}`);
  }
}
