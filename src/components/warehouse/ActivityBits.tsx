/**
 * ActivityBits.tsx — shared presentation helpers for the Activity Logs center
 * (page + dashboard widget). One source of truth for category labels/icons,
 * event-title humanization, severity dots and day grouping.
 */
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import {
  AlertTriangle,
  Boxes,
  ClipboardCheck,
  Scale,
  Settings,
  ShoppingCart,
  Truck,
  type LucideIcon,
} from "lucide-react";
import type { Doc } from "@/convex/_generated/dataModel";

export type ActivityCategory = Doc<"activities">["category"];
export type ActivityDoc = Doc<"activities">;

export const ACTIVITY_CATEGORY_META: Record<
  ActivityCategory,
  { label: string; icon: LucideIcon; chip: string }
> = {
  orders: { label: "Orders", icon: ShoppingCart, chip: "border-blue-500/40 bg-blue-500/10 text-blue-300" },
  inventory: { label: "Inventory", icon: Boxes, chip: "border-teal-500/40 bg-teal-500/10 text-teal-300" },
  operations: { label: "Operations", icon: ClipboardCheck, chip: "border-sky-500/40 bg-sky-500/10 text-sky-300" },
  shipments: { label: "Shipments", icon: Truck, chip: "border-slate-400/40 bg-slate-400/10 text-slate-300" },
  crisis: { label: "Crisis", icon: AlertTriangle, chip: "border-amber-500/40 bg-amber-500/10 text-amber-300" },
  decisions: { label: "Manager Decisions", icon: Scale, chip: "border-violet-500/40 bg-violet-500/10 text-violet-300" },
  system: { label: "System", icon: Settings, chip: "border-emerald-500/40 bg-emerald-500/10 text-emerald-300" },
};

export function ActivityIcon({ category, className }: { category: ActivityCategory; className?: string }) {
  const Icon = ACTIVITY_CATEGORY_META[category].icon;
  return <Icon className={className} />;
}

/** "inventory_reallocated" → "Inventory Reallocated" */
export function humanizeEvent(eventType: string): string {
  return eventType.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export function ActivityCategoryBadge({
  category,
  className,
}: {
  category: ActivityCategory;
  className?: string;
}) {
  const meta = ACTIVITY_CATEGORY_META[category];
  return (
    <Badge className={cn(meta.chip, className)}>{meta.label}</Badge>
  );
}

/** Severity → status dot color. Critical uses the deep-amber, red is reserved for severe alerts. */
export function severityDot(severity?: ActivityDoc["severity"] | null): string {
  switch (severity) {
    case "critical":
      return "bg-swissred";
    case "warning":
      return "bg-amber-400";
    default:
      return "bg-swissblue";
  }
}

export function fmtActivityTime(ts: number): string {
  return new Date(ts).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

export function dayGroupLabel(ts: number, now = Date.now()): string {
  const d = new Date(ts);
  const today = new Date(now);
  const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diffDays = (startOfDay(today) - startOfDay(d)) / 86_400_000;
  if (diffDays <= 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  return d.toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" });
}
