/**
 * DecisionDesk.tsx — the manager decision simulator (§1–§7, §16–§17).
 *
 * Flow: Current operational situation → manager selects an order → decision
 * options → approval (when required) → deterministic simulation → business
 * impact → compare decisions → audit trail.
 *
 * All calculations run through the shared engine in src/convex/decisionEngine.ts
 * (pure, deterministic — the exact same functions the backend exposes), so the
 * numbers on screen are always derived from the live warehouse state.
 */
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import {
  buildDecisionOptions,
  compareDecisionOptions,
  detectCrisisOrders,
  simulateDecision,
  type CrisisOrder,
  type DecisionComparison,
  type DecisionContext,
  type DecisionOption,
  type DecisionOptionId,
  type DecisionSimulation,
  type ImpactMetrics,
} from "@/convex/decisionEngine";
import { PRIORITY_LABEL, type OrderState, type ProductState } from "@/convex/domain";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { fmtCurrency, fmtDeadline, fmtNumber } from "@/lib/format";
import { cn } from "@/lib/utils";
import { motion } from "framer-motion";
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  CircleDashed,
  ClipboardCheck,
  Clock,
  History,
  Loader2,
  PackageX,
  Scale,
  ShieldAlert,
  Sparkles,
  Zap,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import { toast } from "sonner";

const RUN_STEPS = [
  "Analyzing orders",
  "Checking inventory",
  "Evaluating customer risk",
  "Calculating operational impact",
  "Optimizing allocation",
  "Calculating business impact",
  "Simulation complete",
];

type Phase = "situation" | "options" | "approval" | "running" | "result";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

