import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { computeReserved, type ProductState } from "@/convex/domain";
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
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { HealthBadge, healthFor } from "@/components/warehouse/badges";
import { fmtCurrency, fmtNumber } from "@/lib/format";
import { motion } from "framer-motion";
import { PackagePlus, RotateCcw } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

type ProductRow = ProductState & { reserved: number; available: number };

export default function Inventory() {
  const products = useQuery(api.analytics.listProducts);
  const orders = useQuery(api.analytics.listOrders);
  const raiseReorder = useMutation(api.alerts.raiseReorder);
  const receiveStock = useMutation(api.alerts.receiveStock);

  const [restockTarget, setRestockTarget] = useState<ProductState | null>(null);
  const [restockQty, setRestockQty] = useState("");
  const [restocking, setRestocking] = useState(false);
  const [reorderBusy, setReorderBusy] = useState<string | null>(null);

  const rows: ProductRow[] = useMemo(() => {
    if (!products || !orders) return [];
    return products.map((p) => ({
      ...p,
      reserved: computeReserved(p._id, orders),
      available: Math.max(0, p.onHand - computeReserved(p._id, orders)),
    }));
  }, [products, orders]);

  if (!products || !orders) {
    return <Skeleton className="h-96 w-full" />;
  }

  const handleReorder = async (p: ProductRow) => {
    setReorderBusy(p._id);
    try {
      await raiseReorder({ productId: p._id });
      toast.success(`Reorder raised for ${p.sku}`, {
        description: `PO for ${p.reorderQty} units with ${p.supplier} (lead time ${p.leadTimeDays}d)`,
      });
    } catch (e) {
      toast.error("Reorder failed", { description: e instanceof Error ? e.message : "Unknown error" });
    } finally {
      setReorderBusy(null);
    }
  };

  const handleRestock = async () => {
    if (!restockTarget) return;
    const qty = Number(restockQty);
    if (!Number.isFinite(qty) || qty <= 0) {
      toast.error("Quantity must be greater than 0");
      return;
    }
    setRestocking(true);
    try {
      const res = await receiveStock({ productId: restockTarget._id, qty });
      if (res.applied) {
        toast.success(`${qty} × ${restockTarget.sku} received`, {
          description: `On hand is now ${res.onHand}.`,
        });
        setRestockTarget(null);
        setRestockQty("");
      } else {
        toast.error("Could not receive stock", { description: res.reason });
      }
    } catch (e) {
      toast.error("Restock failed", { description: e instanceof Error ? e.message : "Unknown error" });
    } finally {
      setRestocking(false);
    }
  };

  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.35 }}>
      <Card className="border-border/70 shadow-none">
        <CardHeader className="pb-0">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <CardTitle className="text-sm font-bold uppercase tracking-[0.12em]">Stock ledger</CardTitle>
              <p className="mt-1 text-xs text-muted-foreground">
                {rows.length} products · reserved = Σ allocated − picked across open orders
              </p>
            </div>
            <div className="flex items-center gap-4 text-[11px] text-muted-foreground">
              <span><span className="mr-1.5 inline-block size-2 bg-emerald-500/70" />OK</span>
              <span><span className="mr-1.5 inline-block size-2 bg-amber-500/70" />Low</span>
              <span><span className="mr-1.5 inline-block size-2 bg-swissred" />Out</span>
            </div>
          </div>
        </CardHeader>
        <CardContent className="pt-5">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[820px] border-collapse text-sm">
              <thead>
                <tr className="border-b border-border/60 text-left">
                  {["SKU", "Product", "Zone / Bin", "On hand", "Reserved", "Available", "Reorder pt", "Price", ""].map((h) => (
                    <th key={h} className="micro-label px-3 py-2 font-semibold">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((p) => {
                  const health = healthFor(p.onHand, p.reorderPoint);
                  return (
                    <tr
                      key={p._id}
                      className={cn(
                        "border-b border-border/40 transition-colors hover:bg-accent/50",
                        health === "out" && "bg-swissred/5",
                        health === "low" && "bg-amber-500/5",
                      )}
                    >
                      <td className="mono px-3 py-3 text-xs font-bold">{p.sku}</td>
                      <td className="px-3 py-3">
                        <p className="text-[13px] font-semibold">{p.name}</p>
                        <p className="text-[11px] text-muted-foreground">{p.category}</p>
                      </td>
                      <td className="mono px-3 py-3 text-xs text-muted-foreground">
                        {p.zone} · {p.bin}
                      </td>
                      <td className={cn("tnum px-3 py-3 font-bold", p.onHand === 0 ? "text-swissred" : "")}>{fmtNumber(p.onHand)}</td>
                      <td className="tnum px-3 py-3 text-muted-foreground">{fmtNumber(p.reserved)}</td>
                      <td className={cn("tnum px-3 py-3 font-semibold", p.available === 0 && p.onHand > 0 ? "text-amber-300" : "")}>
                        {fmtNumber(p.available)}
                      </td>
                      <td className="tnum px-3 py-3 text-muted-foreground">{p.reorderPoint}</td>
                      <td className="tnum px-3 py-3">{fmtCurrency(p.price)}</td>
                      <td className="px-3 py-3">
                        <div className="flex items-center justify-end gap-2">
                          <HealthBadge health={health} />
                          <Button type="button" variant="outline" size="icon-sm" onClick={() => handleReorder(p)} disabled={reorderBusy === p._id} aria-label={`Reorder ${p.sku}`}>
                            <RotateCcw className={cn("size-3.5", reorderBusy === p._id && "animate-spin")} />
                          </Button>
                          <Button type="button" variant="outline" size="icon-sm" onClick={() => { setRestockTarget(p); setRestockQty(String(p.reorderQty)); }} aria-label={`Receive stock for ${p.sku}`}>
                            <PackagePlus className="size-3.5" />
                          </Button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      <Dialog open={!!restockTarget} onOpenChange={(open) => { if (!open) setRestockTarget(null); }}>
        <DialogContent className="border-border/70 bg-card">
          <DialogHeader>
            <DialogTitle className="text-base font-bold">Receive stock</DialogTitle>
            <DialogDescription className="text-sm text-muted-foreground">
              {restockTarget?.sku} — {restockTarget?.name}. Current on hand:{" "}
              <span className="tnum font-bold text-foreground">{restockTarget?.onHand ?? 0}</span> (reorder point {restockTarget?.reorderPoint}).
            </DialogDescription>
          </DialogHeader>
          <div className="flex items-center gap-3">
            <Input
              type="number"
              min={1}
              value={restockQty}
              onChange={(e) => setRestockQty(e.target.value)}
              placeholder="Quantity"
              autoFocus
            />
            <span className="micro-label shrink-0">units</span>
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setRestockTarget(null)}>Cancel</Button>
            <Button type="button" onClick={handleRestock} disabled={restocking || !Number.isFinite(Number(restockQty)) || Number(restockQty) <= 0}>
              {restocking ? "Receiving…" : "Receive stock"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </motion.div>
  );
}
