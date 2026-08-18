import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { motion } from "framer-motion";
import { AlertOctagon, CheckCircle2, Hand, PackageX } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";

const PICKERS = ["Amara Mensah", "Dana Kowalski", "Lukas Fontaine", "Priya Novak", "Tom Okafor"];

type TaskWithOrder = {
  _id: Id<"pickingTasks">;
  sku: string;
  name: string;
  zone: string;
  bin: string;
  qty: number;
  picked: number;
  status: "pending" | "in_progress" | "picked";
  assignee?: string;
  orderNumber: string;
};

export default function Operations() {
  const tasks = useQuery(api.analytics.listTasks);
  const orders = useQuery(api.analytics.listOrders);
  const claimTask = useMutation(api.fulfillment.claimTask);
  const completeTask = useMutation(api.fulfillment.completeTask);
  const issueTask = useMutation(api.fulfillment.issueTask);

  const [claimTarget, setClaimTarget] = useState<TaskWithOrder | null>(null);
  const [assignee, setAssignee] = useState("");
  const [completeTarget, setCompleteTarget] = useState<TaskWithOrder | null>(null);
  const [pickedQty, setPickedQty] = useState("");

  const open: TaskWithOrder[] = useMemo(() => {
    if (!tasks || !orders) return [];
    const orderBy = new Map(orders.map((o) => [o._id, o.orderNumber]));
    return tasks
      .filter((t) => t.status !== "picked")
      .map((t) => ({
        _id: t._id,
        sku: t.sku,
        name: t.name,
        zone: t.zone,
        bin: t.bin,
        qty: t.qty,
        picked: t.picked,
        status: t.status,
        assignee: t.assignee,
        orderNumber: orderBy.get(t.orderId) ?? "—",
      }))
      .sort((a, b) => a.zone.localeCompare(b.zone) || a.bin.localeCompare(b.bin));
  }, [tasks, orders]);

  const zones = useMemo(() => {
    const map = new Map<string, TaskWithOrder[]>();
    for (const t of open) {
      const list = map.get(t.zone) ?? [];
      list.push(t);
      map.set(t.zone, list);
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [open]);

  if (!tasks || !orders) return <Skeleton className="h-96 w-full" />;

  const handleClaim = async () => {
    if (!claimTarget) return;
    if (!assignee.trim()) {
      toast.error("Enter a picker name");
      return;
    }
    try {
      const res = await claimTask({ taskId: claimTarget._id, assignee: assignee.trim() });
      if (res.applied) toast.success(`Task claimed by ${assignee.trim()}`);
      else toast.error("Could not claim", { description: res.reason });
      setClaimTarget(null);
      setAssignee("");
    } catch (e) {
      toast.error("Claim failed", { description: e instanceof Error ? e.message : "" });
    }
  };

  const handleComplete = async () => {
    if (!completeTarget) return;
    const qty = Number(pickedQty);
    if (!Number.isFinite(qty) || qty <= 0 || qty > completeTarget.qty - completeTarget.picked) {
      toast.error(`Enter a quantity between 1 and ${completeTarget.qty - completeTarget.picked}`);
      return;
    }
    try {
      const res = await completeTask({ taskId: completeTarget._id, pickedQty: qty });
      if (res.applied) {
        toast.success(`${qty} × ${completeTarget.sku} picked`, {
          description: res.fullyPicked ? "Task complete — order advanced." : "Partial pick recorded.",
        });
      } else {
        toast.error("Could not complete", { description: res.reason });
      }
      setCompleteTarget(null);
      setPickedQty("");
    } catch (e) {
      toast.error("Complete failed", { description: e instanceof Error ? e.message : "" });
    }
  };

  const handleIssue = async (task: TaskWithOrder, issue: "missing" | "damaged") => {
    try {
      const res = await issueTask({ taskId: task._id, issue });
      if (res.applied) {
        toast.warning(`${issue === "missing" ? "Missing" : "Damaged"} item flagged on ${task.sku}`, {
          description: "Alert raised — resolve it in Crisis Mode.",
        });
      } else {
        toast.error("Could not flag issue", { description: res.reason });
      }
    } catch (e) {
      toast.error("Issue failed", { description: e instanceof Error ? e.message : "" });
    }
  };

  const backlog = open.length;
  const inProgress = open.filter((t) => t.status === "in_progress").length;

  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.35 }} className="space-y-6">
      <div className="flex flex-wrap items-center gap-6">
        <div>
          <p className="micro-label">Picking backlog</p>
          <p className="tnum text-2xl font-bold">{backlog}</p>
        </div>
        <div>
          <p className="micro-label">In progress</p>
          <p className="tnum text-2xl font-bold text-swissblue">{inProgress}</p>
        </div>
        <p className="max-w-md text-xs leading-5 text-muted-foreground">
          Tasks are grouped by zone. Claim a task to take ownership, complete it to
          commit stock at pick time, or flag a missing/damaged item.
        </p>
      </div>

      <div className="grid gap-5 lg:grid-cols-2 xl:grid-cols-3">
        {zones.map(([zone, list]) => (
          <section key={zone} className="border border-border/70 bg-card">
            <header className="flex items-center justify-between border-b border-border/60 px-4 py-3">
              <div className="flex items-center gap-3">
                <span className="mono flex size-8 items-center justify-center border border-swissblue/50 bg-swissblue/10 text-sm font-bold text-blue-300">
                  {zone}
                </span>
                <div>
                  <p className="text-xs font-bold uppercase tracking-[0.12em]">Zone {zone}</p>
                  <p className="text-[11px] text-muted-foreground">
                    {list.filter((t) => t.status === "in_progress").length} in progress · {list.length} open
                  </p>
                </div>
              </div>
            </header>
            <div className="space-y-3 p-4">
              {list.map((t) => (
                <div key={t._id} className="border border-border/50 bg-background/60 p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="flex items-center gap-2">
                        <p className="mono text-xs font-bold">{t.sku}</p>
                        <Badge variant="outline" className={cn("text-[10px]", t.status === "in_progress" ? "border-swissblue/50 text-blue-300" : "text-muted-foreground")}>
                          {t.status === "in_progress" ? "IN PROGRESS" : "PENDING"}
                        </Badge>
                      </div>
                      <p className="mt-1 text-xs text-muted-foreground">{t.name}</p>
                      <p className="mono mt-1.5 text-[11px] text-muted-foreground">
                        {t.orderNumber} · bin {t.bin}
                      </p>
                    </div>
                    <div className="text-right">
                      <p className="tnum text-lg font-bold">
                        {t.picked}<span className="text-sm text-muted-foreground">/{t.qty}</span>
                      </p>
                      {t.assignee && (
                        <p className="text-[11px] text-swissblue">→ {t.assignee}</p>
                      )}
                    </div>
                  </div>
                  <div className="mt-3 h-1.5 w-full bg-muted">
                    <div className="h-full bg-swissblue/70" style={{ width: `${(t.picked / t.qty) * 100}%` }} />
                  </div>
                  <div className="mt-4 flex flex-wrap gap-2">
                    {t.status === "pending" ? (
                      <Button type="button" size="sm" variant="outline" className="gap-1.5" onClick={() => { setClaimTarget(t); setAssignee(t.assignee ?? ""); }}>
                        <Hand className="size-3.5" /> Claim
                      </Button>
                    ) : (
                      <Button type="button" size="sm" variant="outline" className="gap-1.5" onClick={() => { setClaimTarget(t); setAssignee(t.assignee ?? ""); }}>
                        <Hand className="size-3.5" /> Re-assign
                      </Button>
                    )}
                    <Button type="button" size="sm" className="gap-1.5" onClick={() => { setCompleteTarget(t); setPickedQty(String(t.qty - t.picked)); }}>
                      <CheckCircle2 className="size-3.5" /> Complete
                    </Button>
                    <Button type="button" size="sm" variant="ghost" className="gap-1.5 text-red-300 hover:bg-swissred/10 hover:text-red-200" onClick={() => handleIssue(t, "missing")}>
                      <PackageX className="size-3.5" /> Missing
                    </Button>
                    <Button type="button" size="sm" variant="ghost" className="gap-1.5 text-amber-300 hover:bg-amber-500/10 hover:text-amber-200" onClick={() => handleIssue(t, "damaged")}>
                      <AlertOctagon className="size-3.5" /> Damaged
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          </section>
        ))}
        {zones.length === 0 && (
          <p className="text-sm text-muted-foreground">All picking tasks are complete. Start picking from Orders.</p>
        )}
      </div>

      {/* claim dialog */}
      <Dialog open={!!claimTarget} onOpenChange={(open) => { if (!open) setClaimTarget(null); }}>
        <DialogContent className="border-border/70 bg-card">
          <DialogHeader>
            <DialogTitle className="text-base font-bold">Claim task</DialogTitle>
            <DialogDescription className="text-sm text-muted-foreground">
              {claimTarget?.sku} · {claimTarget?.bin} · {claimTarget?.orderNumber}
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <span className="micro-label">Picker</span>
            <Input
              list="pickers"
              value={assignee}
              onChange={(e) => setAssignee(e.target.value)}
              placeholder="Picker name"
              autoFocus
            />
            <datalist id="pickers">
              {PICKERS.map((p) => <option key={p} value={p} />)}
            </datalist>
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setClaimTarget(null)}>Cancel</Button>
            <Button type="button" onClick={handleClaim} disabled={!assignee.trim()}>Claim</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* complete dialog */}
      <Dialog open={!!completeTarget} onOpenChange={(open) => { if (!open) setCompleteTarget(null); }}>
        <DialogContent className="border-border/70 bg-card">
          <DialogHeader>
            <DialogTitle className="text-base font-bold">Record picked quantity</DialogTitle>
            <DialogDescription className="text-sm text-muted-foreground">
              {completeTarget?.sku} · {completeTarget?.bin} — stock is committed at pick time.
            </DialogDescription>
          </DialogHeader>
          <div className="flex items-center gap-3">
            <Input
              type="number"
              min={1}
              max={completeTarget ? completeTarget.qty - completeTarget.picked : 1}
              value={pickedQty}
              onChange={(e) => setPickedQty(e.target.value)}
              autoFocus
            />
            <span className="micro-label shrink-0">
              of {completeTarget ? completeTarget.qty - completeTarget.picked : 0} remaining
            </span>
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setCompleteTarget(null)}>Cancel</Button>
            <Button
              type="button"
              onClick={handleComplete}
              disabled={!completeTarget || Number(pickedQty) <= 0 || Number(pickedQty) > completeTarget.qty - completeTarget.picked}
            >
              Complete pick
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </motion.div>
  );
}