export default function DecisionDesk() {
  const products = useQuery(api.analytics.listProducts);
  const orders = useQuery(api.analytics.listOrders);
  const decisionLog = useQuery(api.analytics.listDecisionLog);
  const logDecision = useMutation(api.decisionEngine.logManagerDecision);
  const logEvent = useMutation(api.activities.logEvent);
  const [searchParams] = useSearchParams();

  const [phase, setPhase] = useState<Phase>("situation");
  const [crisis, setCrisis] = useState<CrisisOrder | null>(null);
  const [options, setOptions] = useState<DecisionOption[]>([]);
  const [optionId, setOptionId] = useState<DecisionOptionId | null>(null);
  const [pendingOptionId, setPendingOptionId] = useState<DecisionOptionId | null>(null);
  const [sim, setSim] = useState<DecisionSimulation | null>(null);
  const [compare, setCompare] = useState<DecisionComparison | null>(null);
  const [runStep, setRunStep] = useState(0);
  const [reason, setReason] = useState("");
  const [logged, setLogged] = useState(false);
  const [logging, setLogging] = useState(false);
  const focusHandled = useRef(false);

  const now = useMemo(() => Date.now(), []);

  const crises: CrisisOrder[] = useMemo(() => {
    if (!products || !orders || !decisionLog) return [];
    return detectCrisisOrders(products, orders, decisionLog, Date.now());
  }, [products, orders, decisionLog]);

  // deep link: /dashboard/simulator?focusOrder=URG-2001 → open that order's desk
  useEffect(() => {
    if (focusHandled.current || crises.length === 0) return;
    const focus = searchParams.get("focusOrder");
    if (!focus) return;
    const match = crises.find((c) => c.order.orderNumber === focus);
    if (match) {
      focusHandled.current = true;
      selectCrisis(match);
    }
  }, [crises, searchParams]);

  if (!products || !orders || !decisionLog) {
    return <Skeleton className="h-96 w-full" />;
  }

  const ctxFor = (c: CrisisOrder): DecisionContext => ({
    products,
    orders,
    trustEntries: decisionLog,
    now: Date.now(),
    order: c.order,
    line: c.line,
    product: c.product,
    available: c.available,
    shortage: c.shortage,
  });

  const selectCrisis = (c: CrisisOrder) => {
    setCrisis(c);
    setOptions(buildDecisionOptions(ctxFor(c)));
    setSim(null);
    setCompare(null);
    setLogged(false);
    setReason("");
    setPhase("options");
    // §15 — log that the manager opened the decision review for this order
    void logEvent({
      eventType: "decision_review_started",
      category: "decisions",
      description: `Manager opened decision review for ${c.order.orderNumber} — ${c.shortage} unit(s) short of ${c.line.sku} (${c.available} of ${c.line.qty} available)`,
      orderId: c.order._id,
      sku: c.line.sku,
      severity: "warning",
      status: "open",
    }).catch(() => undefined);
  };

  const startSim = async (id: DecisionOptionId) => {
    if (!crisis) return;
    setOptionId(id);
    // §15 — log which strategy the manager selected
    void logEvent({
      eventType: "strategy_selected",
      category: "decisions",
      description: `Strategy selected for ${crisis.order.orderNumber}: ${options.find((o) => o.id === id)?.label ?? id}`,
      orderId: crisis.order._id,
      status: "selected",
    }).catch(() => undefined);
    setPhase("running");
    setRunStep(0);
    for (let i = 0; i < RUN_STEPS.length; i++) {
      setRunStep(i);
      await delay(110);
    }
    const ctx = ctxFor(crisis);
    setSim(simulateDecision(id, ctx));
    setCompare(compareDecisionOptions(ctx));
    setPhase("result");
  };

  const logDecisionEntry = async () => {
    if (!sim || !crisis || logging) return;
    setLogging(true);
    try {
      const m = sim.metrics;
      await logDecision({
        optionId: sim.optionId,
        optionLabel: sim.label,
        orderNumber: crisis.order.orderNumber,
        orderId: crisis.order._id,
        customer: crisis.order.customer,
        approval: optionApprovalLabel(sim.optionId),
        headline: sim.headline,
        impact: `${fmtCurrency(m.revenueProtected)} revenue protected · ${m.fulfillmentRate}% fulfillment · ${m.ordersDelayed} delayed · ${m.complaintRisk} complaint risk`,
        reason: reason.trim() || undefined,
      });
      setLogged(true);
      toast.success("Decision logged to the audit trail");
    } catch (e) {
      toast.error("Could not log decision", {
        description: e instanceof Error ? e.message : "",
      });
    } finally {
      setLogging(false);
    }
  };

  const reset = () => {
    setPhase("situation");
    setCrisis(null);
    setOptions([]);
    setSim(null);
    setCompare(null);
    setLogged(false);
    setReason("");
  };

  const recentLog = decisionLog
    .filter((e) => e.kind === "simulation")
    .slice(0, 5);

  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.35 }} className="space-y-6">
      {/* ---------------------------------------------------- header */}
      <div className="flex flex-wrap items-center gap-6">
        <div className="flex items-center gap-3">
          <Scale className="size-5 text-swissblue" />
          <div>
            <p className="text-sm font-bold">Manager decision desk</p>
            <p className="text-[11px] text-muted-foreground">Current crisis → decision → approval → simulated business impact</p>
          </div>
        </div>
        {phase !== "situation" && (
          <Button type="button" variant="ghost" className="ml-auto gap-2" onClick={reset}>
            <ArrowLeft className="size-4" /> Back to situation
          </Button>
        )}
      </div>

      {/* ---------------------------------------------------- situation */}
      {phase === "situation" && (
        <>
          <div className="border-l-2 border-swissblue bg-swissblue/5 px-4 py-3">
            <p className="text-xs leading-5 text-muted-foreground">
              <b className="text-foreground">Current operational situation.</b>{" "}
              These are the orders that need a decision right now — pick one to review the options.
            </p>
          </div>
          {crises.length === 0 ? (
            <Card className="border-border/70 shadow-none">
              <CardContent className="flex flex-col items-center gap-3 py-16 text-center">
                <CheckCircle2 className="size-6 text-emerald-400" />
                <p className="text-sm font-bold">No open decisions</p>
                <p className="max-w-sm text-xs leading-5 text-muted-foreground">
                  Every open order is fully allocated with a safe delivery window. Run an
                  allocation wave or check Inventory to surface new situations.
                </p>
              </CardContent>
            </Card>
          ) : (
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              {crises.slice(0, 9).map((c) => (
                <SituationCard key={`${c.order._id}-${c.line.sku}`} crisis={c} onSelect={() => selectCrisis(c)} />
              ))}
            </div>
          )}
        </>
      )}

      {/* ---------------------------------------------------- options */}
      {phase === "options" && crisis && (
        <div className="grid gap-6 xl:grid-cols-[400px_1fr]">
          <OrderDecisionCard crisis={crisis} />
          <Card className="border-border/70 shadow-none">
            <CardHeader className="pb-0">
              <CardTitle className="text-sm font-bold uppercase tracking-[0.12em]">What should the manager do?</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 pt-5">
              {options.map((opt) => (
                <button
                  key={opt.id}
                  type="button"
                  disabled={!opt.feasible}
                  onClick={() => {
                    setPendingOptionId(opt.id);
                    if (opt.requiresApproval) {
                      setPhase("approval");
                      // §15 — log that approval is required for this decision
                      void logEvent({
                        eventType: "approval_requested",
                        category: "decisions",
                        description: `Approval requested for ${crisis.order.orderNumber}: ${opt.label}`,
                        orderId: crisis.order._id,
                        severity: "warning",
                        status: "pending_approval",
                      }).catch(() => undefined);
                    } else startSim(opt.id);
                  }}
                  className={cn(
                    "group w-full border p-4 text-left transition-colors",
                    opt.feasible
                      ? "border-border/60 bg-background/40 hover:border-swissblue/60 hover:bg-swissblue/5"
                      : "border-border/40 bg-background/30 opacity-50",
                  )}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex items-center gap-2">
                      <span className="mono text-[10px] font-bold text-swissblue">{optionLetter(opt.id)}</span>
                      <p className="text-[13px] font-bold">{opt.label}</p>
                    </div>
                    {opt.requiresApproval && opt.feasible && (
                      <Badge className="border-amber-500/50 bg-amber-500/10 text-amber-300">Approval required</Badge>
                    )}
                  </div>
                  <p className="mt-1.5 text-xs leading-5 text-muted-foreground">{opt.description}</p>
                  {opt.feasible ? (
                    <p className="mt-2 text-[11px] font-bold text-emerald-300 opacity-0 transition-opacity group-hover:opacity-100">
                      Choose this strategy →
                    </p>
                  ) : (
                    opt.whyNot && <p className="mt-2 text-[11px] text-muted-foreground">Not possible — {opt.whyNot}</p>
                  )}
                </button>
              ))}
            </CardContent>
          </Card>
        </div>
      )}

      {/* ---------------------------------------------------- approval */}
      {phase === "approval" && crisis && pendingOptionId && (
        <ApprovalPanel
          crisis={crisis}
          option={options.find((o) => o.id === pendingOptionId) ?? options.find((o) => o.requiresApproval && o.feasible)!}
          onApprove={() => startSim(pendingOptionId)}
          onReject={() => setPhase("options")}
          onChooseAnother={() => setPhase("options")}
        />
      )}

      {/* ---------------------------------------------------- running */}
      {phase === "running" && (
        <Card className="border-border/70 shadow-none">
          <CardContent className="space-y-3 p-6">
            <p className="micro-label mb-2">Simulating the decision</p>
            {RUN_STEPS.map((s, i) => (
              <div key={s} className="flex items-center gap-3">
                {i < runStep ? (
                  <CheckCircle2 className="size-4 shrink-0 text-emerald-400" />
                ) : i === runStep ? (
                  <Loader2 className="size-4 shrink-0 animate-spin text-swissblue" />
                ) : (
                  <CircleDashed className="size-4 shrink-0 text-muted-foreground" />
                )}
                <span className={cn("text-xs", i <= runStep ? "text-foreground" : "text-muted-foreground")}>{s}</span>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {/* ---------------------------------------------------- result */}
      {phase === "result" && sim && compare && crisis && (
        <ResultView
          crisis={crisis}
          sim={sim}
          compare={compare}
          reason={reason}
          setReason={setReason}
          logged={logged}
          logging={logging}
          onLog={logDecisionEntry}
          onReset={reset}
        />
      )}

      {/* ---------------------------------------------------- audit trail */}
      {phase === "result" && (
        <Card className="border-border/70 shadow-none">
          <CardHeader className="pb-0">
            <div className="flex items-center gap-2">
              <History className="size-4 text-swissblue" />
              <CardTitle className="text-sm font-bold uppercase tracking-[0.12em]">Decision history</CardTitle>
            </div>
          </CardHeader>
          <CardContent className="pt-4">
            <div className="space-y-2">
              {recentLog.length === 0 && (
                <p className="text-xs text-muted-foreground">
                  No logged manager decisions yet — approve a decision above to write the first audit entry.
                </p>
              )}
              {recentLog.map((e) => (
                <div key={e._id} className="flex items-start justify-between gap-4 border-b border-border/40 py-3">
                  <div className="min-w-0">
                    <p className="text-[13px] font-semibold">{e.summary}</p>
                    {e.detail && <p className="mt-1 text-xs leading-5 text-muted-foreground">Reason: {e.detail}</p>}
                    <p className="mt-1 text-xs leading-5 text-muted-foreground">{e.outcome}</p>
                  </div>
                  <p className="shrink-0 text-[10px] text-muted-foreground">
                    {new Date(e.createdAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
                  </p>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </motion.div>
  );
}

/* ------------------------------------------------------------ helpers */

function optionLetter(id: DecisionOptionId): string {
  return { allocate: "A", reallocate: "B", partial: "C", wait: "D", substitute: "E" }[id];
}

function optionApprovalLabel(id: DecisionOptionId | null): string {
  if (id === "reallocate" || id === "substitute") return "Approved";
  return "No approval required";
}

/* -------------------------------------------------------- subcomponents */

function SituationCard({ crisis, onSelect }: { crisis: CrisisOrder; onSelect: () => void }) {
  const riskTone =
    crisis.customerRisk === "high"
      ? "border-amber-500/50 bg-amber-500/10 text-amber-300"
      : crisis.customerRisk === "medium"
        ? "border-swissblue/50 bg-swissblue/10 text-blue-300"
        : "border-emerald-500/50 bg-emerald-500/10 text-emerald-300";
  return (
    <Card className="border-border/70 shadow-none">
      <CardContent className="flex flex-col gap-3 p-5">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="mono text-xs font-bold text-swissblue">{crisis.order.orderNumber}</p>
            <p className="truncate text-[11px] text-muted-foreground">{crisis.order.customer}</p>
          </div>
          <Badge className={riskTone}>
            {crisis.customerRisk === "high" ? "High impact" : crisis.customerRisk === "medium" ? "Moderate impact" : "Low impact"}
          </Badge>
        </div>
        <p className="text-[13px] leading-5 font-semibold">{crisis.situation}</p>
        <div className="grid grid-cols-3 gap-px border border-border/60 bg-border/40 text-center">
          <div className="bg-card px-2 py-2">
            <p className="micro-label">Required</p>
            <p className="tnum mt-1 text-sm font-bold">{crisis.required}</p>
          </div>
          <div className="bg-card px-2 py-2">
            <p className="micro-label">Available</p>
            <p className={cn("tnum mt-1 text-sm font-bold", crisis.available === 0 ? "text-swissred" : "text-foreground")}>{crisis.available}</p>
          </div>
          <div className="bg-card px-2 py-2">
            <p className="micro-label">Shortage</p>
            <p className={cn("tnum mt-1 text-sm font-bold", crisis.shortage > 0 ? "text-amber-300" : "text-emerald-400")}>{crisis.shortage}</p>
          </div>
        </div>
        <div className="flex items-center justify-between gap-2">
          <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <Clock className="size-3.5" /> {fmtDeadline(crisis.order.deadline)}
          </span>
          <Button type="button" size="sm" className="gap-2" onClick={onSelect}>
            Review decision <ArrowRight className="size-3.5" />
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function OrderDecisionCard({ crisis }: { crisis: CrisisOrder }) {
  return (
    <Card className="border-border/70 shadow-none">
      <CardHeader className="pb-0">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm font-bold uppercase tracking-[0.12em]">Order {crisis.order.orderNumber}</CardTitle>
          <Badge className="border-swissred bg-swissred/15 text-amber-200">{PRIORITY_LABEL[crisis.order.priority]} priority</Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-4 pt-5">
        <div>
          <p className="micro-label">Customer</p>
          <p className="mt-1 text-sm font-bold">{crisis.order.customer}</p>
        </div>
        <div>
          <p className="micro-label">Delivery deadline</p>
          <p className="mt-1 text-sm font-bold">{fmtDeadline(crisis.order.deadline)}</p>
        </div>
        <div className="grid grid-cols-2 gap-px border border-border/60 bg-border/40">
          <div className="bg-card p-3">
            <p className="micro-label">Required</p>
            <p className="tnum mt-1 text-xl font-bold">{crisis.required} <span className="text-[10px] text-muted-foreground">{crisis.product.sku}</span></p>
          </div>
          <div className="bg-card p-3">
            <p className="micro-label">Available</p>
            <p className={cn("tnum mt-1 text-xl font-bold", crisis.available === 0 ? "text-swissred" : "text-foreground")}>{crisis.available}</p>
          </div>
          <div className="bg-card p-3">
            <p className="micro-label">Shortage</p>
            <p className={cn("tnum mt-1 text-xl font-bold", crisis.shortage > 0 ? "text-amber-300" : "text-emerald-400")}>{crisis.shortage}</p>
          </div>
          <div className="bg-card p-3">
            <p className="micro-label">Customer risk</p>
            <p className={cn("mt-1 text-sm font-bold", crisis.customerRisk === "high" ? "text-amber-300" : crisis.customerRisk === "medium" ? "text-blue-300" : "text-emerald-400")}>
              {crisis.customerRisk === "high" ? "High" : crisis.customerRisk === "medium" ? "Moderate" : "Low"}
            </p>
          </div>
        </div>
        <p className="flex items-start gap-2 border border-swissblue/25 bg-swissblue/5 p-3 text-xs leading-5 text-muted-foreground">
          <ShieldAlert className="mt-0.5 size-3.5 shrink-0 text-blue-300" />
          Only {crisis.coveredPct}% of demand can be covered from current usable stock.
        </p>
      </CardContent>
    </Card>
  );
}

function ApprovalPanel({
  crisis,
  option,
  onApprove,
  onReject,
  onChooseAnother,
}: {
  crisis: CrisisOrder;
  option: DecisionOption;
  onApprove: () => void;
  onReject: () => void;
  onChooseAnother: () => void;
}) {
  const preview = option.preview;
  return (
    <Card className="border-amber-500/40 shadow-none">
      <CardHeader className="pb-0">
        <div className="flex items-center gap-2">
          <ShieldAlert className="size-4 text-amber-300" />
          <CardTitle className="text-sm font-bold uppercase tracking-[0.12em]">Approval required</CardTitle>
        </div>
      </CardHeader>
      <CardContent className="space-y-4 pt-5">
        <p className="border-l-2 border-amber-500 pl-4 text-[13px] leading-6 text-foreground">
          <b>{option.label}</b> — {option.approvalNote ?? "This decision changes committed inventory."}
        </p>

        <div>
          <p className="micro-label mb-3">Impact of this decision</p>
          <div className="space-y-2">
            <div className="flex items-center justify-between border border-emerald-500/30 bg-emerald-500/5 px-4 py-3">
              <span className="flex items-center gap-2 text-xs font-bold text-emerald-300">
                <CheckCircle2 className="size-3.5" /> {preview?.protectedOrder} → Protected
              </span>
            </div>
            {(preview?.affectedOrders ?? []).map((a) => (
              <div key={a.orderNumber} className="flex items-center justify-between border border-amber-500/25 bg-amber-500/5 px-4 py-3">
                <span className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Clock className="size-3.5 text-amber-300" /> {a.orderNumber}
                </span>
                <span className="text-xs font-bold text-amber-300">{a.impact}</span>
              </div>
            ))}
            <div className="flex items-center justify-between px-4 py-2 text-xs">
              <span className="text-muted-foreground">Expected complaints</span>
              <ComplaintBadge level={preview?.complaints ?? "low"} />
            </div>
            <div className="flex items-center justify-between px-4 py-2 text-xs">
              <span className="text-muted-foreground">Revenue protected</span>
              <span className="tnum font-bold">{fmtCurrency(preview?.revenueProtected ?? 0)}</span>
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3 border-t border-border/60 pt-4">
          <Button type="button" className="gap-2" onClick={onApprove}>
            <Zap className="size-4" /> Approve decision
          </Button>
          <Button type="button" variant="outline" onClick={onReject}>
            Reject
          </Button>
          <Button type="button" variant="ghost" onClick={onChooseAnother}>
            Choose another strategy
          </Button>
        </div>
        <p className="text-[11px] leading-5 text-muted-foreground">
          Approval is a real gate: it selects the strategy the simulation runs, and the approved
          decision is written to the audit trail.
        </p>
      </CardContent>
    </Card>
  );
}

function ComplaintBadge({ level }: { level: "low" | "medium" | "high" }) {
  const cls =
    level === "low"
      ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300"
      : level === "medium"
        ? "border-amber-500/40 bg-amber-500/10 text-amber-300"
        : "border-swissred bg-swissred/15 text-amber-200";
  return <Badge className={cls}>{level === "low" ? "Low" : level === "medium" ? "Medium" : "High"}</Badge>;
}

function ResultView({
  crisis,
  sim,
  compare,
  reason,
  setReason,
  logged,
  logging,
  onLog,
  onReset,
}: {
  crisis: CrisisOrder;
  sim: DecisionSimulation;
  compare: DecisionComparison;
  reason: string;
  setReason: (v: string) => void;
  logged: boolean;
  logging: boolean;
  onLog: () => void;
  onReset: () => void;
}) {
  const m: ImpactMetrics = sim.metrics;
  return (
    <div className="space-y-6">
      {/* recommended decision */}
      <div className="border-l-4 border-emerald-500 bg-emerald-500/5 p-5">
        <div className="flex items-center gap-2">
          <Sparkles className="size-4 text-emerald-300" />
          <p className="micro-label">Recommended decision</p>
        </div>
        <p className="mt-2 text-lg font-bold leading-7">{sim.headline}</p>
        <p className="mt-1.5 max-w-3xl text-[13px] leading-6 text-muted-foreground">{sim.why}</p>
      </div>

      {/* business impact */}
      <Card className="border-border/70 shadow-none">
        <CardHeader className="pb-0">
          <CardTitle className="text-sm font-bold uppercase tracking-[0.12em]">Business impact</CardTitle>
        </CardHeader>
        <CardContent className="pt-5">
          <div className="grid gap-px border border-border/70 bg-border/40 sm:grid-cols-2 xl:grid-cols-4">
            <ImpactMetric label="Revenue protected" value={fmtCurrency(m.revenueProtected)} tone="emerald" />
            <ImpactMetric label="Profit impact" value={fmtCurrency(m.profitImpact)} note="estimated (35% blended margin)" tone="emerald" />
            <ImpactMetric label="Customer complaint risk" value={m.complaintRisk} tone={m.complaintRisk === "low" ? "emerald" : m.complaintRisk === "medium" ? "amber" : "red"} />
            <ImpactMetric label="Orders protected" value={fmtNumber(m.ordersProtected)} tone="emerald" />
            <ImpactMetric label="Orders delayed" value={fmtNumber(m.ordersDelayed)} tone={m.ordersDelayed > 0 ? "amber" : "emerald"} />
            <ImpactMetric label="Fulfillment rate" value={`${m.fulfillmentRate}%`} tone={m.fulfillmentRate >= 90 ? "emerald" : m.fulfillmentRate >= 75 ? "amber" : "red"} />
            <ImpactMetric label="Inventory utilization" value={`${m.inventoryUtilization}%`} tone="blue" />
            <ImpactMetric label="Operational cost" value={fmtCurrency(m.operationalCost)} note="estimated labour + handling" tone="blue" />
          </div>
        </CardContent>
      </Card>

      {/* consequences */}
      {m.tradeOffs.length > 0 && (
        <Card className="border-amber-500/30 shadow-none">
          <CardHeader className="pb-0">
            <div className="flex items-center gap-2">
              <AlertTriangle className="size-4 text-amber-300" />
              <CardTitle className="text-sm font-bold uppercase tracking-[0.12em]">Consequences of this decision</CardTitle>
            </div>
          </CardHeader>
          <CardContent className="pt-4">
            <ul className="space-y-2">
              {m.tradeOffs.map((t, i) => (
                <li key={i} className="flex items-start gap-2 text-xs leading-5 text-muted-foreground">
                  <ArrowRight className="mt-1 size-3 shrink-0 text-amber-300" />
                  {t}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      {/* compare decisions */}
      <Card className="border-border/70 shadow-none">
        <CardHeader className="pb-0">
          <div className="flex items-center justify-between">
            <CardTitle className="text-sm font-bold uppercase tracking-[0.12em]">Compare decisions</CardTitle>
            <Badge className="border-emerald-500/50 bg-emerald-500/15 text-emerald-300">
              Recommended: {compare.rows.find((r) => r.recommended)?.label}
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="pt-5">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] border-collapse text-xs">
              <thead>
                <tr className="border-b border-border/60 text-left">
                  {["Strategy", "Profit impact", "Fulfillment", "Complaint risk", "Delays", "Score", "Recommendation"].map((h) => (
                    <th key={h} className="micro-label px-3 py-2 font-semibold">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {compare.rows.map((r) => (
                  <tr key={r.optionId} className={cn("border-b border-border/40", r.recommended && "bg-emerald-500/5")}>
                    <td className="px-3 py-2.5 font-bold">{r.label}</td>
                    <td className="tnum px-3 py-2.5">{fmtCurrency(r.profitImpact)}</td>
                    <td className="tnum px-3 py-2.5">{r.fulfillmentRate}%</td>
                    <td className="px-3 py-2.5">
                      <ComplaintBadge level={r.complaintRisk} />
                    </td>
                    <td className={cn("tnum px-3 py-2.5", r.ordersDelayed > 0 && "text-amber-300")}>{r.ordersDelayed}</td>
                    <td className="tnum px-3 py-2.5 font-bold">{r.score}</td>
                    <td className="px-3 py-2.5">
                      {r.recommended ? (
                        <Badge className="border-emerald-500/50 bg-emerald-500/15 text-emerald-300 text-[9px]">RECOMMENDED</Badge>
                      ) : (
                        <span className="text-[10px] text-muted-foreground">Alternative</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-4 border-l-2 border-swissblue pl-4 text-xs leading-6 text-muted-foreground">{compare.why}</p>
        </CardContent>
      </Card>

      {/* order outcomes */}
      <Card className="border-border/70 shadow-none">
        <CardHeader className="pb-0">
          <CardTitle className="text-sm font-bold uppercase tracking-[0.12em]">Impacted orders</CardTitle>
        </CardHeader>
        <CardContent className="pt-4">
          <div className="space-y-2">
            {sim.outcomes
              .filter((o) => o.outcome !== "fulfilled" || o.delayed || o.orderNumber === crisis.order.orderNumber)
              .slice(0, 10)
              .map((o) => (
                <div key={o.orderNumber} className="flex items-center justify-between border-b border-border/40 py-2">
                  <div className="flex items-center gap-2">
                    {o.outcome === "fulfilled" ? (
                      <CheckCircle2 className="size-3.5 text-emerald-400" />
                    ) : o.outcome === "partial" ? (
                      <CircleDashed className="size-3.5 text-amber-300" />
                    ) : (
                      <PackageX className="size-3.5 text-swissred" />
                    )}
                    <span className="mono text-xs font-bold">{o.orderNumber}</span>
                    <span className="text-[10px] uppercase tracking-[0.1em] text-muted-foreground">{o.priority}</span>
                    {o.delayed && <span className="text-[9px] font-bold text-amber-300">DELAYED</span>}
                  </div>
                  <span className="tnum text-xs text-muted-foreground">{o.allocatedPct}% allocated</span>
                </div>
              ))}
          </div>
        </CardContent>
      </Card>

      {/* audit + actions */}
      <Card className="border-border/70 shadow-none">
        <CardHeader className="pb-0">
          <div className="flex items-center gap-2">
            <ClipboardCheck className="size-4 text-swissblue" />
            <CardTitle className="text-sm font-bold uppercase tracking-[0.12em]">Decision audit</CardTitle>
          </div>
        </CardHeader>
        <CardContent className="space-y-4 pt-5">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="border border-border/50 bg-background/40 p-4">
              <p className="micro-label">Manager selected</p>
              <p className="mt-1.5 text-[13px] font-bold">{sim.label}</p>
              <p className="micro-label mt-3">Approval</p>
              <p className="mt-1.5 text-[13px] font-bold text-emerald-300">{optionApprovalLabel(sim.optionId)}</p>
              <p className="micro-label mt-3">Result</p>
              <p className="mt-1.5 text-xs leading-5 text-muted-foreground">{sim.headline}</p>
            </div>
            <div className="flex flex-col gap-3">
              <div>
                <p className="micro-label mb-1.5">Reason (optional, recorded in the ledger)</p>
                <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Protect the key account" className="border-border/60 bg-background" />
              </div>
              <div className="mt-auto flex flex-wrap items-center gap-2">
                <Button type="button" className="gap-2" onClick={onLog} disabled={logging || logged}>
                  {logging ? <Loader2 className="size-4 animate-spin" /> : logged ? <CheckCircle2 className="size-4" /> : <ClipboardCheck className="size-4" />}
                  {logged ? "Logged to audit trail" : "Approve & log decision"}
                </Button>
                <Button type="button" variant="outline" onClick={onReset}>
                  Start over
                </Button>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function ImpactMetric({
  label,
  value,
  note,
  tone,
}: {
  label: string;
  value: string;
  note?: string;
  tone: "emerald" | "amber" | "red" | "blue";
}) {
  const color =
    tone === "emerald" ? "text-emerald-300" : tone === "amber" ? "text-amber-300" : tone === "red" ? "text-swissred" : "text-blue-300";
  return (
    <div className="bg-card p-4">
      <p className="micro-label">{label}</p>
      <p className={cn("tnum mt-2 text-xl font-bold", color)}>{value}</p>
      {note && <p className="mt-1 text-[10px] text-muted-foreground">{note}</p>}
    </div>
  );
}
