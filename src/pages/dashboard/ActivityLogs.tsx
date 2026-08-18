import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Doc } from "@/convex/_generated/dataModel";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { fmtNumber } from "@/lib/format";
import { motion } from "framer-motion";
import { useMemo, useState } from "react";
import { ChevronRight, Inbox, Search } from "lucide-react";
import {
  ACTIVITY_CATEGORY_META,
  ActivityCategoryBadge,
  ActivityIcon,
  dayGroupLabel,
  fmtActivityTime,
  humanizeEvent,
  severityDot,
  type ActivityCategory,
  type ActivityDoc,
} from "@/components/warehouse/ActivityBits";

type RangeId = "today" | "yesterday" | "7d" | "30d" | "all";

const RANGES: { id: RangeId; label: string }[] = [
  { id: "today", label: "Today" },
  { id: "yesterday", label: "Yesterday" },
  { id: "7d", label: "Last 7 days" },
  { id: "30d", label: "Last 30 days" },
  { id: "all", label: "All time" },
];

const CATEGORY_FILTERS: { id?: ActivityCategory; label: string }[] = [
  { id: undefined, label: "All" },
  { id: "orders", label: "Orders" },
  { id: "inventory", label: "Inventory" },
  { id: "operations", label: "Operations" },
  { id: "shipments", label: "Shipments" },
  { id: "crisis", label: "Crisis" },
  { id: "decisions", label: "Manager Decisions" },
  { id: "system", label: "System" },
];

function computeSince(range: RangeId): number | undefined {
  const now = Date.now();
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  switch (range) {
    case "today":
      return startOfToday.getTime();
    case "yesterday":
      return startOfToday.getTime() - 86_400_000;
    case "7d":
      return now - 7 * 86_400_000;
    case "30d":
      return now - 30 * 86_400_000;
    case "all":
      return undefined;
  }
}

