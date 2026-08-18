/**
 * StrategyComparison.tsx — §4 Compare Strategies panel for the What-if
 * Simulator. Shows every §4 metric per strategy (fully/partially fulfilled,
 * delayed, units allocated, units remaining, backordered, stockouts,
 * fulfillment rate, picking workload, pick time, bottleneck) with a
 * fulfillment-rate bar, marks the recommended strategy, and explains the
 * selection with the exact numbers the engine produced.
 *
 * Extracted from Simulator.tsx (the file outgrew the edit tool's match
 * window); the local fmtHours/bottleneckLabel below mirror the page's tiny
 * formatters so this module stays dependency-free.
 */
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { StrategyMetrics } from "@/convex/simulator";
import { fmtNumber } from "@/lib/format";
import { cn } from "@/lib/utils";

function fmtHours(h: number): string {
  if (!Number.isFinite(h)) return "∞";
  if (h < 24) return `${h.toFixed(1)}h`;
  return `${(h / 24).toFixed(1)}d`;
}

function bottleneckLabel(level: string): string {
  if (level === "critical") return "Critical";
  if (level === "warning") return "Warning";
  return "None";
}

export function StrategyComparisonPanel({
  compare,
}: {
  compare: { strategies: StrategyMetrics[]; recommended: string; why: string };
}) {
  return (
    <Card className="border-border/70 shadow-none">
      <CardHeader className="pb-0">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm font-bold uppercase tracking-[0.12em]">Compare strategies</CardTitle>
          <Badge className="border-emerald-500/50 bg-emerald-500/15 text-emerald-300">
            Recommended: {compare.strategies.find((s) => s.strategy === compare.recommended)?.label}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="pt-5">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1160px] border-collapse text-xs">
            <thead>
              <tr className="border-b border-border/60 text-left">
                {[
                  "Strategy",
                  "Fully fulfilled",
                  "Partial",
                  "Delayed",
                  "Units allocated",
                  "Units remaining",
                  "Backordered",
                  "Stockouts",
                  "Fulfillment rate",
                  "Picking workload",
                  "Pick time",
                  "Bottleneck",
                  "Score",
                ].map((h) => (
                  <th key={h} className="micro-label px-3 py-2 font-semibold">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {compare.strategies.map((s) => (
                <tr
                  key={s.strategy}
                  className={cn(
                    "border-b border-border/40",
                    s.strategy === compare.recommended && "bg-emerald-500/5",
                  )}
                >
                  <td className="px-3 py-2.5">
                    <span className="flex items-center gap-2 font-bold">
                      {s.label}
                      {s.strategy === compare.recommended && (
                        <Badge className="border-emerald-500/50 bg-emerald-500/15 text-emerald-300 text-[9px]">BEST</Badge>
                      )}
                    </span>
                  </td>
                  <td className="tnum px-3 py-2.5">{s.fullyFulfilled}</td>
                  <td className="tnum px-3 py-2.5">{s.partiallyFulfilled}</td>
                  <td className={cn("tnum px-3 py-2.5", s.delayed > 0 && "text-amber-300")}>{s.delayed}</td>
                  <td className="tnum px-3 py-2.5">{fmtNumber(s.unitsAllocated)}</td>
                  <td className="tnum px-3 py-2.5">{fmtNumber(s.unitsRemaining)}</td>
                  <td className={cn("tnum px-3 py-2.5", s.backorderedUnits > 0 && "text-amber-300")}>{fmtNumber(s.backorderedUnits)}</td>
                  <td className={cn("tnum px-3 py-2.5", s.stockoutCount > 0 && "text-swissred")}>{s.stockoutCount}</td>
                  <td className="px-3 py-2.5">
                    <div className="flex items-center gap-2">
                      <span className="tnum font-bold">{s.fulfillmentRate}%</span>
                      <div className="h-1 w-12 bg-border/60">
                        <div
                          className={cn("h-full", s.fulfillmentRate >= 95 ? "bg-emerald-500" : s.fulfillmentRate >= 75 ? "bg-amber-500" : "bg-swissred")}
                          style={{ width: `${Math.min(100, s.fulfillmentRate)}%` }}
                        />
                      </div>
                    </div>
                  </td>
                  <td className="tnum px-3 py-2.5">{fmtNumber(s.pickingWorkload)}</td>
                  <td className="tnum px-3 py-2.5">{fmtHours(s.pickHours)}</td>
                  <td className={cn("px-3 py-2.5", s.bottleneckLevel === "critical" ? "text-swissred" : s.bottleneckLevel === "warning" ? "text-amber-300" : "text-emerald-300")}>
                    {bottleneckLabel(s.bottleneckLevel)}
                  </td>
                  <td className="tnum px-3 py-2.5 font-bold">{s.score}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-4 border-l-2 border-swissblue pl-4 text-xs leading-6 text-muted-foreground">{compare.why}</p>
      </CardContent>
    </Card>
  );
}
