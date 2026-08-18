/**
 * seed.ts — idempotent, realistic seed data (§8): 20 products across 6 zones,
 * ~26 orders spanning every pipeline stage, 11 live picking tasks, 12 open
 * alerts covering all 8 types, 7 shipments, and a decisionLog history that
 * makes the two canonical dilemmas work — including the seeded trust-history
 * that protects Cascade Outfitters (URG-2002's only donor).
 *
 * Idempotency: skips entirely when products already exist. Also refreshes the
 * URG-2002 protection entries if they have aged out of the 24h strike window,
 * so the demo scenario keeps working across sessions.
 */
import { mutation, query, type MutationCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import type { OrderStatus, Priority } from "./domain";

const H = 3_600_000;
const D = 24 * H;

/* ------------------------------------------------------------ products */

type ProductSeed = {
  sku: string;
  name: string;
  category: string;
  unit: string;
  price: number;
  onHand: number;
  reorderPoint: number;
  reorderQty: number;
  leadTimeDays: number;
  supplier: string;
  zone: string;
  bin: string;
};

const PRODUCTS: ProductSeed[] = [
  { sku: "WRT-8800", name: "Wi-Fi 6 Mesh Router", category: "Networking", unit: "unit", price: 149.99, onHand: 10, reorderPoint: 15, reorderQty: 40, leadTimeDays: 5, supplier: "Meridian Micro Distributors", zone: "A", bin: "A-03" },
  { sku: "RTR-2600", name: "8-Port Gigabit Router", category: "Networking", unit: "unit", price: 89.99, onHand: 4, reorderPoint: 10, reorderQty: 30, leadTimeDays: 4, supplier: "Meridian Micro Distributors", zone: "A", bin: "A-07" },
  { sku: "SWT-2424", name: "24-Port Managed Switch", category: "Networking", unit: "unit", price: 219.0, onHand: 12, reorderPoint: 8, reorderQty: 20, leadTimeDays: 6, supplier: "Halcyon Electronics Supply", zone: "A", bin: "A-11" },
  { sku: "NVR-8CH", name: "8-Channel NVR Recorder", category: "Surveillance", unit: "unit", price: 349.0, onHand: 4, reorderPoint: 5, reorderQty: 8, leadTimeDays: 12, supplier: "Halcyon Electronics Supply", zone: "A", bin: "A-14" },
  { sku: "CAT6-305", name: "Cat6 Plenum Cable 305m", category: "Cabling", unit: "reel", price: 124.5, onHand: 6, reorderPoint: 10, reorderQty: 15, leadTimeDays: 3, supplier: "Halcyon Electronics Supply", zone: "B", bin: "B-02" },
  { sku: "FIB-OM4", name: "OM4 Fiber Patch 2m", category: "Cabling", unit: "unit", price: 18.75, onHand: 0, reorderPoint: 25, reorderQty: 100, leadTimeDays: 7, supplier: "Meridian Micro Distributors", zone: "B", bin: "B-05" },
  { sku: "SEN-THRM", name: "Wireless Temp Sensor", category: "IoT", unit: "unit", price: 42.3, onHand: 18, reorderPoint: 20, reorderQty: 50, leadTimeDays: 9, supplier: "Cascade Supply Partners", zone: "C", bin: "C-01" },
  { sku: "SEN-MOTN", name: "PIR Motion Sensor", category: "IoT", unit: "unit", price: 29.9, onHand: 9, reorderPoint: 15, reorderQty: 40, leadTimeDays: 8, supplier: "Cascade Supply Partners", zone: "C", bin: "C-04" },
  { sku: "BAT-LI12", name: "12V LiFePO4 Battery", category: "Power", unit: "unit", price: 159.0, onHand: 6, reorderPoint: 12, reorderQty: 24, leadTimeDays: 6, supplier: "VoltSource Energy Group", zone: "C", bin: "C-08" },
  { sku: "PSU-65W", name: "65W USB-C Power Adapter", category: "Power", unit: "unit", price: 24.99, onHand: 22, reorderPoint: 30, reorderQty: 60, leadTimeDays: 4, supplier: "VoltSource Energy Group", zone: "D", bin: "D-02" },
  { sku: "CHG-4BAY", name: "4-Bay Battery Charger", category: "Power", unit: "unit", price: 54.5, onHand: 7, reorderPoint: 8, reorderQty: 16, leadTimeDays: 5, supplier: "VoltSource Energy Group", zone: "D", bin: "D-06" },
  { sku: "BOX-6010", name: "Corrugated Box 60×40×40", category: "Packaging", unit: "unit", price: 1.85, onHand: 480, reorderPoint: 200, reorderQty: 500, leadTimeDays: 2, supplier: "Harborline Packaging Co", zone: "D", bin: "D-10" },
  { sku: "BOX-4025", name: "Corrugated Box 40×25×20", category: "Packaging", unit: "unit", price: 0.95, onHand: 150, reorderPoint: 250, reorderQty: 600, leadTimeDays: 2, supplier: "Harborline Packaging Co", zone: "D", bin: "D-11" },
  { sku: "TAPE-48", name: "Packing Tape 48mm (6-pack)", category: "Packaging", unit: "pack", price: 8.4, onHand: 55, reorderPoint: 40, reorderQty: 80, leadTimeDays: 3, supplier: "Harborline Packaging Co", zone: "E", bin: "E-01" },
  { sku: "LABL-4x6", name: "Thermal Label Roll 4×6in (500)", category: "Packaging", unit: "roll", price: 12.2, onHand: 30, reorderPoint: 35, reorderQty: 60, leadTimeDays: 4, supplier: "Cascade Supply Partners", zone: "E", bin: "E-03" },
  { sku: "PLT-EURO", name: "Euro Pallet 120×80", category: "Handling", unit: "unit", price: 14.9, onHand: 25, reorderPoint: 20, reorderQty: 40, leadTimeDays: 5, supplier: "Bergwerk Logistics AG", zone: "E", bin: "E-06" },
  { sku: "STRAP-9M", name: "Poly Strapping Roll 9mm", category: "Handling", unit: "roll", price: 6.75, onHand: 42, reorderPoint: 30, reorderQty: 60, leadTimeDays: 3, supplier: "Bergwerk Logistics AG", zone: "F", bin: "F-01" },
  { sku: "HND-PLT", name: "Manual Pallet Jack", category: "Handling", unit: "unit", price: 389.0, onHand: 3, reorderPoint: 2, reorderQty: 4, leadTimeDays: 14, supplier: "Bergwerk Logistics AG", zone: "F", bin: "F-04" },
  { sku: "STK-LBL", name: "Stock Bin Label (250-pack)", category: "Handling", unit: "pack", price: 5.6, onHand: 90, reorderPoint: 50, reorderQty: 100, leadTimeDays: 2, supplier: "Harborline Packaging Co", zone: "F", bin: "F-07" },
  { sku: "CAM-4KPT", name: "4K PTZ Security Camera", category: "Surveillance", unit: "unit", price: 279.0, onHand: 5, reorderPoint: 6, reorderQty: 12, leadTimeDays: 10, supplier: "Halcyon Electronics Supply", zone: "F", bin: "F-10" },
];

/* ------------------------------------------------------------ orders */

type ItemSeed = {
  sku: string;
  qty: number;
  allocated: number;
  picked: number;
  packed: number;
};

type OrderSeed = {
  orderNumber: string;
  customer: string;
  priority: Priority;
  status: OrderStatus;
  deadline: number;
  createdAt: number;
  isDemoScenario?: boolean;
  notes?: string;
  items: ItemSeed[];
};

function buildOrders(now: number): OrderSeed[] {
  return [
    // ---- canonical dilemmas (§2 / §8) ----
    {
      orderNumber: "URG-2001",
      customer: "Vertex Retail",
      priority: "urgent",
      status: "review",
      deadline: now + 5 * H,
      createdAt: now - 2 * H,
      isDemoScenario: true,
      notes: "Key account SLA — expedite. Router shortfall: 10 needed, 2 free, donors ORD-3010 (5) + ORD-3040 (3).",
      items: [{ sku: "WRT-8800", qty: 10, allocated: 0, picked: 0, packed: 0 }],
    },
    {
      orderNumber: "URG-2002",
      customer: "Metroline Wholesale",
      priority: "urgent",
      status: "review",
      deadline: now + 4 * H,
      createdAt: now - 1.5 * H,
      isDemoScenario: true,
      notes: "Battery shortfall. Only donor is Cascade Outfitters — trust-protected, so reallocation MUST be withheld (§2 scenario 2).",
      items: [{ sku: "BAT-LI12", qty: 8, allocated: 0, picked: 0, packed: 0 }],
    },
    // ---- donors (allocated, reserve stock) ----
    {
      orderNumber: "ORD-3010",
      customer: "Northgate Logistics",
      priority: "low",
      status: "allocated",
      deadline: now + 5 * D,
      createdAt: now - 2 * D,
      notes: "Reserves 5 × WRT-8800 — eligible donor for URG-2001.",
      items: [
        { sku: "WRT-8800", qty: 5, allocated: 5, picked: 0, packed: 0 },
        { sku: "BOX-6010", qty: 20, allocated: 20, picked: 0, packed: 0 },
      ],
    },
    {
      orderNumber: "ORD-3040",
      customer: "Bluepeak Distribution",
      priority: "low",
      status: "allocated",
      deadline: now + 6 * D,
      createdAt: now - 2 * D,
      notes: "Reserves 3 × WRT-8800 — second eligible donor for URG-2001.",
      items: [
        { sku: "WRT-8800", qty: 3, allocated: 3, picked: 0, packed: 0 },
        { sku: "TAPE-48", qty: 6, allocated: 6, picked: 0, packed: 0 },
      ],
    },
    {
      orderNumber: "ORD-5010",
      customer: "Cascade Outfitters",
      priority: "medium",
      status: "allocated",
      deadline: now + 3 * D,
      createdAt: now - 3 * D,
      notes: "Reserves 5 × BAT-LI12 — the ONLY holder for URG-2002, and trust-protected (3 raids in 24h, score below floor).",
      items: [
        { sku: "BAT-LI12", qty: 5, allocated: 5, picked: 0, packed: 0 },
        { sku: "LABL-4x6", qty: 10, allocated: 10, picked: 0, packed: 0 },
      ],
    },
    // ---- pending (the FIFO-vs-scoring contention pair, §7.6/§7.8) ----
    {
      orderNumber: "ORD-4021",
      customer: "Northgate Logistics",
      priority: "medium",
      status: "pending",
      deadline: now + 30 * H,
      createdAt: now - 3 * D,
      notes: "Old medium order competing for SWT-2424 — FIFO would capture it first; scoring prioritizes ORD-4025.",
      items: [
        { sku: "SWT-2424", qty: 4, allocated: 0, picked: 0, packed: 0 },
        { sku: "PSU-65W", qty: 5, allocated: 0, picked: 0, packed: 0 },
      ],
    },
    {
      orderNumber: "ORD-4025",
      customer: "Vertex Retail",
      priority: "high",
      status: "pending",
      deadline: now + 9 * H,
      createdAt: now - 3 * H,
      items: [
        { sku: "SWT-2424", qty: 10, allocated: 0, picked: 0, packed: 0 },
        { sku: "PSU-65W", qty: 5, allocated: 0, picked: 0, packed: 0 },
      ],
    },
    // ---- more pending ----
    {
      orderNumber: "ORD-4011",
      customer: "Ironbridge Supply",
      priority: "medium",
      status: "pending",
      deadline: now + 20 * H,
      createdAt: now - 2 * D,
      notes: "Demands FIB-OM4 which is at 0 — will be blocked until the urgent PO lands.",
      items: [{ sku: "FIB-OM4", qty: 20, allocated: 0, picked: 0, packed: 0 }],
    },
    {
      orderNumber: "ORD-4022",
      customer: "Bluepeak Distribution",
      priority: "low",
      status: "pending",
      deadline: now + 3 * D,
      createdAt: now - 1 * D,
      items: [{ sku: "BOX-6010", qty: 40, allocated: 0, picked: 0, packed: 0 }],
    },
    {
      orderNumber: "ORD-2120",
      customer: "Ironbridge Supply",
      priority: "medium",
      status: "pending",
      deadline: now + 40 * H,
      createdAt: now - 10 * H,
      items: [{ sku: "PLT-EURO", qty: 8, allocated: 0, picked: 0, packed: 0 }],
    },
    // ---- picking ----
    {
      orderNumber: "ORD-3015",
      customer: "Vertex Retail",
      priority: "high",
      status: "picking",
      deadline: now + 12 * H,
      createdAt: now - 1 * D,
      notes: "In progress — PSU-65W partially picked; two tasks still pending.",
      items: [
        { sku: "SWT-2424", qty: 2, allocated: 2, picked: 0, packed: 0 },
        { sku: "PSU-65W", qty: 10, allocated: 10, picked: 4, packed: 0 },
        { sku: "STK-LBL", qty: 20, allocated: 20, picked: 0, packed: 0 },
      ],
    },
    {
      orderNumber: "ORD-3025",
      customer: "Cascade Outfitters",
      priority: "medium",
      status: "picking",
      deadline: now + 26 * H,
      createdAt: now - 1 * D,
      notes: "SEN-MOTN reported missing at C-04; BOX-4025 partially picked.",
      items: [
        { sku: "SEN-MOTN", qty: 5, allocated: 5, picked: 0, packed: 0 },
        { sku: "BOX-4025", qty: 30, allocated: 30, picked: 10, packed: 0 },
      ],
    },
    {
      orderNumber: "ORD-3030",
      customer: "Bluepeak Distribution",
      priority: "high",
      status: "picking",
      deadline: now + 22 * H,
      createdAt: now - 20 * H,
      notes: "2 × CHG-4BAY damaged at D-06 — write-off + re-pick required.",
      items: [
        { sku: "CHG-4BAY", qty: 6, allocated: 6, picked: 0, packed: 0 },
        { sku: "CAT6-305", qty: 2, allocated: 2, picked: 0, packed: 0 },
      ],
    },
    {
      orderNumber: "ORD-3045",
      customer: "Ironbridge Supply",
      priority: "medium",
      status: "picking",
      deadline: now + 2 * D,
      createdAt: now - 18 * H,
      items: [
        { sku: "STRAP-9M", qty: 6, allocated: 6, picked: 0, packed: 0 },
        { sku: "PLT-EURO", qty: 4, allocated: 4, picked: 2, packed: 0 },
      ],
    },
    {
      orderNumber: "ORD-3050",
      customer: "Bluepeak Distribution",
      priority: "high",
      status: "picking",
      deadline: now + 16 * H,
      createdAt: now - 12 * H,
      items: [
        { sku: "CAM-4KPT", qty: 2, allocated: 2, picked: 0, packed: 0 },
        { sku: "NVR-8CH", qty: 1, allocated: 1, picked: 0, packed: 0 },
      ],
    },
    // ---- later stages ----
    {
      orderNumber: "ORD-2020",
      customer: "Vertex Retail",
      priority: "high",
      status: "picked",
      deadline: now + 8 * H,
      createdAt: now - 2 * D,
      items: [
        { sku: "CAM-4KPT", qty: 3, allocated: 3, picked: 3, packed: 0 },
        { sku: "NVR-8CH", qty: 1, allocated: 1, picked: 1, packed: 0 },
      ],
    },
    {
      orderNumber: "ORD-2035",
      customer: "Northgate Logistics",
      priority: "medium",
      status: "packed",
      deadline: now + 15 * H,
      createdAt: now - 2 * D,
      items: [
        { sku: "SEN-THRM", qty: 8, allocated: 8, picked: 8, packed: 8 },
        { sku: "PSU-65W", qty: 5, allocated: 5, picked: 5, packed: 5 },
      ],
    },
    {
      orderNumber: "ORD-2040",
      customer: "Metroline Wholesale",
      priority: "low",
      status: "qc",
      deadline: now + 2 * D,
      createdAt: now - 3 * D,
      items: [
        { sku: "BOX-6010", qty: 60, allocated: 60, picked: 60, packed: 60 },
        { sku: "TAPE-48", qty: 12, allocated: 12, picked: 12, packed: 12 },
      ],
    },
    {
      orderNumber: "ORD-2050",
      customer: "Ironbridge Supply",
      priority: "high",
      status: "dispatched",
      deadline: now + 1 * D,
      createdAt: now - 4 * D,
      items: [
        { sku: "SWT-2424", qty: 4, allocated: 4, picked: 4, packed: 4 },
        { sku: "CAT6-305", qty: 3, allocated: 3, picked: 3, packed: 3 },
      ],
    },
    {
      orderNumber: "ORD-2110",
      customer: "Vertex Retail",
      priority: "high",
      status: "dispatched",
      deadline: now + 6 * H,
      createdAt: now - 5 * D,
      items: [{ sku: "BAT-LI12", qty: 2, allocated: 2, picked: 2, packed: 2 }],
    },
    // ---- fulfilled history ----
    {
      orderNumber: "ORD-2060",
      customer: "Summit Commerce",
      priority: "medium",
      status: "fulfilled",
      deadline: now - 2 * D,
      createdAt: now - 6 * D,
      items: [
        { sku: "STRAP-9M", qty: 10, allocated: 10, picked: 10, packed: 10 },
        { sku: "PLT-EURO", qty: 5, allocated: 5, picked: 5, packed: 5 },
      ],
    },
    {
      orderNumber: "ORD-2070",
      customer: "Cascade Outfitters",
      priority: "low",
      status: "fulfilled",
      deadline: now - 1 * D,
      createdAt: now - 5 * D,
      items: [{ sku: "BOX-6010", qty: 80, allocated: 80, picked: 80, packed: 80 }],
    },
    {
      orderNumber: "ORD-2080",
      customer: "Harborline Retail Co",
      priority: "medium",
      status: "fulfilled",
      deadline: now - 5 * D,
      createdAt: now - 9 * D,
      items: [{ sku: "LABL-4x6", qty: 6, allocated: 6, picked: 6, packed: 6 }],
    },
    {
      orderNumber: "ORD-2090",
      customer: "Metroline Wholesale",
      priority: "low",
      status: "fulfilled",
      deadline: now - 3 * D,
      createdAt: now - 8 * D,
      items: [{ sku: "BOX-4025", qty: 50, allocated: 50, picked: 50, packed: 50 }],
    },
    {
      orderNumber: "ORD-2130",
      customer: "Northgate Logistics",
      priority: "low",
      status: "fulfilled",
      deadline: now - 4 * D,
      createdAt: now - 10 * D,
      items: [{ sku: "BOX-6010", qty: 30, allocated: 30, picked: 30, packed: 30 }],
    },
    // ---- cancelled ----
    {
      orderNumber: "ORD-2100",
      customer: "Summit Commerce",
      priority: "medium",
      status: "cancelled",
      deadline: now + 3 * D,
      createdAt: now - 4 * D,
      notes: "Customer cancelled before picking — allocation released.",
      items: [{ sku: "SEN-MOTN", qty: 4, allocated: 4, picked: 0, packed: 0 }],
    },
  ];
}

/* ------------------------------------------------------------ tasks */

type TaskSeed = {
  orderNumber: string;
  sku: string;
  qty: number;
  picked: number;
  status: "pending" | "in_progress";
  assignee?: string;
  createdAtOffset: number;
};

const TASKS: TaskSeed[] = [
  { orderNumber: "ORD-3015", sku: "SWT-2424", qty: 2, picked: 0, status: "pending", createdAtOffset: -1 * D },
  { orderNumber: "ORD-3015", sku: "PSU-65W", qty: 10, picked: 4, status: "in_progress", assignee: "Amara Mensah", createdAtOffset: -1 * D },
  { orderNumber: "ORD-3015", sku: "STK-LBL", qty: 20, picked: 0, status: "pending", createdAtOffset: -1 * D },
  { orderNumber: "ORD-3025", sku: "SEN-MOTN", qty: 5, picked: 0, status: "pending", createdAtOffset: -22 * H },
  { orderNumber: "ORD-3025", sku: "BOX-4025", qty: 30, picked: 10, status: "in_progress", assignee: "Dana Kowalski", createdAtOffset: -22 * H },
  { orderNumber: "ORD-3030", sku: "CHG-4BAY", qty: 6, picked: 0, status: "in_progress", assignee: "Lukas Fontaine", createdAtOffset: -19 * H },
  { orderNumber: "ORD-3030", sku: "CAT6-305", qty: 2, picked: 0, status: "pending", createdAtOffset: -19 * H },
  { orderNumber: "ORD-3045", sku: "STRAP-9M", qty: 6, picked: 0, status: "pending", createdAtOffset: -17 * H },
  { orderNumber: "ORD-3045", sku: "PLT-EURO", qty: 4, picked: 2, status: "in_progress", assignee: "Priya Novak", createdAtOffset: -17 * H },
  { orderNumber: "ORD-3050", sku: "CAM-4KPT", qty: 2, picked: 0, status: "pending", createdAtOffset: -11 * H },
  { orderNumber: "ORD-3050", sku: "NVR-8CH", qty: 1, picked: 0, status: "in_progress", assignee: "Amara Mensah", createdAtOffset: -11 * H },
];

/* ------------------------------------------------------------ alerts */

type AlertSeed = {
  type: "low_stock" | "stockout" | "shortfall" | "missing_item" | "damaged_item" | "bottleneck" | "deadline_risk" | "reorder_due";
  severity: "critical" | "warning" | "info";
  title: string;
  message: string;
  suggestion: string;
  refType: "order" | "product" | "zone" | "system";
  ref: { type: "order"; orderNumber: string } | { type: "product"; sku: string } | { type: "zone"; zone: string };
  createdAtOffset: number;
};

function buildAlerts(): AlertSeed[] {
  return [
    {
      type: "shortfall", severity: "critical",
      title: "Shortfall: URG-2001",
      message: "URG-2001 (Vertex Retail) is short 10 unit(s) of WRT-8800 — 0 of 10 allocated",
      suggestion: "Reallocate 8 unit(s) of reserved stock from lower-priority orders ORD-3010 / ORD-3040, or raise an emergency PO for WRT-8800 (lead time 5d) with Meridian Micro Distributors",
      refType: "order", ref: { type: "order", orderNumber: "URG-2001" }, createdAtOffset: -1.9 * H,
    },
    {
      type: "shortfall", severity: "critical",
      title: "Shortfall: URG-2002",
      message: "URG-2002 (Metroline Wholesale) is short 8 unit(s) of BAT-LI12 — 0 of 8 allocated",
      suggestion: "No trust-safe reallocation available — raise an emergency PO for BAT-LI12 (lead time 6d) with VoltSource Energy Group",
      refType: "order", ref: { type: "order", orderNumber: "URG-2002" }, createdAtOffset: -1.4 * H,
    },
    {
      type: "stockout", severity: "critical",
      title: "Stockout: FIB-OM4",
      message: "FIB-OM4 is out of stock — 0 unit(s) on hand",
      suggestion: "Raise urgent PO (100 units) with Meridian Micro Distributors (lead time 7d)",
      refType: "product", ref: { type: "product", sku: "FIB-OM4" }, createdAtOffset: -3 * H,
    },
    {
      type: "low_stock", severity: "warning",
      title: "Low stock: RTR-2600",
      message: "RTR-2600 below reorder point — 4 of 10 on hand",
      suggestion: "Reorder 30 units with Meridian Micro Distributors (lead time 4d)",
      refType: "product", ref: { type: "product", sku: "RTR-2600" }, createdAtOffset: -5 * H,
    },
    {
      type: "low_stock", severity: "warning",
      title: "Low stock: WRT-8800",
      message: "WRT-8800 below reorder point — 10 of 15 on hand",
      suggestion: "Reorder 40 units with Meridian Micro Distributors (lead time 5d)",
      refType: "product", ref: { type: "product", sku: "WRT-8800" }, createdAtOffset: -6 * H,
    },
    {
      type: "low_stock", severity: "warning",
      title: "Low stock: SEN-THRM",
      message: "SEN-THRM below reorder point — 18 of 20 on hand",
      suggestion: "Reorder 50 units with Cascade Supply Partners (lead time 9d)",
      refType: "product", ref: { type: "product", sku: "SEN-THRM" }, createdAtOffset: -7 * H,
    },
    {
      type: "missing_item", severity: "warning",
      title: "Missing item: SEN-MOTN",
      message: "ORD-3025 (Cascade Outfitters): 1 unit of SEN-MOTN missing from bin C-04",
      suggestion: "Re-pick from C-04, then cycle-count zone C",
      refType: "order", ref: { type: "order", orderNumber: "ORD-3025" }, createdAtOffset: -21 * H,
    },
    {
      type: "damaged_item", severity: "warning",
      title: "Damaged item: CHG-4BAY",
      message: "ORD-3030 (Bluepeak Distribution): 2 units of CHG-4BAY damaged at D-06",
      suggestion: "Write off 2 units, adjust stock, re-pick from D-06",
      refType: "order", ref: { type: "order", orderNumber: "ORD-3030" }, createdAtOffset: -18 * H,
    },
    {
      type: "bottleneck", severity: "warning",
      title: "Bottleneck: zone D",
      message: "Zone D overloaded (3 open picks) while zone B has spare capacity",
      suggestion: "Move pickers from zone D to zone B",
      refType: "zone", ref: { type: "zone", zone: "D" }, createdAtOffset: -4 * H,
    },
    {
      type: "deadline_risk", severity: "warning",
      title: "Deadline risk: ORD-3015",
      message: "ORD-3015 (Vertex Retail) is due in 12h — status: picking",
      suggestion: "Expedite picking or notify Vertex Retail",
      refType: "order", ref: { type: "order", orderNumber: "ORD-3015" }, createdAtOffset: -5 * H,
    },
    {
      type: "deadline_risk", severity: "warning",
      title: "Deadline risk: ORD-4011",
      message: "ORD-4011 (Ironbridge Supply) is due in 20h — status: pending",
      suggestion: "Expedite picking or notify Ironbridge Supply",
      refType: "order", ref: { type: "order", orderNumber: "ORD-4011" }, createdAtOffset: -2 * H,
    },
    {
      type: "reorder_due", severity: "info",
      title: "Reorder due: FIB-OM4",
      message: "FIB-OM4 has 20 unit(s) of open demand with 0 on hand",
      suggestion: "Raise urgent PO (100 units) with Meridian Micro Distributors — open demand cannot be met",
      refType: "product", ref: { type: "product", sku: "FIB-OM4" }, createdAtOffset: -1 * H,
    },
  ];
}

/* ------------------------------------------------------------ shipments */

type ShipmentSeed = {
  orderNumber: string;
  carrier: string;
  tracking: string;
  status: "in_transit" | "delivered";
  dispatchedOffset: number;
  deliveredOffset?: number;
};

const SHIPMENTS: ShipmentSeed[] = [
  { orderNumber: "ORD-2050", carrier: "UPS", tracking: "1Z999AA10123456784", status: "in_transit", dispatchedOffset: -4 * H },
  { orderNumber: "ORD-2110", carrier: "FedEx", tracking: "794657123456", status: "in_transit", dispatchedOffset: -2 * H },
  { orderNumber: "ORD-2060", carrier: "DHL", tracking: "JD0146000034567890", status: "delivered", dispatchedOffset: -4 * D, deliveredOffset: -3 * D },
  { orderNumber: "ORD-2070", carrier: "UPS", tracking: "1Z999AA10123456700", status: "delivered", dispatchedOffset: -1 * D - 4 * H, deliveredOffset: -1 * D - 2 * H },
  { orderNumber: "ORD-2080", carrier: "DHL", tracking: "JD0146000034567891", status: "delivered", dispatchedOffset: -5 * D - 6 * H, deliveredOffset: -5 * D - 4 * H },
  { orderNumber: "ORD-2090", carrier: "FedEx", tracking: "794657123457", status: "delivered", dispatchedOffset: -3 * D - 4 * H, deliveredOffset: -3 * D - 2 * H },
  { orderNumber: "ORD-2130", carrier: "UPS", tracking: "1Z999AA10123456701", status: "delivered", dispatchedOffset: -4 * D - 5 * H, deliveredOffset: -4 * D - 3 * H },
];

/* ------------------------------------------------------------ the mutation */

/** Read-only marker so the shell knows seeding state before running mutations. */
export const isSeeded = query({
  args: {},
  handler: async (ctx) => {
    const first = await ctx.db.query("products").first();
    return !!first;
  },
});

export const ensureSeeded = mutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const productCount = await ctx.db.query("products").first();
    if (productCount) {
      // Already seeded — refresh the URG-2002 protection history if it has
      // aged out of the 24h strike window, so the demo dilemma still holds.
      const entries = await ctx.db.query("decisionLog").collect();
      const protection = entries.filter((e) =>
        e.summary.startsWith("Seeded trust event — Cascade Outfitters"),
      );
      const oldest = protection.reduce<number | null>(
        (min, e) => (min === null || e.createdAt < min ? e.createdAt : min),
        null,
      );
      if (oldest !== null && now - oldest > 12 * H) {
        for (const e of protection) {
          await ctx.db.delete(e._id);
        }
        await insertCascadeProtection(ctx, now);
      }
      return { seeded: true, refreshed: oldest !== null && now - oldest > 12 * H };
    }

    /* ---- products ---- */
    const productIds = new Map<string, Id<"products">>();
    for (const p of PRODUCTS) {
      const id = await ctx.db.insert("products", p);
      productIds.set(p.sku, id);
    }

    /* ---- orders ---- */
    const orderIds = new Map<string, Id<"orders">>();
    for (const o of buildOrders(now)) {
      const items = o.items.map((item) => {
        const product = PRODUCTS.find((p) => p.sku === item.sku)!;
        return {
          productId: productIds.get(item.sku)!,
          sku: item.sku,
          name: product.name,
          qty: item.qty,
          allocated: item.allocated,
          picked: item.picked,
          packed: item.packed,
          price: product.price,
        };
      });
      const id = await ctx.db.insert("orders", {
        orderNumber: o.orderNumber,
        customer: o.customer,
        priority: o.priority,
        status: o.status,
        items,
        deadline: o.deadline,
        createdAt: o.createdAt,
        updatedAt: o.createdAt,
        notes: o.notes,
        isDemoScenario: o.isDemoScenario,
      });
      orderIds.set(o.orderNumber, id);
    }

    /* ---- picking tasks ---- */
    for (const t of TASKS) {
      const product = PRODUCTS.find((p) => p.sku === t.sku)!;
      await ctx.db.insert("pickingTasks", {
        orderId: orderIds.get(t.orderNumber)!,
        productId: productIds.get(t.sku)!,
        sku: t.sku,
        name: product.name,
        zone: product.zone,
        bin: product.bin,
        qty: t.qty,
        picked: t.picked,
        status: t.status,
        assignee: t.assignee,
        createdAt: now + t.createdAtOffset,
        updatedAt: now + t.createdAtOffset,
      });
    }

    /* ---- alerts ---- */
    for (const a of buildAlerts()) {
      let refId: string | undefined;
      if (a.ref.type === "order") refId = orderIds.get(a.ref.orderNumber);
      else if (a.ref.type === "product") refId = productIds.get(a.ref.sku);
      else refId = a.ref.zone;
      const dedupeKey =
        a.ref.type === "order"
          ? `${a.type}:${refId}`
          : a.ref.type === "product"
            ? `${a.type}:${refId}`
            : `${a.type}:zone:${a.ref.zone}`;
      await ctx.db.insert("alerts", {
        type: a.type,
        severity: a.severity,
        status: "open",
        title: a.title,
        message: a.message,
        suggestion: a.suggestion,
        refType: a.refType,
        refId,
        dedupeKey,
        createdAt: now + a.createdAtOffset,
      });
    }

    /* ---- shipments ---- */
    for (const s of SHIPMENTS) {
      await ctx.db.insert("shipments", {
        orderId: orderIds.get(s.orderNumber)!,
        carrier: s.carrier,
        tracking: s.tracking,
        status: s.status,
        dispatchedAt: now + s.dispatchedOffset,
        deliveredAt: s.deliveredOffset !== undefined ? now + s.deliveredOffset : undefined,
      });
    }

    /* ---- decisionLog ---- */
    // trust history for Cascade Outfitters — 3 donor_raided in the last 24h +
    // older misses/partials bring the score below the 40-point floor (§8).
    await insertCascadeProtection(ctx, now);

    await ctx.db.insert("decisionLog", {
      kind: "fulfillment",
      summary: "Delivered ORD-2060 (fulfilled early)",
      outcome: "DHL / JD0146000034567890 delivered to Summit Commerce — 24h before deadline",
      customer: "Summit Commerce",
      refId: orderIds.get("ORD-2060"),
      trustEvent: "fulfilled_early",
      createdAt: now - 3 * D,
    });
    await ctx.db.insert("decisionLog", {
      kind: "fulfillment",
      summary: "Delivered ORD-2070 (fulfilled on time)",
      outcome: "UPS / 1Z999AA10123456700 delivered to Cascade Outfitters — within deadline",
      customer: "Cascade Outfitters",
      refId: orderIds.get("ORD-2070"),
      trustEvent: "fulfilled_on_time",
      createdAt: now - 1 * D - 2 * H,
    });
    await ctx.db.insert("decisionLog", {
      kind: "fulfillment",
      summary: "Delivered ORD-2080 (fulfilled on time)",
      outcome: "DHL / JD0146000034567891 delivered to Harborline Retail Co — within deadline",
      customer: "Harborline Retail Co",
      refId: orderIds.get("ORD-2080"),
      trustEvent: "fulfilled_on_time",
      createdAt: now - 5 * D - 4 * H,
    });
    await ctx.db.insert("decisionLog", {
      kind: "fulfillment",
      summary: "Delivered ORD-2090 (fulfilled on time)",
      outcome: "FedEx / 794657123457 delivered to Metroline Wholesale — within deadline",
      customer: "Metroline Wholesale",
      refId: orderIds.get("ORD-2090"),
      trustEvent: "fulfilled_on_time",
      createdAt: now - 3 * D - 2 * H,
    });
    await ctx.db.insert("decisionLog", {
      kind: "fulfillment",
      summary: "Delivered ORD-2130 (fulfilled on time)",
      outcome: "UPS / 1Z999AA10123456701 delivered to Northgate Logistics — within deadline",
      customer: "Northgate Logistics",
      refId: orderIds.get("ORD-2130"),
      trustEvent: "fulfilled_on_time",
      createdAt: now - 4 * D - 3 * H,
    });
    // Cascade Outfitters — historical misses & partials (older than 24h)
    await ctx.db.insert("decisionLog", {
      kind: "fulfillment",
      summary: "Delivered late (deadline missed) — Cascade Outfitters",
      outcome: "2h past deadline on a restocking order",
      customer: "Cascade Outfitters",
      refId: orderIds.get("ORD-2070"),
      trustEvent: "deadline_missed",
      createdAt: now - 4 * D,
    });
    await ctx.db.insert("decisionLog", {
      kind: "fulfillment",
      summary: "Delivered late (deadline missed) — Cascade Outfitters",
      outcome: "5h past deadline on a bulk box order",
      customer: "Cascade Outfitters",
      refId: orderIds.get("ORD-2070"),
      trustEvent: "deadline_missed",
      createdAt: now - 8 * D,
    });
    await ctx.db.insert("decisionLog", {
      kind: "fulfillment",
      summary: "Partially fulfilled — Cascade Outfitters",
      outcome: "3 of 8 units shipped, remainder backordered",
      customer: "Cascade Outfitters",
      refId: orderIds.get("ORD-2070"),
      trustEvent: "partial_fulfilled",
      createdAt: now - 5 * D,
    });
    await ctx.db.insert("decisionLog", {
      kind: "fulfillment",
      summary: "Partially fulfilled — Cascade Outfitters",
      outcome: "half a pallet short on a seasonal order",
      customer: "Cascade Outfitters",
      refId: orderIds.get("ORD-2070"),
      trustEvent: "partial_fulfilled",
      createdAt: now - 9 * D,
    });

    // operational history
    await ctx.db.insert("decisionLog", {
      kind: "allocation",
      summary: "Allocation wave executed",
      detail: "14 order(s) processed, 10 fully allocated, 2 partially allocated, 2 blocked.",
      outcome: "10 allocated · 2 flagged · 2 blocked",
      createdAt: now - 2 * H,
    });
    await ctx.db.insert("decisionLog", {
      kind: "reorder",
      summary: "Reorder triggered: FIB-OM4",
      detail: "0 on hand, reorder point 25",
      outcome: "PO raised for 100 units with Meridian Micro Distributors (lead time 7d)",
      refId: productIds.get("FIB-OM4"),
      createdAt: now - 1 * H,
    });
    await ctx.db.insert("decisionLog", {
      kind: "priority",
      summary: "Priority updated: ORD-4025 raised to High",
      outcome: "Time-critical switch order protected ahead of the 9h deadline",
      refId: orderIds.get("ORD-4025"),
      createdAt: now - 2.5 * H,
    });
    await ctx.db.insert("decisionLog", {
      kind: "exception",
      summary: "Reallocation withheld for URG-2002",
      detail: "Only trust-protected or unprofitable donors hold reserved BAT-LI12",
      outcome: "reallocation withheld — no profit-positive, trust-safe donor",
      customer: "Metroline Wholesale",
      refId: orderIds.get("URG-2002"),
      createdAt: now - 30 * 60_000,
    });
    await ctx.db.insert("decisionLog", {
      kind: "restock",
      summary: "Stock received: STRAP-9M +20",
      outcome: "STRAP-9M on hand is now 42 (was 22)",
      refId: productIds.get("STRAP-9M"),
      createdAt: now - 1 * D,
    });

    return { seeded: true, refreshed: false };
  },
});

/**
 * Seeded donor_raided history for Cascade Outfitters — 3 strikes within the
 * last 24h (§8): makes `isDonorEligible` return false for them at seed time,
 * so URG-2002's reallocation is withheld without any manual setup. Re-inserted
 * fresh by `ensureSeeded` if the strikes age out of the 24h window.
 */
async function insertCascadeProtection(ctx: MutationCtx, now: number): Promise<void> {
  for (const offset of [-3 * H, -8 * H, -20 * H]) {
    await ctx.db.insert("decisionLog", {
      kind: "reallocation",
      summary: "Seeded trust event — Cascade Outfitters (donor_raided)",
      detail: "Historical reallocation drew reserved BAT-LI12 from ORD-5010",
      outcome: `5 unit(s) of BAT-LI12 moved from ORD-5010 (Cascade Outfitters) to a higher-priority order`,
      customer: "Cascade Outfitters",
      trustEvent: "donor_raided",
      createdAt: now + offset,
    });
  }
}
