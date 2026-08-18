import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { SeverityBadge, AlertTypeBadge } from "@/components/warehouse/badges";
import { fmtCurrency, fmtNumber, fmtSignedMoney } from "@/lib/format";
import { motion } from "framer-motion";
import { Link } from "react-router";
import { ArrowUpRight, ShieldAlert } from "lucide-react";
import { cn } from "@/lib/utils";

export default function Overview() {
  const data = useQuery(api.analytics.overview);

  if (!data) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-28 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  const { kpis, funnel, stockHealth, zoneLoad, topShortfalls, latestAlerts, trustSummary } = data;
  const maxFunnel = Math.max(1, ...funnel.map((f) => f.count));
  const maxZone = Math.max(1, ...zoneLoad.map((z) => z.open));

  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.35 }} className="space-y-8">
      {/* ------------------------------------------------ KPI cards */}
      <div className="grid grid-cols-2 gap-px border border-border/70 bg-border/40 sm:grid-cols-3 xl:grid-cols-5">
        <Kpi label="Open orders" value={fmtNumber(kpis.openOrders)} note={`${kpis.atRiskOrders} at risk <24h`} accent={kpis.atRiskOrders > 0 ? "text-amber-300" : undefined} />
        <Kpi label="On-time fulfillment" value={`${kpis.onTimeFulfillmentPct}%`} note="trailing 30 days" />
        <Kpi label="Picking backlog" value={fmtNumber(kpis.pickingBacklog)} note="pending + in progress" />
        <Kpi label="Shortfall SKUs" value={fmtNumber(kpis.shortfallSkus)} note="unmet demand" accent={kpis.shortfallSkus > 0 ? "text-swissred" : undefined} />
        <Kpi label="Revenue at risk" value={fmtCurrency(kpis.revenueAtRisk)} note="unfilled open demand" accent={kpis.revenueAtRisk > 0 ? "text-amber-300" : undefined} />
        <Kpi label="Open exceptions" value={fmtNumber(kpis.openExceptions)} note="alerts awaiting action" accent={kpis.openExceptions > 0 ? "text-swissred" : undefined} />
        <Kpi label="Awaiting dispatch" value={fmtNumber(kpis.awaitingDispatch)} note="orders in QC" />
        <Kpi
          label="Captured vs FIFO"
          value={fmtSignedMoney(kpis.revenueCapturedVsFifo.delta)}
          note="score-ordered vs naive FIFO"
          accent="text-emerald-300"
        />
        <Kpi
          label="Customer Trust Index"
          value={fmtNumber(trustSummary.averageTrust)}
          note={
            trustSummary.belowFloor.length > 0
              ? `${trustSummary.belowFloor.length} protected (<40)`
              : "no customers below floor"
          }
          accent={trustSummary.belowFloor.length > 0 ? "text-swissred" : "text-blue-300"}
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        {/* ------------------------------------------------ pipeline funnel */}
        <Card className="border-border/70 shadow-none lg:col-span-1">
          <CardHeader className="pb-0">
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm font-bold uppercase tracking-[0.12em]">Pipeline funnel</CardTitle>
              <Link to="/dashboard/orders" className="flex items-center gap-1 text-xs font-bold text-swissblue hover:text-blue-300">
                Orders <ArrowUpRight className="size-3" />
              </Link>
            </div>
          </CardHeader>
          <CardContent className="space-y-2.5 pt-5">
            {funnel.map((f) => (
              <div key={f.status} className="flex items-center gap-3">
                <span className="micro-label w-24 shrink-0 normal-case" style={{ letterSpacing: "0.08em" }}>
                  {f.status}
                </span>
                <div className="h-4 flex-1 bg-muted/60">
                  <div
                    className={cn(
                      "h-full",
                      f.status === "fulfilled"
                        ? "bg-emerald-500/70"
                        : f.status === "dispatched"
                          ? "bg-slate-400/60"
                          : f.status === "pending" || f.status === "review"
                            ? "bg-amber-500/70"
                            : "bg-swissblue/70",
                    )}
                    style={{ width: `${(f.count / maxFunnel) * 100}%` }}
                  />
                </div>
                <span className="tnum w-6 text-right text-sm font-bold">{f.count}</span>
              </div>
            ))}
          </CardContent>
        </Card>

        {/* ------------------------------------------------ stock health + zone load */}
        <Card className="border-border/70 shadow-none">
          <CardHeader className="pb-0">
            <CardTitle className="text-sm font-bold uppercase tracking-[0.12em]">Stock health</CardTitle>
          </CardHeader>
          <CardContent className="pt-5">
            <div className="flex h-6 w-full">
              <div className="flex items-center justify-center bg-emerald-500/70" style={{ flexGrow: stockHealth.healthy }} title="Healthy">
                <span className="tnum px-2 text-[11px] font-bold text-black">{stockHealth.healthy > 0 ? stockHealth.healthy : ""}</span>
              </div>
              <div className="flex items-center justify-center bg-amber-500/70" style={{ flexGrow: stockHealth.low }} title="Low">
                <span className="tnum px-2 text-[11px] font-bold text-black">{stockHealth.low > 0 ? stockHealth.low : ""}</span>
              </div>
              <div className="flex items-center justify-center bg-swissred" style={{ flexGrow: stockHealth.out }} title="Out">
                <span className="tnum px-2 text-[11px] font-bold text-white">{stockHealth.out > 0 ? stockHealth.out : ""}</span>
              </div>
            </div>
            <div className="mt-4 space-y-3">
              <div className="flex items-center justify-between text-xs">
                <span className="text-muted-foreground"><span className="mr-2 inline-block size-2 bg-emerald-500/70" />Healthy</span>
                <span className="tnum font-bold">{stockHealth.healthy}</span>
              </div>
              <div className="flex items-center justify-between text-xs">
                <span className="text-muted-foreground"><span className="mr-2 inline-block size-2 bg-amber-500/70" />Below reorder point</span>
                <span className="tnum font-bold">{stockHealth.low}</span>
              </div>
              <div className="flex items-center justify-between text-xs">
                <span className="text-muted-foreground"><span className="mr-2 inline-block size-2 bg-swissred" />Out of stock</span>
                <span className="tnum font-bold">{stockHealth.out}</span>
              </div>
            </div>

            <div className="mt-8">
              <p className="micro-label mb-4">Zone load — open picks</p>
              <div className="space-y-2.5">
                {zoneLoad.length === 0 && <p className="text-xs text-muted-foreground">No open picking tasks.</p>}
                {zoneLoad.map((z) => (
                  <div key={z.zone} className="flex items-center gap-3">
                    <span className="mono w-8 text-xs font-bold text-swissblue">Zone {z.zone}</span>
                    <div className="h-3.5 flex-1 bg-muted/60">
                      <div className="h-full bg-swissblue/70" style={{ width: `${(z.open / maxZone) * 100}%` }} />
                    </div>
                    <span className="tnum text-xs text-muted-foreground">
                      {z.open} · {z.activePickers} picker{z.activePickers === 1 ? "" : "s"}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </CardContent>
        </Card>

        {/* ------------------------------------------------ shortfalls + trust */}
        <Card className="border-border/70 shadow-none">
          <CardHeader className="pb-0">
            <CardTitle className="text-sm font-bold uppercase tracking-[0.12em]">Top shortfalls</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4 pt-5">
            {topShortfalls.length === 0 && <p className="text-xs text-muted-foreground">No shortfalls — all open demand is covered.</p>}
            {topShortfalls.map((s) => (
              <div key={s.sku} className="flex items-center justify-between border-b border-border/40 pb-3">
                <div>
                  <p className="mono text-xs font-bold">{s.sku}</p>
                  <p className="text-[11px] text-muted-foreground">{s.name}</p>
                </div>
                <div className="text-right">
                  <p className="tnum text-sm font-bold text-swissred">−{s.unfilled}</p>
                  <p className="tnum text-[11px] text-muted-foreground">{fmtCurrency(s.unfilled * s.price)} at risk</p>
                </div>
              </div>
            ))}

            <div className="pt-2">
              <p className="micro-label mb-3">Customer trust</p>
              <div className="flex items-center justify-between rounded-none border border-swissblue/30 bg-swissblue/5 px-4 py-3">
                <div>
                  <p className="text-xs font-bold">Trust Index</p>
                  <p className="text-[11px] text-muted-foreground">avg across active customers</p>
                </div>
                <p className="tnum text-2xl font-bold text-blue-300">{trustSummary.averageTrust}</p>
              </div>
              {trustSummary.belowFloor.length > 0 && (
                <div className="mt-3 flex items-start gap-2 border border-swissred/30 bg-swissred/5 px-4 py-3">
                  <ShieldAlert className="mt-0.5 size-3.5 shrink-0 text-red-300" />
                  <div>
                    <p className="text-xs font-bold text-red-300">Trust-protected</p>
                    {trustSummary.belowFloor.map((c) => (
                      <p key={c.customer} className="text-[11px] text-muted-foreground">
                        {c.customer} — score {c.score} (below 40 floor)
                      </p>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* ------------------------------------------------ latest exceptions */}
      <Card className="border-border/70 shadow-none">
        <CardHeader className="pb-0">
          <div className="flex items-center justify-between">
            <CardTitle className="text-sm font-bold uppercase tracking-[0.12em]">Latest exceptions</CardTitle>
            <Link to="/dashboard/crisis" className="flex items-center gap-1 text-xs font-bold text-swissblue hover:text-blue-300">
              Crisis Mode <ArrowUpRight className="size-3" />
            </Link>
          </div>
        </CardHeader>
        <CardContent className="pt-5">
          <div className="grid gap-px border border-border/70 bg-border/40 sm:grid-cols-2">
            {latestAlerts.map((a) => (
              <div key={a._id} className="bg-card p-4">
                <div className="flex items-center gap-2">
                  <SeverityBadge severity={a.severity} />
                  <AlertTypeBadge type={a.type} />
                </div>
                <p className="mt-3 text-[13px] leading-5 font-semibold">{a.message}</p>
                <p className="mt-1.5 text-xs leading-5 text-muted-foreground">{a.suggestion}</p>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </motion.div>
  );
}

function Kpi({
  label,
  value,
  note,
  accent,
}: {
  label: string;
  value: string;
  note: string;
  accent?: string;
}) {
  return (
    <div className="bg-card p-5">
      <p className="micro-label">{label}</p>
      <p className={cn("tnum mt-3 text-2xl font-bold tracking-tight md:text-[28px]", accent ?? "text-foreground")}>
        {value}
      </p>
      <p className="mt-1.5 text-[11px] leading-4 text-muted-foreground">{note}</p>
    </div>
  );
}