export default function ActivityLogs() {
  const overview = useQuery(api.activities.activityOverview);
  const [category, setCategory] = useState<ActivityCategory | undefined>(undefined);
  const [range, setRange] = useState<RangeId>("7d");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<ActivityDoc | null>(null);

  const since = useMemo(() => computeSince(range), [range]);
  const activities = useQuery(api.activities.listActivities, {
    category,
    since,
    search: search.trim() ? search.trim() : undefined,
    limit: 200,
  });

  if (!overview || !activities) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-96 w-full" />
      </div>
    );
  }

  /* group by day label, preserving newest-first order (plain computation —
     must stay below the loading gate but must NOT be a hook: the gate above
     is an early return, and conditional hook calls would crash at runtime) */
  const groups = (() => {
    const map = new Map<string, ActivityDoc[]>();
    for (const a of activities) {
      const label = dayGroupLabel(a.timestamp);
      const list = map.get(label) ?? [];
      list.push(a);
      map.set(label, list);
    }
    return Array.from(map.entries());
  })();

  const kpis = [
    { label: "Activities today", value: fmtNumber(overview.today), note: `${overview.yesterday} yesterday`, accent: undefined },
    { label: "Orders updated", value: fmtNumber(overview.orders), note: "order events today", accent: undefined },
    { label: "Inventory changes", value: fmtNumber(overview.inventory), note: "stock + reorders today", accent: undefined },
    { label: "Manager decisions", value: fmtNumber(overview.decisions), note: "approved / applied today", accent: undefined },
    { label: "System alerts", value: fmtNumber(overview.system), note: "system events today", accent: undefined },
  ];

  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.35 }} className="space-y-8">
      {/* ================================================ ACTIVITY OVERVIEW */}
      <section>
        <h2 className="micro-label mb-3">Activity overview</h2>
        <div className="grid grid-cols-2 gap-px border border-border/70 bg-border/40 sm:grid-cols-3 xl:grid-cols-5">
          {kpis.map((k) => (
            <div key={k.label} className="bg-card p-5">
              <p className="micro-label">{k.label}</p>
              <p className={cn("tnum mt-3 text-2xl font-bold tracking-tight", k.accent ?? "text-foreground")}>{k.value}</p>
              <p className="mt-1.5 text-[11px] text-muted-foreground">{k.note}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ================================================ SEARCH + FILTERS */}
      <section>
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div className="relative w-full md:max-w-sm">
            <Search className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search order, SKU, actor, event…"
              className="pl-9"
            />
          </div>
          <div className="flex flex-wrap gap-1">
            {RANGES.map((r) => (
              <Button
                key={r.id}
                type="button"
                variant={range === r.id ? "default" : "outline"}
                size="sm"
                onClick={() => setRange(r.id)}
              >
                {r.label}
              </Button>
            ))}
          </div>
        </div>
        <div className="mt-3 flex flex-wrap gap-1.5">
          {CATEGORY_FILTERS.map((c) => (
            <Button
              key={c.label}
              type="button"
              variant={category === c.id ? "secondary" : "ghost"}
              size="sm"
              onClick={() => setCategory(c.id)}
              className={cn(
                "text-xs",
                category === c.id ? "border border-primary/40 bg-primary/15 text-foreground" : "text-muted-foreground",
              )}
            >
              {c.label}
            </Button>
          ))}
        </div>
      </section>

      {/* ================================================ TIMELINE */}
      <section>
        {activities.length === 0 ? (
          <Card className="border-border/70 shadow-none">
            <CardContent className="flex flex-col items-center gap-2 py-16 text-center">
              <Inbox className="size-8 text-muted-foreground/60" />
              <p className="text-sm font-bold">No activity matches your filters</p>
              <p className="text-xs text-muted-foreground">Try a wider time range or clear the search.</p>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-6">
            {groups.map(([label, rows]) => (
              <div key={label}>
                <h3 className="micro-label mb-2">{label}</h3>
                <Card className="border-border/70 shadow-none">
                  <CardContent className="p-2">
                    <ul className="divide-y divide-border/60">
                      {rows.map((a) => (
                        <li key={a._id}>
                          <button
                            type="button"
                            onClick={() => setSelected(a)}
                            className="flex w-full items-center gap-3 px-3 py-3 text-left transition-colors hover:bg-accent/40"
                          >
                            <span
                              className={cn(
                                "flex size-8 shrink-0 items-center justify-center border",
                                ACTIVITY_CATEGORY_META[a.category].chip.split(" ")[0],
                              )}
                            >
                              <ActivityIcon category={a.category} className="size-3.5" />
                            </span>
                            <div className="min-w-0 flex-1">
                              <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                                <span className="tnum text-[11px] text-muted-foreground">{fmtActivityTime(a.timestamp)}</span>
                                <span className="text-[13px] font-bold">{humanizeEvent(a.eventType)}</span>
                                {a.severity && a.severity !== "info" && (
                                  <span className={cn("size-1.5 rounded-full", severityDot(a.severity))} title={a.severity} />
                                )}
                              </div>
                              <p className="mt-0.5 truncate text-xs text-muted-foreground">{a.description}</p>
                              <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                                <ActivityCategoryBadge category={a.category} className="px-1.5 py-0 text-[9px]" />
                                {a.sku && <Badge variant="outline" className="mono px-1.5 py-0 text-[9px] text-muted-foreground">{a.sku}</Badge>}
                                {a.status && (
                                  <Badge variant="outline" className="px-1.5 py-0 text-[9px] text-muted-foreground capitalize">{a.status}</Badge>
                                )}
                              </div>
                            </div>
                            <span className="text-xs text-muted-foreground">{a.actor ?? "Warehouse Manager"}</span>
                            <ChevronRight className="size-4 shrink-0 text-muted-foreground/60" />
                          </button>
                        </li>
                      ))}
                    </ul>
                  </CardContent>
                </Card>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* ================================================ DETAIL DIALOG */}
      <Dialog open={selected !== null} onOpenChange={(open) => { if (!open) setSelected(null); }}>
        <DialogContent className="max-w-md">
          {selected && <ActivityDetail activity={selected} />}
        </DialogContent>
      </Dialog>
    </motion.div>
  );
}

/* ------------------------------------------------------------ detail */

function ActivityDetail({ activity }: { activity: ActivityDoc }) {
  let metadata: Record<string, string | number | boolean> | null = null;
  if (activity.metadata) {
    try {
      metadata = JSON.parse(activity.metadata) as Record<string, string | number | boolean>;
    } catch {
      metadata = null;
    }
  }
  const rows: { label: string; value: React.ReactNode }[] = [
    { label: "Event", value: humanizeEvent(activity.eventType) },
    { label: "Category", value: <ActivityCategoryBadge category={activity.category} /> },
    {
      label: "Time",
      value: new Date(activity.timestamp).toLocaleString("en-US", {
        weekday: "short",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      }),
    },
    { label: "Performed by", value: `${activity.actor ?? "Warehouse Manager"}${activity.actorRole ? ` · ${activity.actorRole}` : ""}` },
    ...(activity.orderId ? [{ label: "Order reference", value: <span className="mono">{activity.orderId}</span> }] : []),
    ...(activity.sku ? [{ label: "SKU", value: <span className="mono">{activity.sku}</span> }] : []),
    ...(activity.previousValue ? [{ label: "Previous", value: activity.previousValue }] : []),
    ...(activity.newValue ? [{ label: "New value", value: activity.newValue }] : []),
    ...(activity.status ? [{ label: "Status", value: <span className="capitalize">{activity.status}</span> }] : []),
    ...(activity.severity ? [{ label: "Severity", value: <span className="capitalize">{activity.severity}</span> }] : []),
    { label: "Description", value: activity.description },
  ];
  return (
    <div>
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          <span className={cn("flex size-7 items-center justify-center border", ACTIVITY_CATEGORY_META[activity.category].chip.split(" ")[0])}>
            <ActivityIcon category={activity.category} className="size-3.5" />
          </span>
          {humanizeEvent(activity.eventType)}
        </DialogTitle>
        <DialogDescription className="text-xs">Full audit record of this activity.</DialogDescription>
      </DialogHeader>
      <dl className="mt-4 space-y-2.5">
        {rows.map((r) => (
          <div key={r.label} className="flex items-start justify-between gap-4 border-b border-border/50 pb-2.5 text-xs last:border-0">
            <dt className="shrink-0 text-muted-foreground">{r.label}</dt>
            <dd className="text-right font-medium">{r.value}</dd>
          </div>
        ))}
      </dl>
      {metadata && (
        <div className="mt-3 rounded border border-border/60 bg-muted/40 p-3">
          <p className="micro-label mb-2">Additional data</p>
          {Object.entries(metadata).map(([k, v]) => (
            <div key={k} className="flex justify-between gap-3 py-0.5 text-[11px]">
              <span className="text-muted-foreground">{k}</span>
              <span className="mono">{String(v)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
