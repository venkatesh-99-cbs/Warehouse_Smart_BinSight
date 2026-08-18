import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import {
  simulateScenario,
  validateSimInputs,
  type SimInputs,
} from "@/convex/simulator";
import { PRIORITIES, type Priority } from "@/convex/domain";
import { Button } from "@/components/ui/button";
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
import { SeverityBadge } from "@/components/warehouse/badges";
import { fmtCurrency, fmtSignedMoney } from "@/lib/format";
import { cn } from "@/lib/utils";
import { motion } from "framer-motion";
import { CheckCircle2, CircleDashed, FlaskConical, Minus, Plus, RotateCcw, XCircle } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";

const HOUR = 3_600_000;

let rowCounter = 0;
const nextId = () => `row-${++rowCounter}`;

function toLocalInput(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

type AddRow = { id: string; sku: string; qty: string; priority: Priority; deadline: string };
type OverrideRow = { id: string; orderId: string; priority: Priority };
type StockRow = { id: string; sku: string; qty: string };

export default function Simulator() {
  const products = useQuery(api.analytics.listProducts);
  const orders = useQuery(api.analytics.listOrders);
  const decisionLog = useQuery(api.analytics.listDecisionLog);
  const applySimulation = useMutation(api.simulator.applySimulation);

  const [addRows, setAddRows] = useState<AddRow[]>([]);
  const [overrideRows, setOverrideRows] = useState<OverrideRow[]>([]);
  const [stockRows, setStockRows] = useState<StockRow[]>([]);
  const [applying, setApplying] = useState(false);

  const defaultDeadline = useMemo(() => toLocalInput(Date.now() + 48 * HOUR), []);

  const inputs: SimInputs = useMemo(
    () => ({
      addLines: addRows.map((r) => ({
        sku: r.sku.trim(),
        qty: Number(r.qty),
        priority: r.priority,
        deadline: new Date(r.deadline).getTime(),
      })),
      priorityOverrides: overrideRows.map((r) => ({ orderId: r.orderId, priority: r.priority })),
      incomingStock: stockRows.map((r) => ({ sku: r.sku.trim(), qty: Number(r.qty) })),
    }),
    [addRows, overrideRows, stockRows],
  );

  const validation = useMemo(
    () => validateSimInputs(inputs, products ?? [], orders ?? []),
    [inputs, products, orders],
  );

  const projection = useMemo(() => {
    if (!products || !orders || !decisionLog) return null;
    return simulateScenario(inputs, {
      products,
      orders,
      trustEntries: decisionLog,
      now: Date.now(),
    });
  }, [inputs, products, orders, decisionLog]);

  if (!products || !orders || !decisionLog) {
    return <Skeleton className="h-96 w-full" />;
  }

  const errorFor = (field: string) =>
    validation.errors.find((e) => e.field === field)?.message;

  const hasAnyInput = addRows.length + overrideRows.length + stockRows.length > 0;

  const apply = async () => {
    if (!validation.ok || !hasAnyInput) return;
    setApplying(true);
    try {
      const res = await applySimulation({ inputs });
      if (res.applied) {
        toast.success("Scenario applied", {
          description: `${res.inserted} order(s) inserted · ${res.restocks} restock(s) · allocation wave re-run`,
        });
        setAddRows([]);
        setOverrideRows([]);
        setStockRows([]);
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

  const reset = () => {
    setAddRows([]);
    setOverrideRows([]);
    setStockRows([]);
  };

  const errCount = validation.errors.length;

  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.35 }} className="space-y-6">
      <div className="flex flex-wrap items-center gap-6">
        <div className="flex items-center gap-3">
          <FlaskConical className="size-5 text-swissblue" />
          <p className="text-sm font-bold">What-if simulator</p>
        </div>
        <p className="max-w-2xl text-xs leading-5 text-muted-foreground">
          Pure in-memory projection — nothing is written until you Apply. It runs the exact same
          engine as the live allocation wave, so the preview and the real outcome can never drift apart.
        </p>
      </div>

      <div className="grid gap-6 xl:grid-cols-[420px_1fr]">
        {/* ------------------------------------------------ builder */}
        <div className="space-y-6">
          {/* add order lines */}
          <Card className="border-border/70 shadow-none">
            <CardHeader className="pb-0">
              <div className="flex items-center justify-between">
                <CardTitle className="text-sm font-bold uppercase tracking-[0.12em]">Add order lines</CardTitle>
                <Button type="button" variant="outline" size="icon-sm" onClick={() => setAddRows((rows) => [...rows, { id: nextId(), sku: products[0]?.sku ?? "", qty: "10", priority: "medium", deadline: defaultDeadline }])}>
                  <Plus className="size-3.5" />
                </Button>
              </div>
            </CardHeader>
            <CardContent className="space-y-4 pt-4">
              {addRows.length === 0 && (
                <p className="border border-dashed border-border/60 p-4 text-center text-xs text-muted-foreground">
                  No order lines yet — add one to project its impact.
                </p>
              )}
              {addRows.map((row, i) => (
                <div key={row.id} className="space-y-2 border border-border/50 p-3">
                  <div className="grid grid-cols-[1fr_70px] gap-2">
                    <div className="space-y-1">
                      <Input
                        list="sim-skus"
                        placeholder="SKU"
                        className={cn("mono text-xs", errorFor(`add.${i}.sku`) && "border-swissred")}
                        value={row.sku}
                        onChange={(e) => setAddRows((rs) => rs.map((r) => (r.id === row.id ? { ...r, sku: e.target.value } : r)))}
                      />
                      {errorFor(`add.${i}.sku`) && <p className="text-[10px] text-red-300">{errorFor(`add.${i}.sku`)}</p>}
                    </div>
                    <div className="space-y-1">
                      <Input
                        type="number"
                        placeholder="Qty"
                        className={cn("tnum", errorFor(`add.${i}.qty`) && "border-swissred")}
                        value={row.qty}
                        onChange={(e) => setAddRows((rs) => rs.map((r) => (r.id === row.id ? { ...r, qty: e.target.value } : r)))}
                      />
                      {errorFor(`add.${i}.qty`) && <p className="text-[10px] text-red-300">{errorFor(`add.${i}.qty`)}</p>}
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <Select value={row.priority} onValueChange={(v) => setAddRows((rs) => rs.map((r) => (r.id === row.id ? { ...r, priority: v as Priority } : r)))}>
                      <SelectTrigger className="h-8 border-border/60 bg-background text-xs"><SelectValue /></SelectTrigger>
                      <SelectContent className="border-border/70 bg-card">
                        {PRIORITIES.map((p) => <SelectItem key={p} value={p} className="text-xs">{p}</SelectItem>)}
                      </SelectContent>
                    </Select>
                    <Input
                      type="datetime-local"
                      className={cn("mono text-[11px]", errorFor(`add.${i}.deadline`) && "border-swissred")}
                      value={row.deadline}
                      onChange={(e) => setAddRows((rs) => rs.map((r) => (r.id === row.id ? { ...r, deadline: e.target.value } : r)))}
                    />
                  </div>
                  <div className="flex justify-end">
                    <Button type="button" variant="ghost" size="icon-sm" onClick={() => setAddRows((rs) => rs.filter((r) => r.id !== row.id))} aria-label="Remove line">
                      <Minus className="size-3.5" />
                    </Button>
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>

          {/* priority overrides */}
          <Card className="border-border/70 shadow-none">
            <CardHeader className="pb-0">
              <div className="flex items-center justify-between">
                <CardTitle className="text-sm font-bold uppercase tracking-[0.12em]">Priority overrides</CardTitle>
                <Button type="button" variant="outline" size="icon-sm" onClick={() => setOverrideRows((rows) => [...rows, { id: nextId(), orderId: "", priority: "high" }])}>
                  <Plus className="size-3.5" />
                </Button>
              </div>
            </CardHeader>
            <CardContent className="space-y-3 pt-4">
              {overrideRows.length === 0 && <p className="text-xs text-muted-foreground">Change the priority of an existing order before projecting.</p>}
              {overrideRows.map((row, i) => (
                <div key={row.id} className="flex items-center gap-2">
                  <Select value={row.orderId} onValueChange={(v) => setOverrideRows((rs) => rs.map((r) => (r.id === row.id ? { ...r, orderId: v } : r)))}>
                    <SelectTrigger className={cn("h-8 flex-1 border-border/60 bg-background text-xs", errorFor(`override.${i}.orderId`) && "border-swissred")}>
                      <SelectValue placeholder="Order" />
                    </SelectTrigger>
                    <SelectContent className="max-h-72 border-border/70 bg-card">
                      {orders.filter((o) => o.status === "pending" || o.status === "review" || o.status === "allocated").map((o) => (
                        <SelectItem key={o._id} value={o._id} className="text-xs">{o.orderNumber} · {o.customer}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Select value={row.priority} onValueChange={(v) => setOverrideRows((rs) => rs.map((r) => (r.id === row.id ? { ...r, priority: v as Priority } : r)))}>
                    <SelectTrigger className="h-8 w-28 border-border/60 bg-background text-xs"><SelectValue /></SelectTrigger>
                    <SelectContent className="border-border/70 bg-card">
                      {PRIORITIES.map((p) => <SelectItem key={p} value={p} className="text-xs">{p}</SelectItem>)}
                    </SelectContent>
                  </Select>
                  <Button type="button" variant="ghost" size="icon-sm" onClick={() => setOverrideRows((rs) => rs.filter((r) => r.id !== row.id))} aria-label="Remove override">
                    <Minus className="size-3.5" />
                  </Button>
                </div>
              ))}
            </CardContent>
          </Card>

          {/* incoming stock */}
          <Card className="border-border/70 shadow-none">
            <CardHeader className="pb-0">
              <div className="flex items-center justify-between">
                <CardTitle className="text-sm font-bold uppercase tracking-[0.12em]">Incoming stock</CardTitle>
                <Button type="button" variant="outline" size="icon-sm" onClick={() => setStockRows((rows) => [...rows, { id: nextId(), sku: products[0]?.sku ?? "", qty: "20" }])}>
                  <Plus className="size-3.5" />
                </Button>
              </div>
            </CardHeader>
            <CardContent className="space-y-3 pt-4">
              {stockRows.length === 0 && <p className="text-xs text-muted-foreground">Receive stock into a SKU before projecting.</p>}
              {stockRows.map((row, i) => (
                <div key={row.id} className="flex items-center gap-2">
                  <div className="flex-1 space-y-1">
                    <Input
                      list="sim-skus"
                      placeholder="SKU"
                      className={cn("mono text-xs", errorFor(`stock.${i}.sku`) && "border-swissred")}
                      value={row.sku}
                      onChange={(e) => setStockRows((rs) => rs.map((r) => (r.id === row.id ? { ...r, sku: e.target.value } : r)))}
                    />
                    {errorFor(`stock.${i}.sku`) && <p className="text-[10px] text-red-300">{errorFor(`stock.${i}.sku`)}</p>}
                  </div>
                  <div className="w-20 space-y-1">
                    <Input
                      type="number"
                      placeholder="Qty"
                      className={cn("tnum", errorFor(`stock.${i}.qty`) && "border-swissred")}
                      value={row.qty}
                      onChange={(e) => setStockRows((rs) => rs.map((r) => (r.id === row.id ? { ...r, qty: e.target.value } : r)))}
                    />
                    {errorFor(`stock.${i}.qty`) && <p className="text-[10px] text-red-300">{errorFor(`stock.${i}.qty`)}</p>}
                  </div>
                  <Button type="button" variant="ghost" size="icon-sm" onClick={() => setStockRows((rs) => rs.filter((r) => r.id !== row.id))} aria-label="Remove stock row">
                    <Minus className="size-3.5" />
                  </Button>
                </div>
              ))}
            </CardContent>
          </Card>

          {/* actions */}
          <div className="flex items-center gap-3">
            <Button type="button" className="flex-1 gap-2" onClick={apply} disabled={applying || !validation.ok || !hasAnyInput}>
              {applying ? "Applying…" : "Apply scenario"}
            </Button>
            <Button type="button" variant="outline" className="gap-2" onClick={reset}>
              <RotateCcw className="size-3.5" /> Reset
            </Button>
          </div>
          {!validation.ok && (
            <p className="border border-swissred/40 bg-swissred/5 px-3 py-2 text-xs text-red-300">
              {errCount} input error{errCount === 1 ? "" : "s"} — fix the highlighted fields to enable Apply.
            </p>
          )}
        </div>

        {/* ------------------------------------------------ projection */}
        <div className="space-y-6">
          {projection && (
            <>
              <div className="grid gap-px border border-border/70 bg-border/40 sm:grid-cols-2 xl:grid-cols-4">
                <Metric label="Revenue at risk — before" value={fmtCurrency(projection.revenueAtRiskBefore)} />
                <Metric label="Revenue at risk — after" value={fmtCurrency(projection.revenueAtRiskAfter)} accent={projection.revenueAtRiskAfter > projection.revenueAtRiskBefore ? "text-swissred" : "text-emerald-300"} />
                <Metric
                  label="Captured vs FIFO"
                  value={fmtSignedMoney(projection.capturedVsFifo.delta)}
                  note={`score ${fmtCurrency(projection.capturedVsFifo.scoreCaptured)} · fifo ${fmtCurrency(projection.capturedVsFifo.fifoCaptured)}`}
                  accent="text-emerald-300"
                />
                <Metric label="Orders processed" value={String(projection.processed)} note="by the shared allocation engine" />
              </div>

              <div className="grid gap-6 lg:grid-cols-2">
                {/* sku deltas */}
                <Card className="border-border/70 shadow-none">
                  <CardHeader className="pb-0">
                    <CardTitle className="text-sm font-bold uppercase tracking-[0.12em]">Projected inventory deltas</CardTitle>
                  </CardHeader>
                  <CardContent className="pt-4">
                    <div className="space-y-2">
                      {projection.skuDeltas.filter((d) => d.delta !== 0).length === 0 && (
                        <p className="text-xs text-muted-foreground">No inventory changes projected — add incoming stock or order lines.</p>
                      )}
                      {projection.skuDeltas.filter((d) => d.delta !== 0).map((d) => (
                        <div key={d.sku} className="flex items-center justify-between border-b border-border/40 pb-2">
                          <div>
                            <p className="mono text-xs font-bold">{d.sku}</p>
                            <p className="text-[11px] text-muted-foreground">{d.before} → {d.after}</p>
                          </div>
                          <span className={cn("tnum text-sm font-bold", d.delta < 0 ? "text-swissred" : "text-emerald-300")}>
                            {d.delta > 0 ? "+" : ""}{d.delta}
                          </span>
                        </div>
                      ))}
                    </div>
                  </CardContent>
                </Card>

                {/* per-order outcomes */}
                <Card className="border-border/70 shadow-none">
                  <CardHeader className="pb-0">
                    <CardTitle className="text-sm font-bold uppercase tracking-[0.12em]">Per-order outcomes</CardTitle>
                  </CardHeader>
                  <CardContent className="pt-4">
                    <div className="space-y-2">
                      {projection.outcomes.map((o) => (
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
                      {projection.outcomes.length === 0 && (
                        <p className="text-xs text-muted-foreground">Add order lines to see per-order projections.</p>
                      )}
                    </div>
                  </CardContent>
                </Card>
              </div>

              {/* recommendations */}
              <Card className="border-border/70 shadow-none">
                <CardHeader className="pb-0">
                  <CardTitle className="text-sm font-bold uppercase tracking-[0.12em]">Ranked recommendations</CardTitle>
                </CardHeader>
                <CardContent className="pt-4">
                  <div className="space-y-3">
                    {projection.recommendations.length === 0 && (
                      <p className="text-xs text-muted-foreground">
                        No critical actions projected. The current queue is healthy — or run the live allocation wave to see it reflected.
                      </p>
                    )}
                    {projection.recommendations.map((r) => (
                      <div key={r.id} className="flex items-start gap-3 border border-border/50 p-4">
                        <SeverityBadge severity={r.severity} />
                        <div>
                          <p className="text-[13px] font-bold">{r.title}</p>
                          <p className="mt-1 text-xs leading-5 text-muted-foreground">{r.detail}</p>
                        </div>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            </>
          )}
        </div>
      </div>

      <datalist id="sim-skus">
        {products.map((p) => <option key={p.sku} value={p.sku} />)}
      </datalist>
    </motion.div>
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
