/**
 * HowItWorks.tsx — §10.4 one-screen "How this works" reference, written for a
 * non-technical warehouse manager (no formulas, no code identifiers). Each
 * block ends in a "see it live →" deep link to the exact place demonstrating it.
 */
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { ArrowUpRight } from "lucide-react";
import { Link } from "react-router";

const BLOCKS = [
  {
    index: "01",
    title: "Scoring",
    body: "Every order gets a score from three things: how important the customer priority is, how close the deadline is, and how much the order is worth — with the value part capped so a big order can never jump the line ahead of an urgent one. Higher score gets stock first.",
    href: "/dashboard/crisis",
    cta: "See it live — URG-2001's score",
  },
  {
    index: "02",
    title: "Reallocation",
    body: "When stock runs short, the system can pull reserved units away from a lower-priority order and give them to the higher-priority one. It only does this when the revenue it protects outweighs the damage to the donor's relationship — and it tells you both numbers before you confirm.",
    href: "/dashboard/crisis",
    cta: "See it live — the Reallocate dialog",
  },
  {
    index: "03",
    title: "Trust",
    body: "Every decision is logged against the customer it affected. Raiding someone's order hurts their trust score; delivering on time builds it back. Below a floor of 40, a customer is protected — the system refuses to reallocate from them, even if it costs revenue.",
    href: "/dashboard/crisis?focus=URG-2002",
    cta: "See it live — a withheld reallocation",
  },
  {
    index: "04",
    title: "Decision simulator",
    body: "Start from the live situation: pick an order that needs a decision, choose between allocation, reallocation, partial fulfillment and more, approve when required, and see the simulated business impact — profit, complaints, delays, trade-offs — before you commit. The scenario lab lets you build custom what-ifs with the same engine.",
    href: "/dashboard/simulator",
    cta: "See it live — the decision desk",
  },
];

export function HowItWorks({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl border-border/70 bg-card">
        <DialogHeader>
          <DialogTitle className="text-xl font-bold tracking-tight">How WarehouseOS works</DialogTitle>
          <DialogDescription className="text-sm leading-6 text-muted-foreground">
            Four ideas run the whole system. Each one has a live example you can open right now.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-px border border-border/70 bg-border/40 sm:grid-cols-2">
          {BLOCKS.map((b) => (
            <div key={b.index} className="bg-card p-5">
              <p className="mono text-[10px] text-swissblue">{b.index}</p>
              <h3 className="mt-2 text-sm font-bold uppercase tracking-[0.1em]">{b.title}</h3>
              <p className="mt-2 text-xs leading-5 text-muted-foreground">{b.body}</p>
              <Link
                to={b.href}
                onClick={() => onOpenChange(false)}
                className="mt-4 inline-flex items-center gap-1 text-xs font-bold text-swissblue transition-colors hover:text-blue-300"
              >
                {b.cta} <ArrowUpRight className="size-3.5" />
              </Link>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
