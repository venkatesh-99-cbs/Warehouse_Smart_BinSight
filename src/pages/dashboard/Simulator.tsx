import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import {
  capacityFrom,
  compareStrategies,
  runSimulation,
  validateSimInputs,
  SIM_DEFAULTS,
  type SimDisruption,
  type SimInputs,
  type SimulationReport,
  type StrategyMetrics,
} from "@/convex/simulator";
import { PRIORITIES, type Priority } from "@/convex/domain";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { fmtCurrency, fmtSignedMoney, fmtNumber } from "@/lib/format";
import { cn } from "@/lib/utils";
import { motion } from "framer-motion";
import {
  AlertTriangle,
  ArrowRight,
  ArrowRightLeft,
  CheckCircle2,
  CircleDashed,
  FlaskConical,
  Gauge,
  Lightbulb,
  Loader2,
  Minus,
  PackagePlus,
  PackageX,
  Play,
  Plus,
  RotateCcw,
  ShieldAlert,
  Users,
  Wrench,
  XCircle,
  Zap,
} from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { StrategyComparisonPanel } from "./StrategyComparison";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

let rowCounter = 0;
const nextId = () => `row-${++rowCounter}`;

function toLocalInput(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fmtHours(h: number): string {
  if (!Number.isFinite(h)) return "∞";
  if (h < 24) return `${h.toFixed(1)}h`;
  return `${(h / 24).toFixed(1)}d`;
}

function signed(n: number): string {
  if (n === 0) return "0";
  return `${n > 0 ? "+" : ""}${n}`;
}

function bottleneckLabel(level: string): string {
  if (level === "critical") return "Critical";
  if (level === "warning") return "Warning";
  return "None";
}

const RUN_STEPS = [
  "Validating inputs",
  "Adjusting stock (damaged / missing / incoming)",
  "Applying priorities & deadlines",
  "Allocating stock by current policy",
  "Computing workload, impact & recommendations",
];

const DISRUPTIONS: { value: SimDisruption; label: string }[] = [
  { value: "none", label: "None" },
  { value: "zone_offline", label: "Zone offline (half picking capacity)" },
  { value: "power_outage", label: "Power outage (30% capacity)" },
  { value: "staff_shortage", label: "Staff shortage (−1 picker)" },
];

/* ------------------------------------------------------------- config */

type AddRow = { id: string; sku: string; qty: string; priority: Priority; deadline: string };
type QtyRow = { id: string; sku: string; qty: string };
type OverrideRow = { id: string; orderId: string; priority: Priority };
type DelayRow = { id: string; orderId: string; hours: string };

type Config = {
  addRows: AddRow[];
  stockRows: QtyRow[];
  damagedRows: QtyRow[];
  missingRows: QtyRow[];
  overrideRows: OverrideRow[];
  delayRows: DelayRow[];
  pickers: string;
  pickingCapacity: string;
  packingCapacity: string;
  disruption: SimDisruption;
};

const DEFAULT_CONFIG: Config = {
  addRows: [],
  stockRows: [],
  damagedRows: [],
  missingRows: [],
  overrideRows: [],
  delayRows: [],
  pickers: String(SIM_DEFAULTS.pickers),
  pickingCapacity: String(SIM_DEFAULTS.pickingCapacity),
  packingCapacity: String(SIM_DEFAULTS.packingCapacity),
  disruption: SIM_DEFAULTS.disruption,
};

/* ------------------------------------------------------------ presets */

const PRESETS: { id: string; label: string; description: string; build: (now: number) => Config }[] = [
  {
    id: "insufficient",
    label: "Insufficient stock",
    description: "Urgent order needs 10 × WRT-8800; only 2 usable units exist",
    build: (now) => ({
      ...DEFAULT_CONFIG,
      addRows: [{ id: nextId(), sku: "WRT-8800", qty: "10", priority: "urgent", deadline: toLocalInput(now + 6 * HOUR) }],
    }),
  },
  {
    id: "urgent",
    label: "Urgent order",
    description: "8 × BAT-LI12 due in 4h — only a trust-protected donor holds stock",
    build: (now) => ({
      ...DEFAULT_CONFIG,
      addRows: [{ id: nextId(), sku: "BAT-LI12", qty: "8", priority: "urgent", deadline: toLocalInput(now + 4 * HOUR) }],
    }),
  },
  {
    id: "stockout",
    label: "Stockout",
    description: "Order demands 20 × FIB-OM4 — 0 units on hand",
    build: (now) => ({
      ...DEFAULT_CONFIG,
      addRows: [{ id: nextId(), sku: "FIB-OM4", qty: "20", priority: "high", deadline: toLocalInput(now + 24 * HOUR) }],
    }),
  },
  {
    id: "damaged",
    label: "Damaged inventory",
    description: "6 of 10 WRT-8800 units damaged — usable stock collapses",
    build: () => ({ ...DEFAULT_CONFIG, damagedRows: [{ id: nextId(), sku: "WRT-8800", qty: "6" }] }),
  },
  {
    id: "missing",
    label: "Missing inventory",
    description: "5 × SEN-MOTN unaccounted; a new order needs 6 more",
    build: (now) => ({
      ...DEFAULT_CONFIG,
      missingRows: [{ id: nextId(), sku: "SEN-MOTN", qty: "5" }],
      addRows: [{ id: nextId(), sku: "SEN-MOTN", qty: "6", priority: "high", deadline: toLocalInput(now + 18 * HOUR) }],
    }),
  },
  {
    id: "bottleneck",
    label: "Picking bottleneck",
    description: "1 picker, 12 u/h, zone D offline — queue cannot clear",
    build: () => ({ ...DEFAULT_CONFIG, pickers: "1", pickingCapacity: "12", packingCapacity: "30", disruption: "zone_offline" }),
  },
  {
    id: "surge",
    label: "Sudden order surge",
    description: "Three time-critical orders land at once",
    build: (now) => ({
      ...DEFAULT_CONFIG,
      addRows: [
        { id: nextId(), sku: "SWT-2424", qty: "10", priority: "high", deadline: toLocalInput(now + 12 * HOUR) },
        { id: nextId(), sku: "WRT-8800", qty: "8", priority: "urgent", deadline: toLocalInput(now + 8 * HOUR) },
        { id: nextId(), sku: "CAT6-305", qty: "4", priority: "medium", deadline: toLocalInput(now + 2 * DAY) },
      ],
    }),
  },
  {
    id: "replenish",
    label: "Delayed replenishment",
    description: "FIB-OM4 PO is 3 days late; open demand cannot be met",
    build: (now) => ({
      ...DEFAULT_CONFIG,
      addRows: [{ id: nextId(), sku: "FIB-OM4", qty: "20", priority: "high", deadline: toLocalInput(now + 24 * HOUR) }],
    }),
  },
];

/* ------------------------------------------------------------ helpers */

function toInputs(c: Config, now: number): SimInputs {
  return {
    addLines: c.addRows.map((r) => ({
      sku: r.sku.trim(),
      qty: Number(r.qty),
      priority: r.priority,
      deadline: new Date(r.deadline).getTime(),
    })),
    priorityOverrides: c.overrideRows.map((r) => ({ orderId: r.orderId, priority: r.priority })),
    incomingStock: c.stockRows.map((r) => ({ sku: r.sku.trim(), qty: Number(r.qty) })),
    damagedUnits: c.damagedRows.map((r) => ({ sku: r.sku.trim(), qty: Number(r.qty) })),
    missingUnits: c.missingRows.map((r) => ({ sku: r.sku.trim(), qty: Number(r.qty) })),
    orderDelays: c.delayRows.map((r) => ({ orderId: r.orderId, hours: Number(r.hours) })),
    pickers: Number(c.pickers),
    pickingCapacity: Number(c.pickingCapacity),
    packingCapacity: Number(c.packingCapacity),
    disruption: c.disruption,
  };
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------ component */

export default function Simulator() {
  const products = useQuery(api.analytics.listProducts);
  const orders = useQuery(api.analytics.listOrders);
  const decisionLog = useQuery(api.analytics.listDecisionLog);
  const applySimulation = useMutation(api.simulator.applySimulation);

  const [config, setConfig] = useState<Config>(DEFAULT_CONFIG);
  const [report, setReport] = useState<SimulationReport | null>(null);
  const [compare, setCompare] = useState<{ strategies: StrategyMetrics[]; recommended: string; why: string } | null>(null);
  const [runPhase, setRunPhase] = useState<"idle" | "running" | "done">("idle");
  const [runStepIndex, setRunStepIndex] = useState(0);
  const [comparing, setComparing] = useState(false);
  const [compareVisible, setCompareVisible] = useState(false);
  const [applying, setApplying] = useState(false);

  const defaultDeadline = useMemo(() => toLocalInput(Date.now() + 48 * HOUR), []);

  const inputs: SimInputs = useMemo(() => toInputs(config, Date.now()), [config]);

  const validation = useMemo(
    () => validateSimInputs(inputs, products ?? [], orders ?? [], Date.now()),
    [inputs, products, orders],
  );

  const hasAnyInput =
    config.addRows.length +
      config.stockRows.length +
      config.damagedRows.length +
      config.missingRows.length +
      config.overrideRows.length +
      config.delayRows.length >
    0;

  if (!products || !orders || !decisionLog) {
    return <Skeleton className="h-96 w-full" />;
  }

  const errorFor = (field: string) => validation.errors.find((e) => e.field === field)?.message;

  const run = async () => {
    if (!validation.ok || runPhase === "running") return;
    setReport(null);
    setCompareVisible(false);
    setRunPhase("running");
    setRunStepIndex(0);
    for (let i = 0; i < RUN_STEPS.length; i++) {
      setRunStepIndex(i);
      await delay(120);
    }
    const rep = runSimulation(inputs, {
      products,
      orders,
      trustEntries: decisionLog,
      now: Date.now(),
    });
    setReport(rep);
    setRunPhase("done");
  };

  const compareRun = async () => {
    if (!validation.ok || comparing) return;
    setComparing(true);
    await delay(220);
    const cmp = compareStrategies(inputs, { products, orders, now: Date.now() });
    setCompare(cmp);
    setCompareVisible(true);
    setComparing(false);
  };

  const reset = () => {
    setConfig(DEFAULT_CONFIG);
    setReport(null);
    setCompare(null);
    setCompareVisible(false);
    setRunPhase("idle");
  };

  const applyPreset = (preset: (typeof PRESETS)[number]) => {
    setConfig(preset.build(Date.now()));
    setReport(null);
    setCompare(null);
    setCompareVisible(false);
    setRunPhase("idle");
    toast.info(`Preset loaded: ${preset.label}`, {
      description: "Review the scenario, then press Run simulation.",
    });
  };

  const apply = async () => {
    if (!validation.ok || !hasAnyInput || applying) return;
    setApplying(true);
    try {
      const res = await applySimulation({ inputs });
      if (res.applied) {
        toast.success("Scenario applied to the warehouse", {
          description: `${res.inserted} order(s) · ${res.restocks} restock(s) · ${res.damaged} damaged · ${res.missing} missing · allocation wave re-run`,
        });
        reset();
      } else {
        toast.error("Could not apply", {
          description: res.errors?.map((e) => e.message).join(" · ") ?? "validation failed",
        });
      }
    } catch (e) {
      toast.error("Apply failed", { description: e instanceof Error ? e.message : "" });
    } finally {
      setApplying(false);
    }
  };

  const errCount = validation.errors.length;

  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.35 }} className="space-y-6">
      {/* ------------------------------------------------ header + controls */}
      <div className="flex flex-wrap items-center gap-6">
        <div className="flex items-center gap-3">
          <FlaskConical className="size-5 text-swissblue" />
          <div>
            <p className="text-sm font-bold">What-if simulation</p>
            <p className="text-[11px] text-muted-foreground">Scenario → Exception → Decision → Resolution → Impact</p>
          </div>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <Button type="button" className="gap-2" onClick={run} disabled={!validation.ok || runPhase === "running"}>
            {runPhase === "running" ? <Loader2 className="size-4 animate-spin" /> : <Play className="size-4" />}
            Run simulation
          </Button>
          <Button type="button" variant="outline" className="gap-2" onClick={compareRun} disabled={!validation.ok || comparing}>
            {comparing ? <Loader2 className="size-4 animate-spin" /> : <ArrowRightLeft className="size-4" />} Compare strategies
          </Button>
          <Button type="button" variant="outline" className="gap-2" onClick={apply} disabled={!validation.ok || !hasAnyInput || applying}>
            <Zap className="size-4" /> {applying ? "Applying…" : "Apply to warehouse"}
          </Button>
          <Button type="button" variant="ghost" className="gap-2" onClick={reset}>
            <RotateCcw className="size-4" /> Reset
          </Button>
        </div>
      </div>

      {!validation.ok && (
        <p className="border border-swissred/40 bg-swissred/5 px-3 py-2 text-xs text-red-300">
          {errCount} input error{errCount === 1 ? "" : "s"} — fix the highlighted fields to run the simulation.
        </p>
      )}

      <div className="grid gap-6 xl:grid-cols-[460px_1fr]">
        {/* ------------------------------------------------ scenario configuration */}
        <div className="space-y-6">
          {/* presets */}
          <Card className="border-border/70 shadow-none">
            <CardHeader className="pb-0">
              <CardTitle className="text-sm font-bold uppercase tracking-[0.12em]">Scenario presets</CardTitle>
            </CardHeader>
            <CardContent className="grid grid-cols-2 gap-2 pt-4">
              {PRESETS.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => applyPreset(p)}
                  title={p.description}
                  className="group border border-border/60 bg-background/60 p-3 text-left transition-colors hover:border-swissblue/60 hover:bg-swissblue/5"
                >
                  <p className="text-xs font-bold group-hover:text-blue-300">{p.label}</p>
                  <p className="mt-1 text-[10px] leading-4 text-muted-foreground">{p.description}</p>
                </button>
              ))}
            </CardContent>
          </Card>

          {/* warehouse conditions */}
          <Card className="border-border/70 shadow-none">
            <CardHeader className="pb-0">
              <CardTitle className="text-sm font-bold uppercase tracking-[0.12em]">Warehouse conditions</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4 pt-4">
              <div className="grid grid-cols-3 gap-2">
                <ConditionInput
                  label="Pickers"
                  icon={Users}
                  value={config.pickers}
                  error={errorFor("pickers")}
                  onChange={(v) => setConfig({ ...config, pickers: v })}
                />
                <ConditionInput
                  label="Pick u/picker/h"
                  icon={Gauge}
                  value={config.pickingCapacity}
                  error={errorFor("pickingCapacity")}
                  onChange={(v) => setConfig({ ...config, pickingCapacity: v })}
                />
                <ConditionInput
                  label="Pack u/h"
                  icon={PackagePlus}
                  value={config.packingCapacity}
                  error={errorFor("packingCapacity")}
                  onChange={(v) => setConfig({ ...config, packingCapacity: v })}
                />
              </div>
              <div className="grid gap-2">
                <span className="micro-label">Warehouse disruption</span>
                <Select
                  value={config.disruption}
                  onValueChange={(v) => setConfig({ ...config, disruption: v as SimDisruption })}
                >
                  <SelectTrigger className="h-9 border-border/60 bg-background text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="border-border/70 bg-card">
                    {DISRUPTIONS.map((d) => (
                      <SelectItem key={d.value} value={d.value} className="text-xs">
                        {d.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {config.disruption !== "none" && (
                  <p className="text-[11px] leading-5 text-amber-300">
                    Effective capacity: {capacityFrom(inputs).pickers} picker(s) × {capacityFrom(inputs).pickingCapacity} u/h
                    picking · {capacityFrom(inputs).packingCapacity} u/h packing
                  </p>
                )}
              </div>
            </CardContent>
          </Card>

          {/* order changes */}
          <Card className="border-border/70 shadow-none">
            <CardHeader className="pb-0">
              <div className="flex items-center justify-between">
                <CardTitle className="text-sm font-bold uppercase tracking-[0.12em]">Order changes</CardTitle>
                <span className="text-[10px] text-muted-foreground">new lines · priorities · delays</span>
              </div>
            </CardHeader>
            <CardContent className="space-y-6 pt-4">
              {/* add lines */}
              <div>
                <div className="mb-2 flex items-center justify-between">
                  <span className="micro-label">Add order lines</span>
                  <Button
                    type="button"
                    variant="outline"
                    size="icon-sm"
                    onClick={() =>
                      setConfig({
                        ...config,
                        addRows: [...config.addRows, { id: nextId(), sku: products[0]?.sku ?? "", qty: "10", priority: "medium", deadline: defaultDeadline }],
                      })
                    }
                  >
                    <Plus className="size-3.5" />
                  </Button>
                </div>
                {config.addRows.length === 0 && <EmptyHint text="No order lines yet — add one to project its impact." />}
                <div className="space-y-2">
                  {config.addRows.map((row, i) => (
                    <div key={row.id} className="space-y-1.5 border border-border/50 p-3">
                      <div className="grid grid-cols-[1fr_70px] gap-2">
                        <Field
                          input={
                            <Input
                              list="sim-skus"
                              placeholder="SKU"
                              className={cn("mono text-xs", errorFor(`add.${i}.sku`) && "border-swissred")}
                              value={row.sku}
                              onChange={(e) =>
                                setConfig({ ...config, addRows: config.addRows.map((r) => (r.id === row.id ? { ...r, sku: e.target.value } : r)) })
                              }
                            />
                          }
                          error={errorFor(`add.${i}.sku`)}
                        />
                        <Field
                          input={
                            <Input
                              type="number"
                              placeholder="Qty"
                              className={cn("tnum", errorFor(`add.${i}.qty`) && "border-swissred")}
                              value={row.qty}
                              onChange={(e) =>
                                setConfig({ ...config, addRows: config.addRows.map((r) => (r.id === row.id ? { ...r, qty: e.target.value } : r)) })
                              }
                            />
                          }
                          error={errorFor(`add.${i}.qty`)}
                        />
                      </div>
                      <div className="grid grid-cols-2 gap-2">
                        <Select
                          value={row.priority}
                          onValueChange={(v) =>
                            setConfig({ ...config, addRows: config.addRows.map((r) => (r.id === row.id ? { ...r, priority: v as Priority } : r)) })
                          }
                        >
                          <SelectTrigger className="h-8 border-border/60 bg-background text-xs"><SelectValue /></SelectTrigger>
                          <SelectContent className="border-border/70 bg-card">
                            {PRIORITIES.map((p) => (
                              <SelectItem key={p} value={p} className="text-xs">{p}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <Field
                          input={
                            <Input
                              type="datetime-local"
                              className={cn("mono text-[11px]", errorFor(`add.${i}.deadline`) && "border-swissred")}
                              value={row.deadline}
                              onChange={(e) =>
                                setConfig({ ...config, addRows: config.addRows.map((r) => (r.id === row.id ? { ...r, deadline: e.target.value } : r)) })
                              }
                            />
                          }
                          error={errorFor(`add.${i}.deadline`)}
                        />
                      </div>
                      <RemoveButton onClick={() => setConfig({ ...config, addRows: config.addRows.filter((r) => r.id !== row.id) })} />
                    </div>
                  ))}
                </div>
              </div>

              {/* priority overrides */}
              <div>
                <div className="mb-2 flex items-center justify-between">
                  <span className="micro-label">Priority overrides</span>
                  <Button
                    type="button"
                    variant="outline"
                    size="icon-sm"
                    onClick={() => setConfig({ ...config, overrideRows: [...config.overrideRows, { id: nextId(), orderId: "", priority: "high" }] })}
                  >
                    <Plus className="size-3.5" />
                  </Button>
                </div>
                {config.overrideRows.length === 0 && <EmptyHint text="Change the priority of an existing order before projecting." />}
                <div className="space-y-2">
                  {config.overrideRows.map((row, i) => (
                    <div key={row.id} className="flex items-center gap-2">
                      <Field
                        className="flex-1"
                        input={
                          <Select
                            value={row.orderId}
                            onValueChange={(v) =>
                              setConfig({ ...config, overrideRows: config.overrideRows.map((r) => (r.id === row.id ? { ...r, orderId: v } : r)) })
                            }
                          >
                            <SelectTrigger className={cn("h-8 w-full border-border/60 bg-background text-xs", errorFor(`override.${i}.orderId`) && "border-swissred")}>
                              <SelectValue placeholder="Order" />
                            </SelectTrigger>
                            <SelectContent className="max-h-72 border-border/70 bg-card">
                              {orders.filter((o) => o.status === "pending" || o.status === "review" || o.status === "allocated").map((o) => (
                                <SelectItem key={o._id} value={o._id} className="text-xs">{o.orderNumber} · {o.customer}</SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        }
                        error={errorFor(`override.${i}.orderId`)}
                      />
                      <Select
                        value={row.priority}
                        onValueChange={(v) =>
                          setConfig({ ...config, overrideRows: config.overrideRows.map((r) => (r.id === row.id ? { ...r, priority: v as Priority } : r)) })
                        }
                      >
                        <SelectTrigger className="h-8 w-28 border-border/60 bg-background text-xs"><SelectValue /></SelectTrigger>
                        <SelectContent className="border-border/70 bg-card">
                          {PRIORITIES.map((p) => (
                            <SelectItem key={p} value={p} className="text-xs">{p}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <RemoveButton onClick={() => setConfig({ ...config, overrideRows: config.overrideRows.filter((r) => r.id !== row.id) })} />
                    </div>
                  ))}
                </div>
              </div>

              {/* order delays */}
              <div>
                <div className="mb-2 flex items-center justify-between">
                  <span className="micro-label">Optional order delay</span>
                  <Button
                    type="button"
                    variant="outline"
                    size="icon-sm"
                    onClick={() => setConfig({ ...config, delayRows: [...config.delayRows, { id: nextId(), orderId: "", hours: "12" }] })}
                  >
                    <Plus className="size-3.5" />
                  </Button>
                </div>
                {config.delayRows.length === 0 && <EmptyHint text="Push an order's deadline out by N hours." />}
                <div className="space-y-2">
                  {config.delayRows.map((row, i) => (
                    <div key={row.id} className="flex items-center gap-2">
                      <Field
                        className="flex-1"
                        input={
                          <Select
                            value={row.orderId}
                            onValueChange={(v) =>
                              setConfig({ ...config, delayRows: config.delayRows.map((r) => (r.id === row.id ? { ...r, orderId: v } : r)) })
                            }
                          >
                            <SelectTrigger className={cn("h-8 w-full border-border/60 bg-background text-xs", errorFor(`delay.${i}.orderId`) && "border-swissred")}>
                              <SelectValue placeholder="Order" />
                            </SelectTrigger>
                            <SelectContent className="max-h-72 border-border/70 bg-card">
                              {orders.filter((o) => o.status === "pending" || o.status === "review" || o.status === "allocated" || o.status === "picking").map((o) => (
                                <SelectItem key={o._id} value={o._id} className="text-xs">{o.orderNumber} · {o.customer}</SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        }
                        error={errorFor(`delay.${i}.orderId`)}
                      />
                      <Field
                        className="w-24"
                        input={
                          <Input
                            type="number"
                            placeholder="Hours"
                            className={cn("tnum", errorFor(`delay.${i}.hours`) && "border-swissred")}
                            value={row.hours}
                            onChange={(e) =>
                              setConfig({ ...config, delayRows: config.delayRows.map((r) => (r.id === row.id ? { ...r, hours: e.target.value } : r)) })
                            }
                          />
                        }
                        error={errorFor(`delay.${i}.hours`)}
                      />
                      <RemoveButton onClick={() => setConfig({ ...config, delayRows: config.delayRows.filter((r) => r.id !== row.id) })} />
                    </div>
                  ))}
                </div>
              </div>
            </CardContent>
          </Card>

          {/* stock changes */}
          <Card className="border-border/70 shadow-none">
            <CardHeader className="pb-0">
              <div className="flex items-center justify-between">
                <CardTitle className="text-sm font-bold uppercase tracking-[0.12em]">Stock changes</CardTitle>
                <span className="text-[10px] text-muted-foreground">incoming · damaged · missing</span>
              </div>
            </CardHeader>
            <CardContent className="space-y-6 pt-4">
              {/* incoming */}
              <div>
                <div className="mb-2 flex items-center justify-between">
                  <span className="micro-label">Incoming / replenishment stock</span>
                  <Button
                    type="button"
                    variant="outline"
                    size="icon-sm"
                    onClick={() => setConfig({ ...config, stockRows: [...config.stockRows, { id: nextId(), sku: products[0]?.sku ?? "", qty: "20" }] })}
                  >
                    <Plus className="size-3.5" />
                  </Button>
                </div>
                {config.stockRows.length === 0 && <EmptyHint text="Receive stock into a SKU before projecting." />}
                <div className="space-y-2">
                  {config.stockRows.map((row, i) => (
                    <QtyRowEditor
                      key={row.id}
                      sku={row.sku}
                      qty={row.qty}
                      skuError={errorFor(`stock.${i}.sku`)}
                      qtyError={errorFor(`stock.${i}.qty`)}
                      onSku={(v) => setConfig({ ...config, stockRows: config.stockRows.map((r) => (r.id === row.id ? { ...r, sku: v } : r)) })}
                      onQty={(v) => setConfig({ ...config, stockRows: config.stockRows.map((r) => (r.id === row.id ? { ...r, qty: v } : r)) })}
                      onRemove={() => setConfig({ ...config, stockRows: config.stockRows.filter((r) => r.id !== row.id) })}
                    />
                  ))}
                </div>
              </div>

              {/* damaged */}
              <div>
                <div className="mb-2 flex items-center justify-between">
                  <span className="micro-label flex items-center gap-1.5"><PackageX className="size-3.5" /> Damaged units</span>
                  <Button
                    type="button"
                    variant="outline"
                    size="icon-sm"
                    onClick={() => setConfig({ ...config, damagedRows: [...config.damagedRows, { id: nextId(), sku: products[0]?.sku ?? "", qty: "1" }] })}
                  >
                    <Plus className="size-3.5" />
                  </Button>
                </div>
                {config.damagedRows.length === 0 && <EmptyHint text="Remove damaged units from usable stock." />}
                <div className="space-y-2">
                  {config.damagedRows.map((row, i) => (
                    <QtyRowEditor
                      key={row.id}
                      sku={row.sku}
                      qty={row.qty}
                      skuError={errorFor(`damaged.${i}.sku`)}
                      qtyError={errorFor(`damaged.${i}.qty`)}
                      onSku={(v) => setConfig({ ...config, damagedRows: config.damagedRows.map((r) => (r.id === row.id ? { ...r, sku: v } : r)) })}
                      onQty={(v) => setConfig({ ...config, damagedRows: config.damagedRows.map((r) => (r.id === row.id ? { ...r, qty: v } : r)) })}
                      onRemove={() => setConfig({ ...config, damagedRows: config.damagedRows.filter((r) => r.id !== row.id) })}
                    />
                  ))}
                </div>
              </div>

              {/* missing */}
              <div>
                <div className="mb-2 flex items-center justify-between">
                  <span className="micro-label flex items-center gap-1.5"><PackageX className="size-3.5" /> Missing units</span>
                  <Button
                    type="button"
                    variant="outline"
                    size="icon-sm"
                    onClick={() => setConfig({ ...config, missingRows: [...config.missingRows, { id: nextId(), sku: products[0]?.sku ?? "", qty: "1" }] })}
                  >
                    <Plus className="size-3.5" />
                  </Button>
                </div>
                {config.missingRows.length === 0 && <EmptyHint text="Flag units as missing — removed from usable stock until found." />}
                <div className="space-y-2">
                  {config.missingRows.map((row, i) => (
                    <QtyRowEditor
                      key={row.id}
                      sku={row.sku}
                      qty={row.qty}
                      skuError={errorFor(`missing.${i}.sku`)}
                      qtyError={errorFor(`missing.${i}.qty`)}
                      onSku={(v) => setConfig({ ...config, missingRows: config.missingRows.map((r) => (r.id === row.id ? { ...r, sku: v } : r)) })}
                      onQty={(v) => setConfig({ ...config, missingRows: config.missingRows.map((r) => (r.id === row.id ? { ...r, qty: v } : r)) })}
                      onRemove={() => setConfig({ ...config, missingRows: config.missingRows.filter((r) => r.id !== row.id) })}
                    />
                  ))}
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* ------------------------------------------------ results */}
        <div className="min-w-0 space-y-6">
          {runPhase === "running" && (
            <Card className="border-border/70 shadow-none">
              <CardContent className="space-y-3 p-6">
                <p className="micro-label mb-2">Running simulation</p>
                {RUN_STEPS.map((s, i) => (
                  <div key={s} className="flex items-center gap-3">
                    {i < runStepIndex ? (
                      <CheckCircle2 className="size-4 shrink-0 text-emerald-400" />
                    ) : i === runStepIndex ? (
                      <Loader2 className="size-4 shrink-0 animate-spin text-swissblue" />
                    ) : (
                      <CircleDashed className="size-4 shrink-0 text-muted-foreground" />
                    )}
                    <span className={cn("text-xs", i <= runStepIndex ? "text-foreground" : "text-muted-foreground")}>{s}</span>
                  </div>
                ))}
              </CardContent>
            </Card>
          )}

          {runPhase === "done" && report && (
            <>
              {/* metric strip */}
              <div className="grid gap-px border border-border/70 bg-border/40 sm:grid-cols-2 xl:grid-cols-4">
                <Metric label="Revenue at risk — before" value={fmtCurrency(report.revenueAtRiskBefore)} />
                <Metric
                  label="Revenue at risk — after"
                  value={fmtCurrency(report.revenueAtRiskAfter)}
                  accent={report.revenueAtRiskAfter > report.revenueAtRiskBefore ? "text-swissred" : "text-emerald-300"}
                />
                <Metric
                  label="Captured vs FIFO"
                  value={fmtSignedMoney(report.capturedVsFifo.delta)}
                  note={`score ${fmtCurrency(report.capturedVsFifo.scoreCaptured)} · fifo ${fmtCurrency(report.capturedVsFifo.fifoCaptured)}`}
                  accent="text-emerald-300"
                />
                <Metric label="Orders processed" value={String(report.processed)} note="by the shared allocation engine" />
              </div>

              {/* exception banner */}
              <div
                className={cn(
                  "flex items-start gap-4 border-l-4 p-5",
                  report.exception.severity === "critical" && "border-l-swissred bg-swissred/5",
                  report.exception.severity === "warning" && "border-l-amber-500 bg-amber-500/5",
                  report.exception.severity === "info" && "border-l-emerald-500 bg-emerald-500/5",
                )}
              >
                <AlertTriangle
                  className={cn(
                    "mt-0.5 size-5 shrink-0",
                    report.exception.severity === "critical" ? "text-red-300" : report.exception.severity === "warning" ? "text-amber-300" : "text-emerald-400",
                  )}
                />
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <SeverityPill severity={report.exception.severity} />
                    <p className="text-sm font-bold">{report.exception.title}</p>
                  </div>
                  <p className="mt-1.5 text-[13px] leading-6 text-muted-foreground">{report.exception.detail}</p>
                </div>
              </div>

              {/* before → after */}
              <Card className="border-border/70 shadow-none">
                <CardHeader className="pb-0">
                  <div className="flex items-center justify-between">
                    <CardTitle className="text-sm font-bold uppercase tracking-[0.12em]">Current state → simulated state</CardTitle>
                    <span className="text-[10px] font-bold tracking-[0.14em] text-muted-foreground">after Run simulation</span>
                  </div>
                </CardHeader>
                <CardContent className="space-y-4 pt-5">
                  <BeforeAfterGauges report={report} />
                  <BeforeAfterTable report={report} />
                </CardContent>
              </Card>

              {/* decision engine */}
              <Card className="border-border/70 shadow-none">
                <CardHeader className="pb-0">
                  <CardTitle className="text-sm font-bold uppercase tracking-[0.12em]">Decision engine</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4 pt-5">
                  <DecisionBlock
                    icon={<AlertTriangle className="size-4 text-red-300" />}
                    label="Exception detected"
                    color="border-l-swissred"
                    title={report.exception.title}
                    detail={report.exception.detail}
                  />
                  <DecisionBlock
                    icon={<Zap className="size-4 text-blue-300" />}
                    label="Recommended decision"
                    color="border-l-swissblue"
                    title={report.decision.title}
                    detail={report.decision.detail}
                  />
                  <DecisionBlock
                    icon={<Lightbulb className="size-4 text-amber-300" />}
                    label="Reason"
                    color="border-l-amber-500"
                    title="Why this decision follows from the numbers"
                    detail={report.reason}
                  />
                  <DecisionBlock
                    icon={<Wrench className="size-4 text-emerald-300" />}
                    label="Resolution"
                    color="border-l-emerald-500"
                    title={report.resolution.title}
                    items={report.resolution.items}
                  />
                  <ExecutePanel
                    report={report}
                    canApply={validation.ok && hasAnyInput}
                    applying={applying}
                    onApply={apply}
                  />
                </CardContent>
              </Card>

              {/* why */}
              <Card className="border-border/70 shadow-none">
                <CardHeader className="pb-0">
                  <CardTitle className="text-sm font-bold uppercase tracking-[0.12em]">Why did the system make this decision?</CardTitle>
                </CardHeader>
                <CardContent className="pt-5">
                  <p className="border-l-2 border-swissblue pl-4 text-[13px] leading-6 text-muted-foreground">{report.why}</p>
                </CardContent>
              </Card>

              {/* impact analysis */}
              <div className="grid gap-5 md:grid-cols-3">
                <ImpactCard title="Positive impact" tone="emerald" items={report.impact.positive} icon={<CheckCircle2 className="size-4" />} />
                <ImpactCard title="Risks" tone="red" items={report.impact.risks} icon={<ShieldAlert className="size-4" />} />
                <ImpactCard title="Recommended actions" tone="blue" items={report.impact.actions} icon={<ArrowRight className="size-4" />} />
              </div>

              {/* timeline */}
              <Card className="border-border/70 shadow-none">
                <CardHeader className="pb-0">
                  <CardTitle className="text-sm font-bold uppercase tracking-[0.12em]">Scenario timeline</CardTitle>
                </CardHeader>
                <CardContent className="pt-5">
                  <div className="flex flex-col">
                    {report.timeline.map((s, i) => (
                      <div key={s.stage} className="flex gap-4">
                        <div className="flex flex-col items-center">
                          <span
                            className={cn(
                              "mt-1.5 size-2.5 shrink-0",
                              s.status === "exception" && "bg-swissred",
                              s.status === "warning" && "bg-amber-500",
                              s.status === "action" && "bg-swissblue",
                              s.status === "healthy" && "bg-emerald-500",
                            )}
                          />
                          {i < report.timeline.length - 1 && <span className="w-px flex-1 bg-border/70" />}
                        </div>
                        <div className={cn("mb-4 w-full border p-4", s.status === "exception" ? "border-swissred/40 bg-swissred/5" : s.status === "warning" ? "border-amber-500/40 bg-amber-500/5" : "border-border/50")}>
                          <p className="text-xs font-bold uppercase tracking-[0.1em]">{s.stage}</p>
                          <p className="mt-1 text-xs leading-5 text-muted-foreground">{s.note}</p>
                        </div>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>

              {/* per-order outcomes + sku deltas */}
              <div className="grid gap-6 lg:grid-cols-2">
                <Card className="border-border/70 shadow-none">
                  <CardHeader className="pb-0">
                    <CardTitle className="text-sm font-bold uppercase tracking-[0.12em]">Per-order outcomes</CardTitle>
                  </CardHeader>
                  <CardContent className="pt-4">
                    <div className="space-y-2">
                      {report.outcomes.length === 0 && <p className="text-xs text-muted-foreground">No open orders to process — add order lines to see outcomes.</p>}
                      {report.outcomes.map((o) => (
                        <div key={o.orderId} className="flex items-center justify-between border-b border-border/40 pb-2">
                          <div className="flex items-center gap-2">
                            {o.outcome === "fulfilled" ? (
                              <CheckCircle2 className="size-3.5 text-emerald-400" />
                            ) : o.outcome === "partial" ? (
                              <CircleDashed className="size-3.5 text-amber-300" />
                            ) : (
                              <XCircle className="size-3.5 text-swissred" />
                            )}
                            <div>
                              <p className="mono text-xs font-bold">
                                {o.orderNumber}
                                {o.isNew && <span className="ml-2 text-[9px] font-bold text-swissblue">NEW</span>}
                                {o.delayed && <span className="ml-2 text-[9px] font-bold text-amber-300">DELAYED</span>}
                              </p>
                              <p className="text-[10px] uppercase tracking-[0.1em] text-muted-foreground">{o.priority} · {o.customer}</p>
                            </div>
                          </div>
                          <div className="text-right">
                            <p className="text-[11px] font-bold uppercase tracking-[0.08em] text-muted-foreground">{o.outcome}</p>
                            <p className="tnum text-xs text-muted-foreground">{o.allocatedPct}% · {fmtCurrency(o.revenue)}</p>
                          </div>
                        </div>
                      ))}
                    </div>
                  </CardContent>
                </Card>

                <Card className="border-border/70 shadow-none">
                  <CardHeader className="pb-0">
                    <CardTitle className="text-sm font-bold uppercase tracking-[0.12em]">Projected inventory deltas</CardTitle>
                  </CardHeader>
                  <CardContent className="pt-4">
                    <div className="space-y-2">
                      {report.skuDeltas.filter((d) => d.delta !== 0).length === 0 && (
                        <p className="text-xs text-muted-foreground">No inventory changes projected — add incoming stock, damaged, or missing units.</p>
                      )}
                      {report.skuDeltas.filter((d) => d.delta !== 0).map((d) => (
                        <div key={d.sku} className="flex items-center justify-between border-b border-border/40 pb-2">
                          <div>
                            <p className="mono text-xs font-bold">{d.sku}</p>
                            <p className="text-[11px] text-muted-foreground">{d.before} → {d.after}</p>
                          </div>
                          <span className={cn("tnum text-sm font-bold", d.delta < 0 ? "text-swissred" : "text-emerald-300")}>
                            {signed(d.delta)}
                          </span>
                        </div>
                      ))}
                    </div>
                  </CardContent>
                </Card>
              </div>
            </>
          )}

          {/* strategy comparison — available on its own action, independent of Run */}
          {compareVisible && compare && <StrategyComparisonPanel compare={compare} />}

          {runPhase === "idle" && !compareVisible && (
            <Card className="border-border/70 shadow-none">
              <CardContent className="flex flex-col items-center gap-3 py-16 text-center">
                <FlaskConical className="size-6 text-swissblue" />
                <p className="text-sm font-bold">Build a scenario and run it</p>
                <p className="max-w-sm text-xs leading-5 text-muted-foreground">
                  Change stock, orders, capacity, or disruptions on the left, then press{" "}
                  <b className="text-foreground">Run simulation</b>. The engine recomputes every metric from the
                  scenario — nothing is estimated or hardcoded.
                </p>
              </CardContent>
            </Card>
          )}
        </div>
      </div>

      <datalist id="sim-skus">
        {products.map((p) => <option key={p.sku} value={p.sku} />)}
      </datalist>
    </motion.div>
  );
}

/* ------------------------------------------------------------ subcomponents */

function EmptyHint({ text }: { text: string }) {
  return <p className="border border-dashed border-border/60 p-3 text-center text-[11px] text-muted-foreground">{text}</p>;
}

function Field({ input, error, className }: { input: React.ReactNode; error?: string; className?: string }) {
  return (
    <div className={cn("space-y-1", className)}>
      {input}
      {error && <p className="text-[10px] leading-4 text-red-300">{error}</p>}
    </div>
  );
}

function RemoveButton({ onClick }: { onClick: () => void }) {
  return (
    <div className="flex justify-end">
      <Button type="button" variant="ghost" size="icon-sm" onClick={onClick} aria-label="Remove line">
        <Minus className="size-3.5" />
      </Button>
    </div>
  );
}

function QtyRowEditor({
  sku,
  qty,
  skuError,
  qtyError,
  onSku,
  onQty,
  onRemove,
}: {
  sku: string;
  qty: string;
  skuError?: string;
  qtyError?: string;
  onSku: (v: string) => void;
  onQty: (v: string) => void;
  onRemove: () => void;
}) {
  return (
    <div className="flex items-start gap-2">
      <Field
        className="flex-1"
        input={
          <Input
            list="sim-skus"
            placeholder="SKU"
            className={cn("mono text-xs", skuError && "border-swissred")}
            value={sku}
            onChange={(e) => onSku(e.target.value)}
          />
        }
        error={skuError}
      />
      <Field
        className="w-24"
        input={
          <Input
            type="number"
            placeholder="Qty"
            className={cn("tnum", qtyError && "border-swissred")}
            value={qty}
            onChange={(e) => onQty(e.target.value)}
          />
        }
        error={qtyError}
      />
      <Button type="button" variant="ghost" size="icon" onClick={onRemove} aria-label="Remove row">
        <Minus className="size-3.5" />
      </Button>
    </div>
  );
}

function ConditionInput({
  label,
  icon: Icon,
  value,
  error,
  onChange,
}: {
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  value: string;
  error?: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="space-y-1">
      <span className="micro-label flex items-center gap-1">
        <Icon className="size-3" />
        {label}
      </span>
      <Input
        type="number"
        className={cn("tnum h-9", error && "border-swissred")}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      {error && <p className="text-[10px] leading-4 text-red-300">{error}</p>}
    </div>
  );
}

function Metric({ label, value, note, accent }: { label: string; value: string; note?: string; accent?: string }) {
  return (
    <div className="bg-card p-4">
      <p className="micro-label">{label}</p>
      <p className={cn("tnum mt-2 text-xl font-bold", accent ?? "text-foreground")}>{value}</p>
      {note && <p className="mt-1 text-[10px] text-muted-foreground">{note}</p>}
    </div>
  );
}

function SeverityPill({ severity }: { severity: "critical" | "warning" | "info" }) {
  const map = {
    critical: { label: "CRITICAL", cls: "bg-swissred text-white" },
    warning: { label: "HIGH RISK", cls: "bg-amber-500 text-black" },
    info: { label: "HEALTHY", cls: "bg-emerald-500 text-black" },
  } as const;
  const m = map[severity];
  return <span className={cn("px-2 py-0.5 text-[10px] font-bold tracking-[0.12em]", m.cls)}>{m.label}</span>;
}

function DecisionBlock({
  icon,
  label,
  color,
  title,
  detail,
  items,
}: {
  icon: React.ReactNode;
  label: string;
  color: string;
  title: string;
  detail?: string;
  items?: string[];
}) {
  return (
    <div className={cn("border-l-2 bg-background/50 p-4", color)}>
      <div className="flex items-center gap-2">
        {icon}
        <p className="micro-label">{label}</p>
      </div>
      <p className="mt-2 text-[13px] font-bold">{title}</p>
      {detail && <p className="mt-1.5 text-xs leading-6 text-muted-foreground">{detail}</p>}
      {items && (
        <ul className="mt-2 space-y-1.5">
          {items.map((item, i) => (
            <li key={i} className="flex items-start gap-2 text-xs leading-5 text-muted-foreground">
              <ArrowRight className="mt-1 size-3 shrink-0 text-muted-foreground" />
              {item}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ImpactCard({
  title,
  tone,
  items,
  icon,
}: {
  title: string;
  tone: "emerald" | "red" | "blue";
  items: string[];
  icon: React.ReactNode;
}) {
  const border = tone === "emerald" ? "border-emerald-500/30" : tone === "red" ? "border-swissred/30" : "border-swissblue/30";
  const iconCls = tone === "emerald" ? "text-emerald-300" : tone === "red" ? "text-red-300" : "text-blue-300";
  return (
    <Card className={cn("border-t-2 border-border/70 shadow-none", border)}>
      <CardHeader className="pb-0">
        <div className="flex items-center gap-2">
          <span className={iconCls}>{icon}</span>
          <CardTitle className="text-xs font-bold uppercase tracking-[0.12em]">{title}</CardTitle>
        </div>
      </CardHeader>
      <CardContent className="pt-3">
        <ul className="space-y-2">
          {items.map((item, i) => (
            <li key={i} className="text-xs leading-5 text-muted-foreground">· {item}</li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

/* ------------------------------------------- §5 visual before/after gauges */

function GaugeCard({
  label,
  cur,
  sim,
  pct,
  tone,
  delta,
  note,
}: {
  label: string;
  cur: string;
  sim: string;
  pct: number;
  tone: "emerald" | "amber" | "red" | "blue";
  delta?: { label: string; tone: "good" | "bad" | "neutral" };
  note?: string;
}) {
  const barCls =
    tone === "emerald" ? "bg-emerald-500" : tone === "amber" ? "bg-amber-500" : tone === "red" ? "bg-swissred" : "bg-swissblue";
  const deltaCls =
    delta?.tone === "good" ? "text-emerald-300" : delta?.tone === "bad" ? "text-swissred" : "text-muted-foreground";
  return (
    <div className="bg-card p-4">
      <p className="micro-label">{label}</p>
      <div className="mt-2 flex items-baseline justify-between gap-2">
        <span className="tnum text-[10px] text-muted-foreground">cur {cur}</span>
        <div className="flex items-baseline gap-2">
          <span className="tnum text-lg font-bold text-foreground">{sim}</span>
          {delta && <span className={cn("tnum text-[10px] font-bold", deltaCls)}>{delta.label}</span>}
        </div>
      </div>
      <div className="mt-2 h-1.5 w-full bg-border/60">
        <div className={cn("h-full", barCls)} style={{ width: `${Math.max(0, Math.min(100, pct))}%` }} />
      </div>
      {note && <p className="mt-1.5 text-[10px] leading-4 text-muted-foreground">{note}</p>}
    </div>
  );
}

function BeforeAfterGauges({ report }: { report: SimulationReport }) {
  const cm = report.currentMetrics;
  const sm = report.simulatedMetrics;
  const onHand = Math.max(0, sm.stockOnHand);
  const availPct = onHand > 0 ? Math.min(100, Math.round((sm.stockAvailable / onHand) * 100)) : 0;
  const capPerH = report.capacity.pickers * report.capacity.pickingCapacity;
  const pickHoursPct = Number.isFinite(sm.pickHours) ? Math.min(100, Math.round((sm.pickHours / 8) * 100)) : 100;
  const rateDelta = sm.fulfillmentRate - cm.fulfillmentRate;
  const revenueDelta = report.revenueAtRiskAfter - report.revenueAtRiskBefore;
  const rateTone = sm.fulfillmentRate >= 95 ? "emerald" : sm.fulfillmentRate >= 75 ? "amber" : "red";
  const pickTone = sm.bottleneckLevel === "critical" ? "red" : sm.bottleneckLevel === "warning" ? "amber" : "emerald";
  const availTone = availPct >= 60 ? "emerald" : availPct >= 30 ? "amber" : "red";
  const revTone = revenueDelta > 0 ? "red" : revenueDelta < 0 ? "emerald" : "blue";

  return (
    <div className="grid gap-px border border-border/70 bg-border/40 sm:grid-cols-2 xl:grid-cols-4">
      <GaugeCard
        label="Fulfillment rate"
        cur={`${cm.fulfillmentRate}%`}
        sim={`${sm.fulfillmentRate}%`}
        pct={sm.fulfillmentRate}
        tone={rateTone}
        delta={rateDelta === 0 ? undefined : { label: `${signed(rateDelta)}pp`, tone: rateDelta > 0 ? "good" : "bad" }}
        note={`${fmtNumber(sm.unitsAllocated)} of ${fmtNumber(sm.unitsAllocated + sm.backorderedUnits)} ordered units allocated`}
      />
      <GaugeCard
        label="Picking workload"
        cur={`${fmtNumber(cm.pickingWorkload)} u`}
        sim={`${fmtNumber(sm.pickingWorkload)} u`}
        pct={pickHoursPct}
        tone={pickTone}
        delta={sm.bottleneckLevel === "none" ? undefined : { label: bottleneckLabel(sm.bottleneckLevel), tone: sm.bottleneckLevel === "critical" ? "bad" : "neutral" }}
        note={`clears in ${fmtHours(sm.pickHours)} at ${fmtNumber(capPerH)} u/h · ${bottleneckLabel(sm.bottleneckLevel).toLowerCase()} bottleneck`}
      />
      <GaugeCard
        label="Available stock"
        cur={`${fmtNumber(cm.stockAvailable)} u`}
        sim={`${fmtNumber(sm.stockAvailable)} u`}
        pct={availPct}
        tone={availTone}
        delta={
          sm.stockAvailable === cm.stockAvailable
            ? undefined
            : { label: signed(sm.stockAvailable - cm.stockAvailable), tone: sm.stockAvailable > cm.stockAvailable ? "good" : "bad" }
        }
        note={`of ${fmtNumber(sm.stockOnHand)} on hand · ${fmtNumber(sm.stockReserved)} reserved`}
      />
      <GaugeCard
        label="Revenue at risk"
        cur={fmtCurrency(report.revenueAtRiskBefore)}
        sim={fmtCurrency(report.revenueAtRiskAfter)}
        pct={report.revenueAtRiskBefore > 0 ? Math.min(100, Math.round((report.revenueAtRiskAfter / report.revenueAtRiskBefore) * 100)) : 0}
        tone={revTone}
        delta={revenueDelta === 0 ? undefined : { label: fmtSignedMoney(revenueDelta), tone: revenueDelta > 0 ? "bad" : "good" }}
        note={`captured vs FIFO ${fmtSignedMoney(report.capturedVsFifo.delta)}`}
      />
    </div>
  );
}

/* ------------------------------------------------ §6 execute the decision */

function ExecutePanel({
  report,
  canApply,
  applying,
  onApply,
}: {
  report: SimulationReport;
  canApply: boolean;
  applying: boolean;
  onApply: () => void;
}) {
  const { inputs, simulatedMetrics, resolution } = report;

  const commitItems: string[] = [];
  if (inputs.addLines.length > 0) {
    commitItems.push(`${inputs.addLines.length} new order line(s) created (SIM-series)`);
  }
  const damagedQty = inputs.damagedUnits.reduce((s, d) => s + d.qty, 0);
  if (damagedQty > 0) commitItems.push(`${damagedQty} damaged unit(s) written off`);
  const missingQty = inputs.missingUnits.reduce((s, d) => s + d.qty, 0);
  if (missingQty > 0) commitItems.push(`${missingQty} missing unit(s) adjusted pending cycle count`);
  if (inputs.incomingStock.length > 0) commitItems.push(`${inputs.incomingStock.length} restock line(s) received`);
  if (inputs.priorityOverrides.length > 0) commitItems.push(`${inputs.priorityOverrides.length} priority change(s)`);
  if (inputs.orderDelays.length > 0) commitItems.push(`${inputs.orderDelays.length} deadline delay(s)`);
  if (commitItems.length === 0) commitItems.push("Capacity-only scenario — no stock or order mutations");
  commitItems.push("Allocation wave re-run through the shared engine");

  const resolutionText = resolution.items.join(" ").toLowerCase();
  const manual: string[] = [];
  if (resolutionText.includes("po")) manual.push("Raise / expedite the purchase order with the supplier");
  if (resolutionText.includes("crisis")) manual.push("Approve the reallocation in Crisis Mode");
  if (simulatedMetrics.bottleneckLevel !== "none") manual.push("Add picking capacity or pickers before the next wave");
  if (manual.length === 0) manual.push("No manual intervention required");

  return (
    <div className="border-t border-border/60 pt-4">
      <div className="flex items-center gap-2">
        <Zap className="size-4 text-blue-300" />
        <p className="micro-label">Execute the decision</p>
      </div>
      <div className="mt-3 grid gap-4 md:grid-cols-2">
        <div className="border border-border/50 bg-background/50 p-4">
          <p className="text-[10px] font-bold uppercase tracking-[0.12em] text-muted-foreground">Commits to the warehouse</p>
          <ul className="mt-2 space-y-1.5">
            {commitItems.map((item, i) => (
              <li key={i} className="flex items-start gap-2 text-xs leading-5 text-muted-foreground">
                <CheckCircle2 className="mt-1 size-3 shrink-0 text-emerald-400" />
                {item}
              </li>
            ))}
          </ul>
        </div>
        <div className="border border-border/50 bg-background/50 p-4">
          <p className="text-[10px] font-bold uppercase tracking-[0.12em] text-muted-foreground">Requires operator action</p>
          <ul className="mt-2 space-y-1.5">
            {manual.map((item, i) => (
              <li key={i} className="flex items-start gap-2 text-xs leading-5 text-muted-foreground">
                <Wrench className="mt-1 size-3 shrink-0 text-amber-300" />
                {item}
              </li>
            ))}
          </ul>
        </div>
      </div>
      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-md text-[10px] leading-4 text-muted-foreground">
          Capacity knobs (pickers, rates, disruption) are what-if parameters and are not persisted.
          {!canApply && " This scenario only changes capacity — nothing to commit."}
        </p>
        <Button type="button" className="gap-2" onClick={onApply} disabled={!canApply || applying}>
          {applying ? <Loader2 className="size-4 animate-spin" /> : <Zap className="size-4" />}
          {applying ? "Applying…" : "Apply to warehouse"}
        </Button>
      </div>
    </div>
  );
}

function BeforeAfterTable({ report }: { report: SimulationReport }) {
  const cm = report.currentMetrics;
  const sm = report.simulatedMetrics;
  const rows: { label: string; cur: string; sim: string; delta: string; goodWhenUp?: boolean; neutral?: boolean }[] = [
    { label: "Stock on hand", cur: fmtNumber(cm.stockOnHand), sim: fmtNumber(sm.stockOnHand), delta: signed(sm.stockOnHand - cm.stockOnHand), neutral: true },
    { label: "Available stock", cur: fmtNumber(cm.stockAvailable), sim: fmtNumber(sm.stockAvailable), delta: signed(sm.stockAvailable - cm.stockAvailable), goodWhenUp: true },
    { label: "Reserved stock", cur: fmtNumber(cm.stockReserved), sim: fmtNumber(sm.stockReserved), delta: signed(sm.stockReserved - cm.stockReserved), neutral: true },
    { label: "Orders fully fulfilled", cur: String(cm.fullyFulfilled), sim: String(sm.fullyFulfilled), delta: signed(sm.fullyFulfilled - cm.fullyFulfilled), goodWhenUp: true },
    { label: "Orders partially fulfilled", cur: String(cm.partiallyFulfilled), sim: String(sm.partiallyFulfilled), delta: signed(sm.partiallyFulfilled - cm.partiallyFulfilled), neutral: true },
    { label: "Orders delayed", cur: String(cm.delayed), sim: String(sm.delayed), delta: signed(sm.delayed - cm.delayed), goodWhenUp: false },
    { label: "Backordered units", cur: fmtNumber(cm.backorderedUnits), sim: fmtNumber(sm.backorderedUnits), delta: signed(sm.backorderedUnits - cm.backorderedUnits), goodWhenUp: false },
    { label: "Stockout SKUs", cur: String(cm.stockoutCount), sim: String(sm.stockoutCount), delta: signed(sm.stockoutCount - cm.stockoutCount), goodWhenUp: false },
    { label: "Fulfillment rate", cur: `${cm.fulfillmentRate}%`, sim: `${sm.fulfillmentRate}%`, delta: `${signed(sm.fulfillmentRate - cm.fulfillmentRate)}pp`, goodWhenUp: true },
    { label: "Picking workload", cur: fmtNumber(cm.pickingWorkload), sim: fmtNumber(sm.pickingWorkload), delta: signed(sm.pickingWorkload - cm.pickingWorkload), neutral: true },
    { label: "Picking time", cur: fmtHours(cm.pickHours), sim: fmtHours(sm.pickHours), delta: "", neutral: true },
    { label: "Bottleneck", cur: bottleneckLabel(cm.bottleneckLevel), sim: bottleneckLabel(sm.bottleneckLevel), delta: "", neutral: true },
    { label: "Revenue at risk", cur: fmtCurrency(report.revenueAtRiskBefore), sim: fmtCurrency(report.revenueAtRiskAfter), delta: fmtSignedMoney(report.revenueAtRiskAfter - report.revenueAtRiskBefore), goodWhenUp: false },
  ];
  return (
    <div className="grid gap-px border border-border/70 bg-border/40 sm:grid-cols-2">
      {rows.map((r) => (
        <div key={r.label} className="flex items-center justify-between gap-3 bg-card px-4 py-2.5">
          <span className="text-[11px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">{r.label}</span>
          <div className="flex items-center gap-3">
            <span className="tnum text-xs text-muted-foreground">{r.cur}</span>
            <ArrowRight className="size-3 text-muted-foreground" />
            <span className="tnum text-xs font-bold text-foreground">{r.sim}</span>
            {r.delta && (
              <span className={cn("tnum text-[10px] font-bold", deltaColor(r))}>
                {r.delta}
              </span>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

/** delta badge color: green when the change is good, red when bad, gray when neutral. */
function deltaColor(r: { label: string; cur: string; sim: string; delta: string; goodWhenUp?: boolean; neutral?: boolean }): string {
  const isUp = r.delta.startsWith("+");
  const isDown = r.delta.startsWith("-");
  if (!isUp && !isDown) return "text-muted-foreground";
  const good = r.neutral ? null : r.goodWhenUp ? isUp : isDown;
  if (good === null) return "text-muted-foreground";
  return good ? "text-emerald-300" : "text-swissred";
}

function StrategyComparison({ compare }: { compare: { strategies: StrategyMetrics[]; recommended: string; why: string } }) {
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
          <table className="w-full min-w-[820px] border-collapse text-xs">
            <thead>
              <tr className="border-b border-border/60 text-left">
                {["Strategy", "Fully fulfilled", "Partial", "Delayed", "Allocated", "Backordered", "Stockouts", "Rate", "Pick time", "Bottleneck", "Score"].map((h) => (
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
                  <td className={cn("tnum px-3 py-2.5", s.backorderedUnits > 0 && "text-amber-300")}>{fmtNumber(s.backorderedUnits)}</td>
                  <td className={cn("tnum px-3 py-2.5", s.stockoutCount > 0 && "text-swissred")}>{s.stockoutCount}</td>
                  <td className="tnum px-3 py-2.5 font-bold">{s.fulfillmentRate}%</td>
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
