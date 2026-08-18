import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import type { OrderState } from "@/convex/domain";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { DemoTag, PriorityBadge, StatusBadge, TrustBadge } from "@/components/warehouse/badges";
import { fmtCurrency, fmtDeadline, hoursToDeadline } from "@/lib/format";
import { cn } from "@/lib/utils";
import { motion } from "framer-motion";
import { ArrowDown, ArrowUp, PackageCheck, Play, Truck, ClipboardCheck, ScanSearch } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";

const CARRIERS = ["UPS", "FedEx", "DHL", "USPS"];

export default function Orders() {
  const orders = useQuery(api.analytics.listOrders);
  const shipments = useQuery(api.analytics.listShipments);
  const allocatePendingOrders = useMutation(api.allocation.allocatePendingOrders);
  const startPicking = useMutation(api.fulfillment.startPicking);
  const packOrder = useMutation(api.fulfillment.packOrder);
  const qcOrder = useMutation(api.fulfillment.qcOrder);
  const dispatchOrder = useMutation(api.fulfillment.dispatchOrder);
  const markDelivered = useMutation(api.fulfillment.markDelivered);

  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [priorityFilter, setPriorityFilter] = useState<string>("all");
  const [sortAsc, setSortAsc] = useState(true);
  const [selected, setSelected] = useState<OrderState | null>(null);
  const [dispatchTarget, setDispatchTarget] = useState<OrderState | null>(null);
  const [carrier, setCarrier] = useState("UPS");
  const [tracking, setTracking] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  const visible = useMemo(() => {
    if (!orders) return [];
    const filtered = orders.filter(
      (o) =>
        (statusFilter === "all" || o.status === statusFilter) &&
        (priorityFilter === "all" || o.priority === priorityFilter),
    );
    return [...filtered].sort((a, b) =>
      sortAsc ? a.deadline - b.deadline : b.deadline - a.deadline,
    );
  }, [orders, statusFilter, priorityFilter, sortAsc]);

  if (!orders || !shipments) return <Skeleton className="h-96 w-full" />;

  const runAllocation = async () => {
    setBusy("wave");
    try {
      const res = await allocatePendingOrders();
      if (res.applied) {
        toast.success("Allocation wave complete", {
          description: `${res.stats.processed} processed · ${res.stats.fullyAllocated} allocated · ${res.stats.partial} flagged`,
        });
      }
    } catch (e) {
      toast.error("Wave failed", { description: e instanceof Error ? e.message : "" });
    } finally {
      setBusy(null);
    }
  };

  const act = async (fn: () => Promise<{ applied: boolean; reason?: string }>, label: string) => {
    setBusy(label);
    try {
      const res = await fn();
      if (res.applied) toast.success(label);
      else toast.error(label, { description: res.reason ?? "no-op" });
    } catch (e) {
      toast.error(label, { description: e instanceof Error ? e.message : "" });
    } finally {
      setBusy(null);
    }
  };

  const doDispatch = async () => {
    if (!dispatchTarget) return;
    if (!tracking.trim()) {
      toast.error("Tracking number required");
      return;
    }
    setBusy("dispatch");
    try {
      const res = await dispatchOrder({ orderId: dispatchTarget._id, carrier, tracking });
      if (res.applied) {
        toast.success(`${dispatchTarget.orderNumber} dispatched`, { description: `${carrier} / ${tracking}` });
        setDispatchTarget(null);
        setTracking("");
      } else {
        toast.error("Could not dispatch", { description: res.reason });
      }
    } catch (e) {
      toast.error("Dispatch failed", { description: e instanceof Error ? e.message : "" });
    } finally {
      setBusy(null);
    }
  };

  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.35 }} className="space-y-5">
      {/* filters */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex flex-wrap gap-1.5">
          {["all", "pending", "review", "allocated", "picking", "picked", "packed", "qc", "dispatched", "fulfilled", "cancelled"].map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setStatusFilter(s)}
              className={cn(
                "px-3 py-1.5 text-xs font-bold uppercase tracking-[0.08em] transition-colors",
                statusFilter === s ? "bg-swissred text-white" : "border border-border/60 text-muted-foreground hover:text-foreground",
              )}
            >
              {s === "all" ? "All" : s}
            </button>
          ))}
        </div>
        <Select value={priorityFilter} onValueChange={setPriorityFilter}>
          <SelectTrigger className="w-40 border-border/60 bg-card">
            <SelectValue placeholder="Priority" />
          </SelectTrigger>
          <SelectContent className="border-border/70 bg-card">
            <SelectItem value="all">All priorities</SelectItem>
            <SelectItem value="urgent">Urgent</SelectItem>
            <SelectItem value="high">High</SelectItem>
            <SelectItem value="medium">Medium</SelectItem>
            <SelectItem value="low">Low</SelectItem>
          </SelectContent>
        </Select>
        <Button type="button" variant="outline" size="sm" className="gap-1.5" onClick={() => setSortAsc((v) => !v)}>
          {sortAsc ? <ArrowUp className="size-3.5" /> : <ArrowDown className="size-3.5" />}
          Deadline {sortAsc ? "soonest first" : "latest first"}
        </Button>
        <Button type="button" size="sm" className="ml-auto gap-2" onClick={runAllocation} disabled={busy === "wave"}>
          <Play className="size-3.5" /> Run allocation
        </Button>
      </div>

      {/* table */}
      <Card className="overflow-hidden border-border/70 shadow-none">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[880px] border-collapse text-sm">
            <thead>
              <tr className="border-b border-border/60 text-left">
                {["Order", "Customer", "Priority", "Deadline", "Progress", "Stage", ""].map((h) => (
                  <th key={h} className="micro-label px-4 py-2.5 font-semibold">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {visible.map((o) => {
                const total = o.items.reduce((s, i) => s + i.qty, 0);
                const alloc = o.items.reduce((s, i) => s + i.allocated, 0);
                const pct = total > 0 ? Math.round((alloc / total) * 100) : 0;
                const h = hoursToDeadline(o.deadline);
                return (
                  <tr
                    key={o._id}
                    onClick={() => setSelected(o)}
                    className="cursor-pointer border-b border-border/40 transition-colors hover:bg-accent/50"
                  >
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <span className="mono text-xs font-bold">{o.orderNumber}</span>
                        {o.isDemoScenario && <DemoTag />}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-[13px] text-muted-foreground">{o.customer}</td>
                    <td className="px-4 py-3"><PriorityBadge priority={o.priority} /></td>
                    <td className="px-4 py-3">
                      <span className={cn("tnum text-xs font-semibold", h < 24 ? "text-swissred" : h < 72 ? "text-amber-300" : "text-muted-foreground")}>
                        {fmtDeadline(o.deadline)}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <div className="h-1.5 w-20 bg-muted">
                          <div className={cn("h-full", pct === 100 ? "bg-emerald-500" : "bg-swissblue")} style={{ width: `${pct}%` }} />
                        </div>
                        <span className="tnum text-[11px] text-muted-foreground">{alloc}/{total}</span>
                      </div>
                    </td>
                    <td className="px-4 py-3"><StatusBadge status={o.status} /></td>
                    <td className="px-4 py-3 text-right">
                      <ScanSearch className="ml-auto size-4 text-muted-foreground" />
                    </td>
                  </tr>
                );
              })}
              {visible.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-4 py-10 text-center text-sm text-muted-foreground">
                    No orders match the current filters.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>

      {/* ------------------------------------------------ detail sheet */}
      <Sheet open={!!selected} onOpenChange={(open) => { if (!open) setSelected(null); }}>
        <SheetContent className="w-full overflow-y-auto border-l border-border/70 bg-card sm:max-w-xl">
          {selected && (
            <>
              <SheetHeader>
                <div className="flex items-center gap-2">
                  <SheetTitle className="mono text-lg font-bold">{selected.orderNumber}</SheetTitle>
                  {selected.isDemoScenario && <DemoTag />}
                </div>
                <SheetDescription className="text-sm">
                  {selected.customer} · <PriorityBadge priority={selected.priority} /> <StatusBadge status={selected.status} />
                </SheetDescription>
              </SheetHeader>

              <div className="mt-5 grid grid-cols-3 gap-px border border-border/70 bg-border/40 text-center">
                <div className="bg-card p-3">
                  <p className="micro-label">Deadline</p>
                  <p className={cn("tnum mt-1 text-sm font-bold", hoursToDeadline(selected.deadline) < 24 ? "text-swissred" : "")}>{fmtDeadline(selected.deadline)}</p>
                </div>
                <div className="bg-card p-3">
                  <p className="micro-label">Created</p>
                  <p className="tnum mt-1 text-sm font-bold">{new Date(selected.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}</p>
                </div>
                <div className="bg-card p-3">
                  <p className="micro-label">Customer trust</p>
                  <div className="mt-1 flex justify-center"><CustomerTrust customer={selected.customer} /></div>
                </div>
              </div>

              {selected.notes && (
                <p className="mt-4 border-l-2 border-swissblue pl-3 text-xs leading-5 text-muted-foreground">{selected.notes}</p>
              )}

              <div className="mt-6">
                <p className="micro-label mb-3">Lines</p>
                <div className="space-y-px border border-border/70 bg-border/40">
                  {selected.items.map((item) => (
                    <div key={item.productId} className="bg-card p-4">
                      <div className="flex items-baseline justify-between gap-3">
                        <div>
                          <p className="mono text-xs font-bold">{item.sku}</p>
                          <p className="text-[11px] text-muted-foreground">{item.name}</p>
                        </div>
                        <p className="tnum text-sm font-bold">{fmtCurrency(item.price)}</p>
                      </div>
                      <div className="mt-3 grid grid-cols-4 gap-px border border-border/40 bg-border/40 text-center">
                        <Cell label="Qty" value={item.qty} />
                        <Cell label="Allocated" value={item.allocated} />
                        <Cell label="Picked" value={item.picked} />
                        <Cell label="Packed" value={item.packed} />
                      </div>
                      <div className="mt-2 flex items-center justify-between">
                        <LineAvailability productId={item.productId} />
                        {item.qty - item.allocated > 0 && (
                          <span className="tnum text-[11px] font-bold text-swissred">short {item.qty - item.allocated}</span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* stage actions */}
              <div className="mt-6 space-y-3">
                {(selected.status === "pending" || selected.status === "review") && (
                  <Button type="button" className="w-full gap-2" onClick={runAllocation} disabled={busy === "wave"}>
                    <Play className="size-4" /> Run allocation wave for open orders
                  </Button>
                )}
                {selected.status === "allocated" && (
                  <Button type="button" className="w-full gap-2" disabled={busy === "Start picking"} onClick={() => act(() => startPicking({ orderId: selected._id }), "Start picking")}>
                    <PackageCheck className="size-4" /> Start picking
                  </Button>
                )}
                {selected.status === "picked" && (
                  <Button type="button" className="w-full gap-2" disabled={busy === "Pack"} onClick={() => act(() => packOrder({ orderId: selected._id }), "Pack")}>
                    <PackageCheck className="size-4" /> Pack order
                  </Button>
                )}
                {selected.status === "packed" && (
                  <Button type="button" className="w-full gap-2" disabled={busy === "QC"} onClick={() => act(() => qcOrder({ orderId: selected._id }), "QC")}>
                    <ClipboardCheck className="size-4" /> Pass QC
                  </Button>
                )}
                {selected.status === "qc" && (
                  <Button type="button" className="w-full gap-2" onClick={() => { setDispatchTarget(selected); setTracking(""); }}>
                    <Truck className="size-4" /> Dispatch order
                  </Button>
                )}
                {selected.status === "dispatched" && (() => {
                  const shipment = shipments.find((s) => s.orderId === selected._id && s.status === "in_transit");
                  if (!shipment) return null;
                  return (
                    <Button type="button" className="w-full gap-2" disabled={busy === "Mark delivered"} onClick={() => act(() => markDelivered({ shipmentId: shipment._id }), "Mark delivered")}>
                      <Truck className="size-4" /> Mark delivered
                    </Button>
                  );
                })()}
                <p className="text-center text-[11px] text-muted-foreground">
                  {selected.status === "picking" && "Complete picking tasks in Operations to advance."}
                  {selected.status === "fulfilled" && "Order fulfilled — shipment complete."}
                  {selected.status === "cancelled" && "Order cancelled by customer."}
                </p>
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>

      {/* ------------------------------------------------ dispatch dialog */}
      <Dialog open={!!dispatchTarget} onOpenChange={(open) => { if (!open) setDispatchTarget(null); }}>
        <DialogContent className="border-border/70 bg-card">
          <DialogHeader>
            <DialogTitle className="text-base font-bold">Dispatch {dispatchTarget?.orderNumber}</DialogTitle>
            <DialogDescription className="text-sm text-muted-foreground">
              Create an in-transit shipment for {dispatchTarget?.customer}.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4">
            <div className="grid gap-2">
              <span className="micro-label">Carrier</span>
              <div className="flex gap-1.5">
                {CARRIERS.map((c) => (
                  <button
                    key={c}
                    type="button"
                    onClick={() => setCarrier(c)}
                    className={cn(
                      "flex-1 px-3 py-2 text-xs font-bold uppercase tracking-[0.08em]",
                      carrier === c ? "bg-swissred text-white" : "border border-border/60 text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {c}
                  </button>
                ))}
              </div>
            </div>
            <div className="grid gap-2">
              <span className="micro-label">Tracking number</span>
              <Input value={tracking} onChange={(e) => setTracking(e.target.value)} placeholder="e.g. 1Z999AA10123456784" className="mono" />
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setDispatchTarget(null)}>Cancel</Button>
            <Button type="button" onClick={doDispatch} disabled={busy === "dispatch" || !tracking.trim()}>
              {busy === "dispatch" ? "Dispatching…" : "Create shipment"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </motion.div>
  );
}

function Cell({ label, value }: { label: string; value: number }) {
  return (
    <div className="bg-card p-2">
      <p className="micro-label">{label}</p>
      <p className="tnum mt-0.5 text-sm font-bold">{value}</p>
    </div>
  );
}

/** Per-line live availability — a reactive QUERY (§7.8), never local state. */
function LineAvailability({ productId }: { productId: Id<"products"> }) {
  const availability = useQuery(api.analytics.availability, { productId });
  if (!availability) return <span className="text-[11px] text-muted-foreground">availability…</span>;
  return (
    <span className="tnum text-[11px] text-muted-foreground">
      on hand <b className="text-foreground">{availability.onHand}</b> · reserved <b className="text-foreground">{availability.reserved}</b> · available{" "}
      <b className={availability.available === 0 ? "text-swissred" : "text-foreground"}>{availability.available}</b>
    </span>
  );
}

function CustomerTrust({ customer }: { customer: string }) {
  const trust = useQuery(api.analytics.customerTrustScore, { customer });
  if (!trust) return <span className="text-[11px] text-muted-foreground">…</span>;
  return <TrustBadge score={trust.score} />;
}
