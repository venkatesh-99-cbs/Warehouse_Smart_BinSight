/**
 * lib/format.ts — currency, dates, durations, deadlines, and the §10.1
 * plain-language "Why?" formatter. `explainDecision` ONLY formats values that
 * the backend functions already produced (scoreOrderBreakdown / ReallocationPlan
 * / DonorPlan) — it never re-derives scoring or trust math (§10.1 / Fidelity #4).
 */
import type { DonorPlan, ReallocationPlan } from "@/convex/allocation";
import { PRIORITY_LABEL, type Priority } from "@/convex/domain";
import { fmtQty } from "@/convex/domain";

export const HOUR = 3_600_000;

/* ------------------------------------------------------------ numbers */

export function fmtCurrency(n: number): string {
  const abs = Math.abs(n);
  const options: Intl.NumberFormatOptions = {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: abs >= 1000 ? 0 : 2,
    maximumFractionDigits: abs >= 1000 ? 0 : 2,
  };
  return new Intl.NumberFormat("en-US", options).format(n);
}

export function fmtNumber(n: number): string {
  return new Intl.NumberFormat("en-US").format(n);
}

export function fmtPercent(n: number, digits = 0): string {
  return `${n.toFixed(digits)}%`;
}

export function fmtSignedMoney(n: number): string {
  const base = fmtCurrency(Math.abs(n));
  return n >= 0 ? `+${base}` : `−${base}`;
}

/* ------------------------------------------------------------ dates */

export function fmtDateTime(ts: number): string {
  return new Date(ts).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function fmtDate(ts: number): string {
  return new Date(ts).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

export function hoursToDeadline(deadline: number, now = Date.now()): number {
  return (deadline - now) / HOUR;
}

/** Relative deadline: "in 4h", "in 2d 3h", "overdue 1h". */
export function fmtDeadline(deadline: number, now = Date.now()): string {
  const hours = hoursToDeadline(deadline, now);
  if (hours < 0) {
    const h = Math.ceil(Math.abs(hours));
    if (h < 24) return `overdue ${h}h`;
    const d = Math.floor(h / 24);
    return `overdue ${d}d`;
  }
  if (hours < 24) return `in ${Math.max(0, Math.round(hours))}h`;
  const d = Math.floor(hours / 24);
  const h = Math.round(hours % 24);
  return h === 0 ? `in ${d}d` : `in ${d}d ${h}h`;
}

export function fmtAge(ts: number, now = Date.now()): string {
  const hours = Math.max(0, (now - ts) / HOUR);
  if (hours < 24) return `${Math.round(hours)}h`;
  return `${Math.floor(hours / 24)}d ${Math.round(hours % 24)}h`;
}

export function fmtDurationHours(hours: number): string {
  if (hours < 24) return `${Math.round(hours)}h`;
  return `${Math.floor(hours / 24)}d ${Math.round(hours % 24)}h`;
}

/* ------------------------------------------------------ explainability */

export type ScoringExplainInput = {
  orderNumber: string;
  priority: Priority;
  revenue: number;
  createdAt: number;
  deadline: number;
  breakdown: {
    priorityPoints: number;
    deadlineBonus: number;
    ageBonus: number;
    profitBonus: number;
    total: number;
    hoursToDeadline: number;
    ageHours: number;
  };
  next?: {
    orderNumber: string;
    score: number;
  };
};

export type ExplainKind =
  | { kind: "scoring"; data: ScoringExplainInput }
  | {
      kind: "reallocation-granted";
      data: { targetOrderNumber: string; plan: ReallocationPlan };
    }
  | {
      kind: "reallocation-withheld";
      data: { targetOrderNumber: string; plan: ReallocationPlan };
    };

/**
 * §10.1 — one pure formatter for every "Why?" disclosure. The inputs are the
 * exact numbers `scoreOrderBreakdown` / `findReallocationPlan` already
 * computed — this function only arranges them into plain English.
 */
export function explainDecision(input: ExplainKind): string {
  switch (input.kind) {
    case "scoring": {
      const d = input.data;
      const priorityLabel = PRIORITY_LABEL[d.priority];
      const scoreParts: string[] = [];
      if (d.breakdown.deadlineBonus > 0) {
        const h = Math.max(0, d.breakdown.hoursToDeadline);
        scoreParts.push(
          `+${d.breakdown.deadlineBonus} for being ${
            d.breakdown.hoursToDeadline <= 6 ? "within 6 hours" : h <= 24 ? "within 24 hours" : "within 72 hours"
          } of its deadline`,
        );
      }
      if (d.breakdown.ageBonus > 0) {
        scoreParts.push(`+${d.breakdown.ageBonus.toFixed(1)} for its age`);
      }
      if (d.breakdown.profitBonus > 0) {
        scoreParts.push(
          `+${d.breakdown.profitBonus.toFixed(1)} for its ${fmtCurrency(d.revenue)} order value (capped at 15)`,
        );
      }
      const why =
        scoreParts.length > 0
          ? ` — ${scoreParts.join(", ")}`
          : ` (${priorityLabel} priority, no deadline pressure yet)`;
      const next =
        d.next && d.next.score < d.breakdown.total
          ? ` The next order in the queue, ${d.next.orderNumber}, scored ${Math.round(d.next.score)} — ${Math.round(
              d.breakdown.total - d.next.score,
            )} points behind.`
          : "";
      return `${d.orderNumber} was allocated first because it scored ${Math.round(
        d.breakdown.total,
      )}: ${d.breakdown.priorityPoints} for ${priorityLabel} priority${why}.${next}`;
    }

    case "reallocation-granted": {
      const { plan } = input.data;
      const eligible = plan.donors.filter((d) => d.eligible);
      if (eligible.length === 0) {
        return explainDecision({ kind: "reallocation-withheld", data: input.data });
      }
      const sentences = eligible.map((donor: DonorPlan) => {
        const cost = donor.donorTrustCost;
        const gain = donor.targetGain;
        const mult = trustMultiplierLabel(donor.donorPriority);
        return `${donor.units} unit(s) were reallocated from ${donor.donorOrderNumber} to ${input.data.targetOrderNumber}. This was allowed because the gain to ${
          input.data.targetOrderNumber
        } (${fmtCurrency(gain)} of revenue protected) exceeded the trust cost of drawing from ${
          donor.donorCustomer
        } (${fmtCurrency(cost)}, at the ${PRIORITY_LABEL[donor.donorPriority]} ${mult} multiplier). That customer's trust score is now ${donor.trustAfter} — ${
          donor.trustAfter >= 40 ? "still above the 40-point protection floor" : "at the protection floor"
        }.`;
      });
      return sentences.join(" ");
    }

    case "reallocation-withheld": {
      const { plan } = input.data;
      const ineligible = plan.donors.filter((d) => !d.eligible);
      const holder = ineligible[0];
      const intro = `No reallocation was offered for ${input.data.targetOrderNumber}.`;
      if (holder) {
        const reason = holder.ineligibleReason ?? "not trust-eligible";
        return `${intro} The only order holding reserved stock for this SKU belongs to ${holder.donorCustomer} — ${reason} (trust score ${holder.trustBefore}). Reallocating again would turn this customer into a permanent buffer. Recommended action: raise an emergency PO instead.`;
      }
      return `${intro} ${plan.suggestion}`;
    }
  }
}

function trustMultiplierLabel(priority: Priority): string {
  switch (priority) {
    case "urgent":
      return "1.5×";
    case "high":
      return "1.2×";
    case "medium":
      return "1.0×";
    case "low":
      return "0.8×";
  }
}

export { fmtQty };
