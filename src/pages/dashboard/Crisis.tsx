import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { findReallocationPlan, scoreOrder, scoreOrderBreakdown } from "@/convex/allocation";
import {
  customerTrustScore,
  orderRevenue,
  type AlertState,
  type OrderState,
  type ProductState,
} from "@/convex/domain";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { AlertTypeBadge, DemoTag, PriorityBadge, SeverityBadge, TrustBadge, trustBand } from "@/components/warehouse/badges";
import { explainDecision, fmtCurrency, fmtDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import { motion } from "framer-motion";
import { AlertTriangle, ChevronDown, ShieldAlert, ShoppingCart, Zap } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import { toast } from "sonner";

type ShortfallContext = {
  alert: AlertState;
  order: OrderState;
  product: ProductState;
  needed: number;
  plan: ReturnType<typeof findReallocationPlan>;
};

export default function Crisis() {
  const alerts = useQuery(api.analytics.listAlerts);
  const orders = useQuery(api.analytics.listOrders);
  const products = useQuery(api.analytics.listProducts);
  const decisionLog = useQuery(api.analytics.listDecisionLog);
  const [searchParams] = useSearchParams();

  const acknowledgeAlert = useMutation(api.alerts.acknowledgeAlert);
  const resolveAlert = useMutation(api.alerts.resolveAlert);
  const dismissAlert = useMutation(api.alerts.dismissAlert);
  const raiseReorder = useMutation(api.alerts.raiseReorder);
  const reallocate = useMutation(api.allocation.reallocate);

  const [expandedWhy, setExpandedWhy] = useState<string | null>(null);
  const [resolveTarget, setResolveTarget] = useState<AlertState | null>(null);
  const [resolveText, setResolveText] = useState("");
  const [reallocTarget, setReallocTarget] = useState<ShortfallContext | null>(null);
  const [reallocBusy, setReallocBusy] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const cardRefs = useRef<Record<string, HTMLDivElement | null>>({});

  const now = useMemo(() => Date.now(), []);

  const shortfalls: ShortfallContext[] = useMemo(() => {
    if (!alerts || !orders || !products || !decisionLog) return [];
    const trustEntries = decisionLog;
    const result: ShortfallContext[] = [];
    for (const alert of alerts) {
      if (alert.type !== "shortfall" || (alert.status !== "open" && alert.status !== "acknowledged")) continue;
      const order = orders.find((o) => o._id === alert.refId);
      if (!order) continue;
      const line = order.items.find((i) => i.qty - i.allocated > 0);
      if (!line) continue;
      const product = products.find((p) => p._id === line.productId);
      if (!product) continue;
      const plan = findReallocationPlan({
        targetOrder: order,
        product,
        allOrders: orders,
        trustEntries,
        now,
      });
      result.push({ alert, order, product, needed: line.qty - line.allocated, plan });
    }
    return result;
  }, [alerts, orders, products, decisionLog, now]);

  // deep-link focus: /dashboard/crisis?focus=URG-2002 (§10.4)
  useEffect(() => {
    const focus = searchParams.get("focus");
    if (!focus) return;
    const t = window.setTimeout(() => {
      const el = cardRefs.current[focus];
      el?.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 350);
    return () => window.clearTimeout(t);
  }, [searchParams, shortfalls.length]);

  if (!alerts || !orders || !products || !decisionLog) {
    return <Skeleton className="h-96 w-full" />;
  }

  const open = alerts.filter((a) => a.status === "open" || a.status === "acknowledged");
  const resolved = alerts.filter((a) => a.status === "resolved" || a.status === "dismissed");

  const runMutation = async (
    key: string,
    fn: () => Promise<{ applied: boolean; reason?: string }>,
    successMsg: string,
  ) => {
    setBusyId(key);
    try {
      const res = await fn();
      if (res.applied) toast.success(successMsg);
      else toast.info("No change", { description: res.reason ?? "precondition not met" });
    } catch (e) {
      toast.error("Action failed", { description: e instanceof Error ? e.message : "" });
    } finally {
      setBusyId(null);
    }
  };

  const doReallocate = async () => {
    if (!reallocTarget) return;
    setReallocBusy(true);
    try {
      const res = await reallocate({ alertId: reallocTarget.alert._id });
      if (res.applied) {
        const donors = (res.donors ?? []).map((d) => `${d.donorOrderNumber} (${d.units}u)`).join(", ");
        toast.success(res.targetCovered ? "Reallocation applied — order covered" : "Reallocation applied — still short", {
          description: donors ? `Drawn from ${donors}.` : undefined,
        });
        setReallocTarget(null);
      } else if (res.withheld) {
        toast.info("Reallocation withheld", { description: res.reason });
        setReallocTarget(null);
      } else {
        toast.info("No-op", { description: res.reason ?? "alert is no longer open" });
        setReallocTarget(null);
      }
    } catch (e) {
      toast.error("Reallocation failed", { description: e instanceof Error ? e.message : "" });
    } finally {
      setReallocBusy(false);
    }
  };

  const raisePo = async (ctx: { product?: ProductState; alert?: AlertState }) => {
    const product = ctx.product;
    if (!product) return;
    const key = `po-${ctx.alert?._id ?? product._id}`;
    await runMutation(key, () => raiseReorder({ productId: product._id }), `PO raised for ${product.sku}`);
  };

  const confirmResolve = async () => {
    if (!resolveTarget) return;
    if (!resolveText.trim()) {
      toast.error("Record a decision first");
      return;
    }
    await runMutation(
      `resolve-${resolveTarget._id}`,
      () => resolveAlert({ id: resolveTarget._id, decision: resolveText.trim() }),
      "Alert resolved — decision logged",
    );
    setResolveTarget(null);
    setResolveText("");
  };

  const whyFor = (alert: AlertState): string | null => {
    if (alert.type === "shortfall") {
      const ctx = shortfalls.find((s) => s.alert._id === alert._id);
      if (!ctx) return null;
      const bd = scoreOrderBreakdown(ctx.order, now);
      const queue = orders
        .filter((o) => (o.status === "pending" || o.status === "review") && o._id !== ctx.order._id)
        .map((o) => ({ o, score: scoreOrder(o, now) }))
        .sort((a, b) => b.score - a.score);
      const scoring = explainDecision({
        kind: "scoring",
        data: {
          orderNumber: ctx.order.orderNumber,
          priority: ctx.order.priority,
          revenue: orderRevenue(ctx.order),
          createdAt: ctx.order.createdAt,
          deadline: ctx.order.deadline,
          breakdown: bd,
          next: queue[0] ? { orderNumber: queue[0].o.orderNumber, score: queue[0].score } : undefined,
        },
      });
      const planText = ctx.plan.withheld
        ? explainDecision({ kind: "reallocation-withheld", data: { targetOrderNumber: ctx.order.orderNumber, plan: ctx.plan } })
        : explainDecision({ kind: "reallocation-granted", data: { targetOrderNumber: ctx.order.orderNumber, plan: ctx.plan } });
      return `${scoring}\n\n${planText}`;
    }
    // non-shortfall: generated from the live referenced entity's fields
    const product = alert.refType === "product" ? products.find((p) => p._id === alert.refId) : undefined;
    const order = alert.refType === "order" ? orders.find((o) => o._id === alert.refId) : undefined;
    switch (alert.type) {
      case "low_stock":
        return product
          ? `${product.sku}: ${product.onHand} on hand is below the reorder point of ${product.reorderPoint}, so the system suggests a ${product.reorderQty}-unit PO with ${product.supplier} (lead time ${product.leadTimeDays}d).`
          : null;
      case "stockout":
        return product
          ? `${product.sku} has 0 on hand${alert.message.includes("open demand") ? " with open demand" : ""}. The suggested ${product.reorderQty}-unit PO with ${product.supplier} is the only path to fulfillment.`
          : null;
      case "reorder_due":
        return product
          ? `${product.sku} has open demand but 0 stock — ${product.reorderQty} units from ${product.supplier} (lead ${product.leadTimeDays}d) would cover it.`
          : null;
      case "missing_item":
        return order
          ? `A picker flagged a unit missing from the stated bin. Re-picking from the same bin and cycle-counting the zone confirms whether stock is misplaced or the bin is empty.`
          : null;
      case "damaged_item":
        return order
          ? `Damaged units can't ship. Writing them off and re-picking keeps the order moving and the inventory ledger honest.`
          : null;
      case "deadline_risk":
        return order
          ? `${order.orderNumber} (${order.customer}) is due in ${Math.max(0, Math.round((order.deadline - now) / 3_600_000))}h — under 24h, so the deadline guard flagged it automatically.`
          : null;
      case "bottleneck":
        return `Zone load is measured live from open picking tasks; the alert fires when one zone has far more open picks than another so pickers can be rebalanced.`;
      default:
        return null;
    }
  };

  const shortfallForAlert = (alert: AlertState): ShortfallContext | undefined =>
    shortfalls.find((s) => s.alert._id === alert._id);

  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.35 }} className="space-y-8">
      <div className="flex flex-wrap items-center gap-6">
        <div>
          <p className="micro-label">Open alerts</p>
          <p className="tnum text-2xl font-bold">{open.length}</p>
        </div>
        <p className="max-w-xl text-xs leading-5 text-muted-foreground">
          Every card follows Exception → Decision → Resolution. Expand <b>Why?</b> to see the real
          numbers behind each decision — then act, and every move lands in the decision ledger.
        </p>
      </div>

      {/* ------------------------------------------------ open alerts */}
      <div className="space-y-4">
        {open.map((alert) => {
          const ctx = shortfallForAlert(alert);
          const isDemo = alert.refType === "order" && alert.refId
            ? orders.find((o) => o._id === alert.refId)?.isDemoScenario
            : false;
          const cardId =
            alert.refType === "order"
              ? orders.find((o) => o._id === alert.refId)?.orderNumber
              : undefined;
          return (
            <Card
              key={alert._id}
              ref={(el) => {
                if (cardId) cardRefs.current[cardId] = el;
              }}
              id={cardId === "URG-2001" ? "tour-crisis-card" : undefined}
              className={cn(
                "border-border/70 shadow-none",
                alert.severity === "critical" && "border-l-4 border-l-swissred",
                alert.severity === "warning" && "border-l-4 border-l-amber-500",
                alert.severity === "info" && "border-l-4 border-l-swissblue",
              )}
            >
              <CardHeader className="pb-0">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <SeverityBadge severity={alert.severity} />
                    <AlertTypeBadge type={alert.type} />
                    {isDemo && <DemoTag />}
                    {alert.status === "acknowledged" && (
                      <span className="text-[10px] font-bold uppercase tracking-[0.12em] text-muted-foreground">Acknowledged</span>
                    )}
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {alert.type === "shortfall" && ctx && !ctx.plan.withheld && (
                      <Button type="button" size="sm" className="gap-2" onClick={() => setReallocTarget(ctx)}>
                        <Zap className="size-3.5" /> Reallocate
                      </Button>
                    )}
                    {(alert.type === "shortfall" || alert.type === "stockout" || alert.type === "low_stock" || alert.type === "reorder_due") && (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className="gap-2"
                        disabled={busyId === `po-${alert._id}`}
                        onClick={() => {
                          const product =
                            alert.refType === "product"
                              ? products.find((p) => p._id === alert.refId)
                              : ctx?.product;
                          raisePo({ product, alert });
                        }}
                      >
                        <ShoppingCart className="size-3.5" /> {ctx && ctx.plan.withheld ? "Raise emergency PO" : "Raise PO"}
                      </Button>
                    )}
                    {alert.status === "open" && (
                      <Button type="button" size="sm" variant="ghost" disabled={busyId === `ack-${alert._id}`} onClick={() => runMutation(`ack-${alert._id}`, () => acknowledgeAlert({ id: alert._id }), "Alert acknowledged")}>
                        Acknowledge
                      </Button>
                    )}
                    <Button type="button" size="sm" variant="outline" onClick={() => { setResolveTarget(alert); setResolveText(alert.suggestion); }}>
                      Resolve…
                    </Button>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="pt-4">
                <p className="text-sm font-bold">{alert.title}</p>
                <p className="mt-1.5 text-[13px] leading-6 text-muted-foreground">{alert.message}</p>
                <div className="mt-3 border border-swissblue/25 bg-swissblue/5 px-4 py-3">
                  <p className="micro-label mb-1">Suggested action</p>
                  <p className="text-[13px] leading-6 text-foreground">{alert.suggestion}</p>
                </div>

                {/* Why? disclosure (§10.1) */}
                <div className="mt-3">
                  <button
                    type="button"
                    onClick={() => setExpandedWhy(expandedWhy === alert._id ? null : alert._id)}
                    className="flex items-center gap-1.5 text-xs font-bold text-swissblue transition-colors hover:text-blue-300"
                  >
                    <ChevronDown className={cn("size-3.5 transition-transform", expandedWhy === alert._id && "rotate-180")} />
                    Why?
                  </button>
                  {expandedWhy === alert._id && (
                    <div className="mt-3 space-y-2 border-l-2 border-swissblue pl-4">
                      {whyFor(alert)?.split("\n\n").map((p, i) => (
                        <p key={i} className="text-xs leading-5 text-muted-foreground">{p}</p>
                      ))}
                    </div>
                  )}
                </div>

                {/* withheld-reallocation callout (URG-2002) */}
                {alert.type === "shortfall" && ctx && ctx.plan.withheld && (
                  <div className="mt-4 flex items-start gap-3 border border-swissred/30 bg-swissred/5 p-4">
                    <ShieldAlert className="mt-0.5 size-4 shrink-0 text-red-300" />
                    <div className="text-xs leading-5 text-muted-foreground">
                      <p className="font-bold text-red-300">Reallocation withheld — trust gate</p>
                      {ctx.plan.donors.length > 0 ? (
                        ctx.plan.donors.map((d) => (
                          <p key={d.donorOrderId} className="mt-1">
                            {d.donorOrderNumber} ({d.donorCustomer}) holds {d.units} unit(s) — {d.ineligibleReason ?? "not eligible"}.
                            Trust score: <b className="text-foreground">{d.trustBefore}</b>.
                          </p>
                        ))
                      ) : (
                        <p className="mt-1">No other order holds reserved stock for this SKU.</p>
                      )}
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          );
        })}
        {open.length === 0 && (
          <Card className="border-border/70 shadow-none">
            <CardContent className="flex flex-col items-center gap-3 py-14 text-center">
              <AlertTriangle className="size-6 text-emerald-400" />
              <p className="text-sm font-bold">No open alerts</p>
              <p className="max-w-sm text-xs text-muted-foreground">
                Run an allocation wave or check Inventory to surface new decisions.
              </p>
            </CardContent>
          </Card>
        )}
      </div>

      {/* ------------------------------------------------ resolved history */}
      <Card className="border-border/70 shadow-none">
        <CardHeader className="pb-0">
          <CardTitle className="text-sm font-bold uppercase tracking-[0.12em]">Resolved history</CardTitle>
        </CardHeader>
        <CardContent className="pt-4">
          <div className="space-y-2">
            {resolved.slice(0, 8).map((a) => (
              <div key={a._id} className="flex items-start justify-between gap-4 border-b border-border/40 py-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <AlertTypeBadge type={a.type} />
                    <span className="truncate text-[13px] font-semibold">{a.title}</span>
                  </div>
                  {a.decision && (
                    <p className="mt-1 text-xs leading-5 text-muted-foreground">
                      <span className="font-bold text-foreground">Decision:</span> {a.decision}
                    </p>
                  )}
                </div>
                <div className="shrink-0 text-right">
                  <p className="tnum text-[11px] text-muted-foreground">{fmtDateTime(a.resolvedAt ?? a.createdAt)}</p>
                  <span className="text-[10px] font-bold uppercase tracking-[0.12em] text-emerald-400">{a.status}</span>
                </div>
              </div>
            ))}
            {resolved.length === 0 && <p className="py-4 text-xs text-muted-foreground">No resolved alerts yet.</p>}
          </div>
        </CardContent>
      </Card>

      {/* ------------------------------------------------ reallocate dialog */}
      <Dialog open={!!reallocTarget} onOpenChange={(open) => { if (!open) setReallocTarget(null); }}>
        <DialogContent className="max-h-[85vh] w-full overflow-y-auto border-border/70 bg-card sm:max-w-2xl">
          {reallocTarget && (
            <>
              <DialogHeader>
                <div className="flex items-center gap-2">
                  <DialogTitle className="text-base font-bold">Reallocate stock</DialogTitle>
                  <DemoTag className={reallocTarget.order.isDemoScenario ? "" : "hidden"} />
                </div>
                <DialogDescription className="text-sm">
                  {reallocTarget.order.orderNumber} ({reallocTarget.order.customer}) ·{" "}
                  <span className="mono">{reallocTarget.product.sku}</span> — needs{" "}
                  <span className="tnum font-bold text-foreground">{reallocTarget.needed}</span> more unit(s).
                </DialogDescription>
              </DialogHeader>

              <div className="grid grid-cols-3 gap-px border border-border/70 bg-border/40 text-center">
                <div className="bg-card p-3">
                  <p className="micro-label">Available from donors</p>
                  <p className="tnum mt-1 text-xl font-bold text-emerald-300">{reallocTarget.plan.unitsAvailable}</p>
                </div>
                <div className="bg-card p-3">
                  <p className="micro-label">Target revenue</p>
                  <p className="tnum mt-1 text-xl font-bold">{fmtCurrency(orderRevenue(reallocTarget.order))}</p>
                </div>
                <div className="bg-card p-3">
                  <p className="micro-label">Target trust</p>
                  <div className="mt-1 flex justify-center">
                    <TrustBadge score={customerTrustScore(decisionLog, reallocTarget.order.customer, now)} />
                  </div>
                </div>
              </div>

              <div>
                <p className="micro-label mb-3">Donors — trust cost visible before you confirm (§7.7.4)</p>
                <div className="space-y-3">
                  {reallocTarget.plan.donors.length === 0 && (
                    <p className="border border-border/50 p-4 text-xs text-muted-foreground">
                      No order currently holds reserved units of {reallocTarget.product.sku}.
                    </p>
                  )}
                  {reallocTarget.plan.donors.map((d) => (
                    <div
                      key={d.donorOrderId}
                      className={cn(
                        "border p-4",
                        d.eligible ? "border-emerald-500/30 bg-emerald-500/5" : "border-border/50 bg-background/50 opacity-80",
                      )}
                    >
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <div>
                          <div className="flex items-center gap-2">
                            <span className="mono text-xs font-bold">{d.donorOrderNumber}</span>
                            <PriorityBadge priority={d.donorPriority} />
                          </div>
                          <p className="mt-0.5 text-xs text-muted-foreground">{d.donorCustomer}</p>
                        </div>
                        <div className="text-right">
                          <p className="tnum text-lg font-bold">
                            {d.units}<span className="text-xs text-muted-foreground"> unit(s)</span>
                          </p>
                          {d.eligible ? (
                            <p className="text-[11px] font-bold text-emerald-300">
                              net +{fmtCurrency(d.netBenefit)} · gain {fmtCurrency(d.targetGain)} vs cost {fmtCurrency(d.donorTrustCost)}
                            </p>
                          ) : (
                            <p className="text-[11px] font-bold text-red-300">{d.ineligibleReason ?? "not eligible"}</p>
                          )}
                        </div>
                      </div>
                      <div className="mt-3 flex items-center justify-between border-t border-border/40 pt-3">
                        <div className="flex items-center gap-2">
                          <span className="text-[11px] text-muted-foreground">Trust impact of raid:</span>
                          <span className="tnum text-sm font-bold">{d.trustBefore}</span>
                          <span className="text-muted-foreground">→</span>
                          <span className={cn("tnum text-sm font-bold", trustBand(d.trustAfter) === "protected" ? "text-swissred" : "text-amber-300")}>
                            {d.trustAfter}
                          </span>
                          <span className="text-[10px] text-muted-foreground">(−8 donor_raided)</span>
                        </div>
                        <TrustBadge score={d.trustBefore} />
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              <DialogFooter className="flex-wrap gap-3">
                <p className="mr-auto max-w-sm text-[11px] leading-5 text-muted-foreground">
                  Reallocation only proceeds when the revenue protected exceeds the donor's trust cost —
                  and never from a trust-protected customer.
                </p>
                <Button type="button" variant="ghost" onClick={() => setReallocTarget(null)}>Cancel</Button>
                <Button
                  type="button"
                  onClick={doReallocate}
                  disabled={reallocBusy || reallocTarget.plan.withheld}
                  className="gap-2"
                >
                  <Zap className="size-4" />
                  {reallocBusy ? "Reallocating…" : reallocTarget.plan.withheld ? "Withheld — no trust-safe donor" : `Confirm reallocation (${reallocTarget.plan.unitsAvailable} units)`}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* ------------------------------------------------ resolve dialog */}
      <Dialog open={!!resolveTarget} onOpenChange={(open) => { if (!open) setResolveTarget(null); }}>
        <DialogContent className="border-border/70 bg-card">
          <DialogHeader>
            <DialogTitle className="text-base font-bold">Resolve alert</DialogTitle>
            <DialogDescription className="text-sm text-muted-foreground">
              {resolveTarget?.title} — record the decision you took. It lands in the decision ledger.
            </DialogDescription>
          </DialogHeader>
          <Textarea value={resolveText} onChange={(e) => setResolveText(e.target.value)} rows={3} className="border-border/60 bg-background" placeholder="e.g. Re-picked from C-04; cycle count scheduled" />
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setResolveTarget(null)}>Cancel</Button>
            <Button type="button" onClick={confirmResolve} disabled={!resolveText.trim()}>Resolve & log</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </motion.div>
  );
}
