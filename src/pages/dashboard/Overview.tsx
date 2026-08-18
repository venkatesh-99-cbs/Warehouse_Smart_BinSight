import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { computeReserved, OPEN_ORDER_STATUSES, PRIORITY_LABEL, type Priority } from "@/convex/domain";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { AlertTypeBadge, SeverityBadge, statusLabel } from "@/components/warehouse/badges";
import {
  ActivityCategoryBadge,
  ActivityIcon,
  fmtActivityTime,
  humanizeEvent,
  severityDot,
  type ActivityDoc,
} from "@/components/warehouse/ActivityBits";
import { fmtCurrency, fmtDeadline, fmtNumber, fmtSignedMoney } from "@/lib/format";
import { motion } from "framer-motion";
import { Link } from "react-router";
import { Activity, ArrowUpRight, Boxes, Lightbulb, PackageX, ShieldAlert, TrendingUp } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

const TOOLTIP_STYLE = {
  background: "var(--popover)",
  border: "1px solid var(--border)",
  borderRadius: 0,
  color: "var(--foreground)",
  fontSize: 12,
} as const;

const AXIS_TICK = { fill: "var(--muted-foreground)", fontSize: 10 } as const;

export default function Overview() {
  const data = useQuery(api.analytics.overview);
  const products = useQuery(api.analytics.listProducts);
  const orders = useQuery(api.analytics.listOrders);
  const decisionLog = useQuery(api.analytics.listDecisionLog);
  const recent = useQuery(api.activities.listActivities, { limit: 6 });

  if (!data || !products || !orders || !decisionLog || !recent) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-28 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  const { kpis, funnel, stockHealth, zoneLoad, topShortfalls, latestAlerts, trustSummary } = data;
  const now = Date.now();
  const open = orders.filter((o) => OPEN_ORDER_STATUSES.includes(o.status));
  const overdue = open.filter((o) => o.deadline < now).length;
  const moving = open.filter((o) => o.status !== "pending" && o.status !== "review");
  const pipelineUtilization = open.length > 0 ? Math.round((moving.length / open.length) * 100) : 100;

  /* ---- chart data (all derived from live state) ---- */
  const statusData = funnel.filter((f) => f.count > 0).map((f) => ({ status: statusLabel(f.status), count: f.count }));
  const priorityData = (["urgent", "high", "medium", "low"] as Priority[])
    .map((p) => ({ priority: PRIORITY_LABEL[p], value: open.filter((o) => o.priority === p).length }))
    .filter((d) => d.value > 0);

  const stockHealthData = [
    { name: "Healthy", value: stockHealth.healthy, color: "var(--chart-4)" },
    { name: "Below reorder point", value: stockHealth.low, color: "var(--chart-3)" },
    { name: "Out of stock", value: stockHealth.out, color: "var(--color-swissred)" },
  ].filter((d) => d.value > 0);

  const zoneStock = products.reduce<Record<string, { reserved: number; available: number }>>((acc, p) => {
    const entry = acc[p.zone] ?? { reserved: 0, available: 0 };
    const reserved = computeReserved(p._id, orders);
    entry.reserved += reserved;
    entry.available += Math.max(0, p.onHand - reserved);
    acc[p.zone] = entry;
    return acc;
  }, {});
  const zoneStockData = Object.entries(zoneStock)
    .map(([zone, v]) => ({ zone: `Zone ${zone}`, Reserved: v.reserved, Available: v.available }))
    .sort((a, b) => b.Reserved + b.Available - (a.Reserved + a.Available));

  const days = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(now - (6 - i) * 86_400_000);
    const key = d.toISOString().slice(0, 10);
    const label = d.toLocaleDateString("en-US", { weekday: "short" });
    return {
      label,
      intake: orders.filter((o) => new Date(o.createdAt).toISOString().slice(0, 10) === key).length,
      fulfilled: decisionLog.filter(
        (e) =>
          (e.trustEvent === "fulfilled_on_time" || e.trustEvent === "fulfilled_early") &&
          new Date(e.createdAt).toISOString().slice(0, 10) === key,
      ).length,
    };
  });

  /* ---- operational insights (§12) — every sentence from real data ---- */
  const insights: { icon: React.ReactNode; title: string; body: string }[] = [];
  const stockouts = products.filter((p) => p.onHand <= 0);
  if (stockouts.length > 0) {
    insights.push({
      icon: <PackageX className="size-4 text-swissred" />,
      title: `${stockouts[0].sku} is out of stock`,
      body: `${stockouts.length} SKU(s) have 0 units on hand${stockouts.length > 1 ? " — a PO is due" : " — raise a PO"}.`,
    });
  }
  const lowStock = products
    .filter((p) => p.onHand > 0 && p.onHand < p.reorderPoint)
    .sort((a, b) => a.onHand / a.reorderPoint - b.onHand / b.reorderPoint);
  if (lowStock.length > 0) {
    const p = lowStock[0];
    insights.push({
      icon: <TrendingUp className="size-4 text-amber-300" />,
      title: `${p.sku} may reach stockout soon`,
      body: `${p.onHand} unit(s) on hand vs a ${p.reorderPoint}-unit reorder point — reorder ${p.reorderQty} units from ${p.supplier}.`,
    });
  }
  if (zoneLoad.length > 0) {
    const z = zoneLoad[0];
    insights.push({
      icon: <Activity className="size-4 text-blue-300" />,
      title: `Zone ${z.zone} is the largest picking bottleneck`,
      body: `${z.open} open pick(s)${z.activePickers > 0 ? ` with ${z.activePickers} picker(s) assigned` : ""} — rebalance pickers from quieter zones.`,
    });
  }
  const atRiskSoon = open
    .filter((o) => (o.deadline - now) / 3_600_000 < 24)
    .sort((a, b) => a.deadline - b.deadline);
  if (atRiskSoon.length > 0) {
    const o = atRiskSoon[0];
    insights.push({
      icon: <Activity className="size-4 text-amber-300" />,
      title: `${o.orderNumber} is due ${fmtDeadline(o.deadline, now)}`,
      body: `Status: ${statusLabel(o.status)} — ${o.customer}. ${atRiskSoon.length > 1 ? `${atRiskSoon.length - 1} more order(s) also inside the 24h window.` : "Expedite picking to protect the deadline."}`,
    });
  }
  if (kpis.revenueCapturedVsFifo.delta > 0) {
    insights.push({
      icon: <TrendingUp className="size-4 text-emerald-300" />,
      title: "Score-ordered allocation beats FIFO",
      body: `The priority engine captures ${fmtSignedMoney(kpis.revenueCapturedVsFifo.delta)} more revenue than naive FIFO ordering.`,
    });
  }
  if (trustSummary.belowFloor.length > 0) {
    insights.push({
      icon: <ShieldAlert className="size-4 text-swissred" />,
      title: "Trust-protected customers",
      body: `${trustSummary.belowFloor.map((c) => c.customer).join(", ")} sit below the 40-point floor and must not be raided.`,
    });
  }
  if (insights.length === 0) {
    insights.push({
      icon: <Boxes className="size-4 text-emerald-300" />,
      title: "Warehouse is running smoothly",
      body: "No stockouts, no low-stock pressure, no deadline risks inside 24h.",
    });
  }

  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.35 }} className="space-y-8">
      {/* ================================================ TODAY'S WAREHOUSE HEALTH */}
      <section>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="micro-label">Today's warehouse health</h2>
          <span className="text-[10px] text-muted-foreground">{new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}</span>
        </div>
        <div className="grid grid-cols-2 gap-px border border-border/70 bg-border/40 sm:grid-cols-3 xl:grid-cols-6">
          <Kpi label="Fulfillment rate" value={`${kpis.onTimeFulfillmentPct}%`} note="on-time, trailing 30 days" />
          <Kpi label="Orders at risk" value={fmtNumber(kpis.atRiskOrders)} note="due inside 24h" accent={kpis.atRiskOrders > 0 ? "text-amber-300" : undefined} />
          <Kpi
            label="Inventory health"
            value={`${Math.round((stockHealth.healthy / Math.max(1, stockHealth.total)) * 100)}%`}
            note={`${stockHealth.healthy} healthy · ${stockHealth.low} low · ${stockHealth.out} out`}
          />
          <Kpi label="Delayed orders" value={fmtNumber(overdue)} note="past their deadline" accent={overdue > 0 ? "text-swissred" : undefined} />
          <Kpi label="Critical issues" value={fmtNumber(kpis.openExceptions)} note="alerts awaiting action" accent={kpis.openExceptions > 0 ? "text-swissred" : undefined} />
          <Kpi label="Pipeline utilization" value={`${pipelineUtilization}%`} note={`${moving.length} of ${open.length} open orders moving`} />
        </div>
        <div className="mt-1 grid grid-cols-2 gap-px border border-border/70 bg-border/40 sm:grid-cols-4">
          <Kpi label="Picking backlog" value={fmtNumber(kpis.pickingBacklog)} note="pending + in progress" />
          <Kpi label="Revenue at risk" value={fmtCurrency(kpis.revenueAtRisk)} note="unfilled open demand" accent={kpis.revenueAtRisk > 0 ? "text-amber-300" : undefined} />
          <Kpi label="Captured vs FIFO" value={fmtSignedMoney(kpis.revenueCapturedVsFifo.delta)} note="score-ordered vs naive FIFO" accent="text-emerald-300" />
          <Kpi
            label="Customer trust index"
            value={fmtNumber(trustSummary.averageTrust)}
            note={trustSummary.belowFloor.length > 0 ? `${trustSummary.belowFloor.length} protected (<40)` : "no customers below floor"}
            accent={trustSummary.belowFloor.length > 0 ? "text-swissred" : "text-blue-300"}
          />
        </div>
      </section>

      {/* ================================================ OPERATIONS OVERVIEW */}
      <section>
        <h2 className="micro-label mb-3">Operations overview</h2>
        <div className="grid gap-6 lg:grid-cols-3">
          <ChartCard title="Orders by status" to="/dashboard/orders" linkLabel="Orders">
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={statusData} margin={{ top: 8, right: 8, left: -18, bottom: 0 }}>
                <CartesianGrid stroke="var(--border)" vertical={false} />
                <XAxis dataKey="status" tick={AXIS_TICK} axisLine={{ stroke: "var(--border)" }} tickLine={false} />
                <YAxis tick={AXIS_TICK} axisLine={false} tickLine={false} allowDecimals={false} />
                <Tooltip contentStyle={TOOLTIP_STYLE} cursor={{ fill: "var(--muted)" }} />
                <Bar dataKey="count" fill="var(--chart-1)" radius={[0, 0, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </ChartCard>

          <ChartCard title="Open orders by priority" to="/dashboard/orders" linkLabel="Orders">
            <div className="flex h-[220px] items-center gap-4">
              <ResponsiveContainer width="60%" height="100%">
                <PieChart>
                  <Pie data={priorityData} dataKey="value" nameKey="priority" innerRadius={52} outerRadius={78} paddingAngle={2} stroke="none">
                    {priorityData.map((d) => (
                      <Cell
                        key={d.priority}
                        fill={
                          d.priority === "Urgent" ? "var(--chart-3)" : d.priority === "High" ? "var(--chart-2)" : d.priority === "Medium" ? "var(--chart-1)" : "var(--chart-5)"
                        }
                      />
                    ))}
                  </Pie>
                  <Tooltip contentStyle={TOOLTIP_STYLE} />
                </PieChart>
              </ResponsiveContainer>
              <div className="space-y-2">
                {priorityData.map((d) => (
                  <div key={d.priority} className="flex items-center justify-between gap-4 text-xs">
                    <span className="flex items-center gap-2 text-muted-foreground">
                      <span
                        className="size-2.5"
                        style={{
                          background:
                            d.priority === "Urgent" ? "var(--chart-3)" : d.priority === "High" ? "var(--chart-2)" : d.priority === "Medium" ? "var(--chart-1)" : "var(--chart-5)",
                        }}
                      />
                      {d.priority}
                    </span>
                    <span className="tnum font-bold">{d.value}</span>
                  </div>
                ))}
              </div>
            </div>
          </ChartCard>

          <ChartCard title="Order intake vs fulfilled · 7 days" to="/dashboard/operations" linkLabel="Operations">
            <ResponsiveContainer width="100%" height={220}>
              <AreaChart data={days} margin={{ top: 8, right: 8, left: -18, bottom: 0 }}>
                <CartesianGrid stroke="var(--border)" vertical={false} />
                <XAxis dataKey="label" tick={AXIS_TICK} axisLine={{ stroke: "var(--border)" }} tickLine={false} />
                <YAxis tick={AXIS_TICK} axisLine={false} tickLine={false} allowDecimals={false} />
                <Tooltip contentStyle={TOOLTIP_STYLE} />
                <Area type="monotone" dataKey="intake" name="Orders received" stroke="var(--chart-1)" fill="var(--chart-1)" fillOpacity={0.25} strokeWidth={2} />
                <Area type="monotone" dataKey="fulfilled" name="Fulfilled on time" stroke="var(--chart-4)" fill="var(--chart-4)" fillOpacity={0.2} strokeWidth={2} />
              </AreaChart>
            </ResponsiveContainer>
          </ChartCard>
        </div>
      </section>

      {/* ================================================ INVENTORY OVERVIEW */}
      <section>
        <h2 className="micro-label mb-3">Inventory overview</h2>
        <div className="grid gap-6 lg:grid-cols-3">
          <ChartCard title="Stock health" to="/dashboard/inventory" linkLabel="Inventory">
            <div className="flex h-[220px] items-center gap-4">
              <ResponsiveContainer width="60%" height="100%">
                <PieChart>
                  <Pie data={stockHealthData} dataKey="value" nameKey="name" innerRadius={52} outerRadius={78} paddingAngle={2} stroke="none">
                    {stockHealthData.map((d) => (
                      <Cell key={d.name} fill={d.color} />
                    ))}
                  </Pie>
                  <Tooltip contentStyle={TOOLTIP_STYLE} />
                </PieChart>
              </ResponsiveContainer>
              <div className="space-y-2">
                {stockHealthData.map((d) => (
                  <div key={d.name} className="flex items-center justify-between gap-4 text-xs">
                    <span className="flex items-center gap-2 text-muted-foreground">
                      <span className="size-2.5" style={{ background: d.color }} />
                      {d.name}
                    </span>
                    <span className="tnum font-bold">{d.value}</span>
                  </div>
                ))}
              </div>
            </div>
          </ChartCard>

          <ChartCard title="Available vs reserved by zone" to="/dashboard/inventory" linkLabel="Inventory">
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={zoneStockData} margin={{ top: 8, right: 8, left: -18, bottom: 0 }}>
                <CartesianGrid stroke="var(--border)" vertical={false} />
                <XAxis dataKey="zone" tick={AXIS_TICK} axisLine={{ stroke: "var(--border)" }} tickLine={false} />
                <YAxis tick={AXIS_TICK} axisLine={false} tickLine={false} allowDecimals={false} />
                <Tooltip contentStyle={TOOLTIP_STYLE} cursor={{ fill: "var(--muted)" }} />
                <Bar dataKey="Available" stackId="a" fill="var(--chart-4)" />
                <Bar dataKey="Reserved" stackId="a" fill="var(--chart-1)" />
              </BarChart>
            </ResponsiveContainer>
          </ChartCard>

          <ChartCard title="Zone picking load" to="/dashboard/operations" linkLabel="Operations">
            {zoneLoad.length === 0 ? (
              <div className="flex h-[220px] items-center justify-center text-xs text-muted-foreground">No open picking tasks.</div>
            ) : (
              <div className="space-y-3 pt-2">
                {zoneLoad.map((z) => (
                  <div key={z.zone} className="flex items-center gap-3">
                    <span className="mono w-10 text-xs font-bold text-swissblue">Zone {z.zone}</span>
                    <div className="h-4 flex-1 bg-muted/60">
                      <div
                        className={cn("h-full", z.open >= 4 ? "bg-swissred" : z.open >= 2 ? "bg-amber-400" : "bg-emerald-500")}
                        style={{ width: `${(z.open / Math.max(1, zoneLoad[0].open)) * 100}%` }}
                      />
                    </div>
                    <span className="tnum w-16 text-right text-xs text-muted-foreground">
                      {z.open} open · {z.activePickers} picker{z.activePickers === 1 ? "" : "s"}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </ChartCard>
        </div>
      </section>

      {/* ================================================ ACTION REQUIRED */}
      <section>
        <h2 className="micro-label mb-3">Action required</h2>
        <Card className="border-border/70 shadow-none">
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
            <div className="mt-4">
              <Link to="/dashboard/crisis" className="inline-flex items-center gap-1 text-xs font-bold text-swissblue transition-colors hover:text-blue-300">
                Open Crisis Mode <ArrowUpRight className="size-3" />
              </Link>
            </div>
          </CardContent>
        </Card>
      </section>

      {/* ================================================ RECENT ACTIVITY */}
      <section>
        <h2 className="micro-label mb-3">Recent activity</h2>
        <Card className="border-border/70 shadow-none">
          <CardContent className="p-2">
            {recent.length === 0 ? (
              <p className="py-10 text-center text-xs text-muted-foreground">No activity recorded yet — run an allocation wave or resolve a crisis to see events here.</p>
            ) : (
              <ul className="divide-y divide-border/60">
                {recent.map((a) => (
                  <ActivityRow key={a._id} activity={a} />
                ))}
              </ul>
            )}
            <div className="mt-2 border-t border-border/60 px-3 pt-3">
              <Link to="/dashboard/activity" className="inline-flex items-center gap-1 text-xs font-bold text-swissblue transition-colors hover:text-blue-300">
                View all activity <ArrowUpRight className="size-3" />
              </Link>
            </div>
          </CardContent>
        </Card>
      </section>

      {/* ================================================ OPERATIONAL INSIGHTS */}
      <section>
        <h2 className="micro-label mb-3">Operational insights</h2>
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {insights.map((ins) => (
            <Card key={ins.title} className="border-border/70 shadow-none">
              <CardContent className="flex items-start gap-3 p-4">
                <span className="mt-0.5 shrink-0">{ins.icon}</span>
                <div>
                  <p className="text-[13px] font-bold">{ins.title}</p>
                  <p className="mt-1 text-xs leading-5 text-muted-foreground">{ins.body}</p>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      </section>
    </motion.div>
  );
}

/* ------------------------------------------------------------ helpers */

function ActivityRow({ activity }: { activity: ActivityDoc }) {
  return (
    <li className="flex items-center gap-3 px-3 py-2.5">
      <span className={cn("size-1.5 shrink-0 rounded-full", severityDot(activity.severity))} />
      <span className="tnum w-12 shrink-0 text-[11px] text-muted-foreground">{fmtActivityTime(activity.timestamp)}</span>
      <p className="min-w-0 flex-1 truncate text-[13px]">
        <span className="font-bold">{humanizeEvent(activity.eventType)}</span>
        <span className="text-muted-foreground"> — {activity.description}</span>
      </p>
      <span className="hidden shrink-0 items-center gap-1.5 text-[11px] text-muted-foreground sm:flex">
        <ActivityIcon category={activity.category} className="size-3.5" />
      </span>
      <ActivityCategoryBadge category={activity.category} className="hidden px-2 py-0 text-[10px] md:inline-flex" />
    </li>
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

function ChartCard({
  title,
  to,
  linkLabel,
  children,
}: {
  title: string;
  to: string;
  linkLabel: string;
  children: React.ReactNode;
}) {
  return (
    <Card className="border-border/70 shadow-none">
      <CardHeader className="pb-0">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm font-bold uppercase tracking-[0.12em]">{title}</CardTitle>
          <Link to={to} className="flex items-center gap-1 text-xs font-bold text-swissblue hover:text-blue-300">
            {linkLabel} <ArrowUpRight className="size-3" />
          </Link>
        </div>
      </CardHeader>
      <CardContent className="pt-4">{children}</CardContent>
    </Card>
  );
}
