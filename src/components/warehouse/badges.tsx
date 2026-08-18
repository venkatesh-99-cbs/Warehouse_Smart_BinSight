/**
 * badges.tsx — one source of truth for status/priority/severity/health/trust
 * label + color. Swiss palette: red critical/primary, blue informational,
 * amber warning, emerald healthy, neutral gray.
 */
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import {
  ALERT_SEVERITIES,
  ALERT_TYPE_META,
  ORDER_STATUSES,
  PRIORITIES,
  PRIORITY_LABEL,
  type AlertSeverity,
  type AlertType,
  type OrderStatus,
  type Priority,
} from "@/convex/domain";

/* ------------------------------------------------------------ status */

const STATUS_STYLE: Record<OrderStatus, string> = {
  pending: "border-slate-500/40 bg-slate-500/10 text-slate-300",
  review: "border-amber-500/40 bg-amber-500/10 text-amber-300",
  allocated: "border-swissblue/40 bg-swissblue/10 text-blue-300",
  picking: "border-swissblue/50 bg-swissblue/15 text-blue-200",
  picked: "border-swissblue/40 bg-swissblue/10 text-blue-300",
  packed: "border-sky-500/40 bg-sky-500/10 text-sky-300",
  qc: "border-violet-500/40 bg-violet-500/10 text-violet-300",
  dispatched: "border-slate-400/40 bg-slate-400/10 text-slate-300",
  fulfilled: "border-emerald-500/40 bg-emerald-500/10 text-emerald-300",
  cancelled: "border-red-500/40 bg-red-500/10 text-red-300",
};

const STATUS_LABEL: Record<OrderStatus, string> = {
  pending: "Pending",
  review: "Review",
  allocated: "Allocated",
  picking: "Picking",
  picked: "Picked",
  packed: "Packed",
  qc: "QC",
  dispatched: "Dispatched",
  fulfilled: "Fulfilled",
  cancelled: "Cancelled",
};

export function StatusBadge({ status, className }: { status: OrderStatus; className?: string }) {
  return (
    <Badge className={cn(STATUS_STYLE[status], className)}>{STATUS_LABEL[status]}</Badge>
  );
}

export function statusLabel(status: OrderStatus): string {
  return STATUS_LABEL[status];
}

/* ------------------------------------------------------------ priority */

const PRIORITY_STYLE: Record<Priority, string> = {
  urgent: "border-swissred bg-swissred text-white",
  high: "border-orange-500/50 bg-orange-500/15 text-orange-300",
  medium: "border-blue-500/50 bg-blue-500/15 text-blue-300",
  low: "border-slate-500/40 bg-slate-500/10 text-slate-300",
};

export function PriorityBadge({ priority, className }: { priority: Priority; className?: string }) {
  return (
    <Badge className={cn(PRIORITY_STYLE[priority], className)}>
      {PRIORITY_LABEL[priority]}
    </Badge>
  );
}

/* ------------------------------------------------------------ severity */

const SEVERITY_STYLE: Record<AlertSeverity, string> = {
  critical: "border-swissred bg-swissred/15 text-red-300",
  warning: "border-amber-500/50 bg-amber-500/15 text-amber-300",
  info: "border-swissblue/50 bg-swissblue/15 text-blue-300",
};

const SEVERITY_LABEL: Record<AlertSeverity, string> = {
  critical: "Critical",
  warning: "Warning",
  info: "Info",
};

export function SeverityBadge({ severity, className }: { severity: AlertSeverity; className?: string }) {
  return (
    <Badge className={cn(SEVERITY_STYLE[severity], className)}>{SEVERITY_LABEL[severity]}</Badge>
  );
}

/* ------------------------------------------------------------ alert type */

export function AlertTypeBadge({ type, className }: { type: AlertType; className?: string }) {
  return <Badge variant="outline" className={cn("uppercase", className)}>{ALERT_TYPE_META[type].label}</Badge>;
}

/* ------------------------------------------------------------ stock health */

export type StockHealth = "ok" | "low" | "out";

const HEALTH_STYLE: Record<StockHealth, string> = {
  ok: "border-emerald-500/40 bg-emerald-500/10 text-emerald-300",
  low: "border-amber-500/40 bg-amber-500/10 text-amber-300",
  out: "border-swissred bg-swissred/15 text-red-300",
};

const HEALTH_LABEL: Record<StockHealth, string> = { ok: "OK", low: "Low", out: "Out" };

export function HealthBadge({ health, className }: { health: StockHealth; className?: string }) {
  return <Badge className={cn(HEALTH_STYLE[health], className)}>{HEALTH_LABEL[health]}</Badge>;
}

export function healthFor(onHand: number, reorderPoint: number): StockHealth {
  if (onHand <= 0) return "out";
  if (onHand < reorderPoint) return "low";
  return "ok";
}

/* ------------------------------------------------------------ trust */

export type TrustBand = "healthy" | "watch" | "protected";

export function trustBand(score: number): TrustBand {
  if (score >= 70) return "healthy";
  if (score >= 40) return "watch";
  return "protected";
}

const TRUST_STYLE: Record<TrustBand, string> = {
  healthy: "border-emerald-500/40 bg-emerald-500/10 text-emerald-300",
  watch: "border-amber-500/40 bg-amber-500/10 text-amber-300",
  protected: "border-swissred bg-swissred/15 text-red-300",
};

const TRUST_LABEL: Record<TrustBand, string> = {
  healthy: "Healthy",
  watch: "Watch",
  protected: "Protected",
};

export function TrustBadge({ score, className }: { score: number; className?: string }) {
  return (
    <Badge className={cn(TRUST_STYLE[trustBand(score)], "tnum", className)}>
      {TRUST_LABEL[trustBand(score)]} · {score}
    </Badge>
  );
}

/* ------------------------------------------------------------ demo tag */

export function DemoTag({ className }: { className?: string }) {
  return (
    <Badge className={cn("border-orange-500/60 bg-orange-500/15 text-orange-300", className)}>
      DEMO SCENARIO
    </Badge>
  );
}

/* re-export constants so pages share the exact same value sets */
export { ALERT_SEVERITIES, ALERT_TYPE_META, ORDER_STATUSES, PRIORITIES, PRIORITY_LABEL };
