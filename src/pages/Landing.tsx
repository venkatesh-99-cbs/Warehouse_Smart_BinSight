import { motion } from "framer-motion";
import {
  Activity,
  ArrowRight,
  ArrowUpRight,
  Boxes,
  ClipboardCheck,
  Cpu,
  FlaskConical,
  Radar,
  ShieldAlert,
  Zap,
} from "lucide-react";
import { Link } from "react-router";
import { Button } from "@/components/ui/button";

const AUTH_DASHBOARD = "/auth?returnTo=%2Fdashboard";

const LOOP_STEPS = [
  "Order",
  "Priority",
  "Inventory check",
  "Allocated",
  "Picking",
  "Packing",
  "QC",
  "Dispatch",
  "Inventory updated",
];

const FEATURES = [
  {
    index: "01",
    icon: Radar,
    title: "Monitor operations",
    body: "Live KPIs, pipeline funnel, stock health by zone, and every shortfall the moment it appears — one screen, zero spreadsheets.",
  },
  {
    index: "02",
    icon: Zap,
    title: "Optimize order fulfillment",
    body: "Orders are scored by urgency and bounded profit, then stock is granted greedily to the highest-scoring order — with partial allocation when supply runs short.",
  },
  {
    index: "03",
    icon: FlaskConical,
    title: "Simulate crisis decisions",
    body: "Project revenue at risk and compare against a naive FIFO baseline before touching live stock. What-if scenarios run the exact same engine as production.",
  },
  {
    index: "04",
    icon: ClipboardCheck,
    title: "Optimize warehouse picking",
    body: "Zone-grouped picking board with claim / complete / issue workflow, backlog per zone, and bottleneck alerts that move pickers where they're needed.",
  },
];

const fadeUp = {
  initial: { opacity: 0, y: 16 },
  whileInView: { opacity: 1, y: 0 },
  viewport: { once: true, margin: "-80px" },
  transition: { duration: 0.5, ease: [0.22, 1, 0.36, 1] as const },
};

export default function Landing() {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.5 }}
      className="min-h-screen bg-background text-foreground"
    >
      <div className="accent-bar" />

      {/* ---------------------------------------------------- header */}
      <header className="border-b border-border/60">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-5">
          <Link to="/" className="flex items-center gap-3">
            <span className="flex size-8 items-center justify-center bg-swissred text-white">
              <Boxes className="size-4" />
            </span>
            <span className="text-sm font-bold tracking-[0.22em] uppercase">WarehouseOS</span>
          </Link>
          <nav className="hidden items-center gap-8 text-[13px] font-medium text-muted-foreground md:flex">
            <a href="#decision-demo" className="transition-colors hover:text-foreground">
              Decision demo
            </a>
            <a href="#loop" className="transition-colors hover:text-foreground">
              Fulfillment loop
            </a>
            <a href="#crisis" className="transition-colors hover:text-foreground">
              Crisis mode
            </a>
            <a href="#features" className="transition-colors hover:text-foreground">
              Features
            </a>
          </nav>
          <Button asChild size="sm" className="gap-2">
            <Link to={AUTH_DASHBOARD}>
              Launch control room <ArrowRight className="size-3.5" />
            </Link>
          </Button>
        </div>
      </header>

      <main className="grid-fine">
        {/* ---------------------------------------------------- hero */}
        <section className="mx-auto max-w-6xl px-6 pt-20 pb-16 md:pt-28">
          <div className="grid gap-12 md:grid-cols-[1.2fr_1fr] md:items-end">
            <div>
              <motion.p {...fadeUp} className="micro-label mb-5">
                Autonomous warehouse decision platform
              </motion.p>
              <motion.h1
                {...fadeUp}
                className="max-w-xl text-5xl leading-[0.95] font-bold tracking-tight md:text-7xl"
              >
                The warehouse
                <span className="block text-swissred">that decides.</span>
              </motion.h1>
              <motion.p {...fadeUp} className="mt-6 max-w-lg text-base leading-7 text-muted-foreground">
                WarehouseOS turns inventory, orders, and workforce data into
                decisions — scoring urgency and value, allocating scarce stock,
                and reallocating it only when doing so protects revenue without
                eroding customer trust.
              </motion.p>
              <motion.div {...fadeUp} className="mt-9 flex flex-wrap items-center gap-4">
                <Button asChild size="lg" className="gap-2 px-7">
                  <Link to={AUTH_DASHBOARD}>
                    Launch control room <ArrowRight className="size-4" />
                  </Link>
                </Button>
                <Button asChild variant="outline" size="lg" className="px-7">
                  <a href="#decision-demo">See the decision engine</a>
                </Button>
              </motion.div>
            </div>

            <motion.div
              {...fadeUp}
              className="border border-border/70 bg-card p-6"
            >
              <p className="micro-label mb-6">System state — right now</p>
              <div className="space-y-5">
                {[
                  { k: "Open orders", v: "24", accent: "text-foreground" },
                  { k: "At risk (<24h)", v: "9", accent: "text-amber-300" },
                  { k: "Shortfall SKUs", v: "7", accent: "text-red-300" },
                  { k: "Trust-protected customers", v: "1", accent: "text-blue-300" },
                ].map((row) => (
                  <div key={row.k} className="flex items-baseline justify-between border-b border-border/40 pb-3">
                    <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                      {row.k}
                    </span>
                    <span className={`tnum text-2xl font-bold ${row.accent}`}>{row.v}</span>
                  </div>
                ))}
              </div>
            </motion.div>
          </div>
        </section>

        {/* ------------------------------------------- decision demo */}
        <section id="decision-demo" className="border-t border-border/60 bg-card/60">
          <div className="mx-auto max-w-6xl px-6 py-16 md:py-20">
            <motion.div {...fadeUp}>
              <p className="micro-label mb-3">Live decision demo</p>
              <h2 className="text-3xl font-bold tracking-tight md:text-4xl">
                Order URG-2001 needs 10 routers. <span className="text-swissred">Only 2 are free.</span>
              </h2>
            </motion.div>

            <div className="mt-10 grid gap-px overflow-hidden border border-border/70 bg-border/40 md:grid-cols-3">
              {/* dilemma */}
              <motion.div {...fadeUp} className="bg-card p-7">
                <p className="micro-label mb-5">01 · The dilemma</p>
                <p className="mono text-sm text-muted-foreground">WRT-8800 · Wi-Fi 6 Mesh Router</p>
                <div className="mt-6 space-y-5">
                  {[
                    { label: "On hand", value: "10", bar: "100%" },
                    { label: "Free (unreserved)", value: "2", bar: "20%" },
                    { label: "Reserved by ORD-3010", value: "5", bar: "50%" },
                    { label: "Reserved by ORD-3040", value: "3", bar: "30%" },
                  ].map((r) => (
                    <div key={r.label}>
                      <div className="mb-1.5 flex items-baseline justify-between">
                        <span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                          {r.label}
                        </span>
                        <span className="tnum text-sm font-bold">{r.value}</span>
                      </div>
                      <div className="h-1.5 w-full bg-muted">
                        <div
                          className="h-full bg-swissred"
                          style={{ width: r.label === "Free (unreserved)" ? "20%" : undefined }}
                        />
                      </div>
                    </div>
                  ))}
                </div>
                <p className="mt-6 text-xs leading-5 text-muted-foreground">
                  A lower-priority order already reserves 5 units. Naive systems
                  wait or backorder. WarehouseOS reallocates.
                </p>
              </motion.div>

              {/* decision */}
              <motion.div {...fadeUp} className="bg-card p-7">
                <p className="micro-label mb-5">02 · The decision</p>
                <div className="space-y-4">
                  {[
                    { t: "Score & allocate", d: "URG-2001 scores 165.8 — Urgent 100 + deadline 50 + value 15 (capped). Gets the 2 free units." },
                    { t: "Raise shortfall alert", d: "Still short 8 → partial allocation, crisis alert opened with a concrete suggestion." },
                    { t: "Reallocate, don't raid", d: "Draws 8 units from ORD-3010 + ORD-3040 — profit-positive and trust-safe (both at 100, zero recent raids)." },
                  ].map((s) => (
                    <div key={s.t} className="border-l-2 border-swissblue pl-4">
                      <p className="text-sm font-bold">{s.t}</p>
                      <p className="mt-1 text-xs leading-5 text-muted-foreground">{s.d}</p>
                    </div>
                  ))}
                </div>
                <p className="mt-6 text-xs leading-5 text-muted-foreground">
                  Donors are visibly backordered; every move lands in the decision ledger.
                </p>
              </motion.div>

              {/* the counter-case */}
              <motion.div {...fadeUp} className="bg-card p-7">
                <p className="micro-label mb-5">03 · When the system says no</p>
                <div className="flex items-start gap-3 border border-swissred/30 bg-swissred/5 p-4">
                  <ShieldAlert className="mt-0.5 size-4 shrink-0 text-red-300" />
                  <p className="text-xs leading-5 text-muted-foreground">
                    Order <span className="mono font-bold text-foreground">URG-2002</span> is short
                    8 batteries. The only holder of reserved stock — Cascade
                    Outfitters — was raided 3 times in the last 24 hours (trust
                    score 39, below the 40-point floor). Reallocation is{" "}
                    <span className="font-bold text-red-300">withheld</span>.
                    The system recommends an emergency PO instead.
                  </p>
                </div>
                <p className="mt-5 text-xs leading-5 text-muted-foreground">
                  Profit-seeking without eroding trust is a tested behavior
                  here, not a slogan. Open Crisis Mode to see it live.
                </p>
                <Button asChild variant="outline" size="sm" className="mt-6 gap-1.5">
                  <Link to={AUTH_DASHBOARD}>
                    Open Crisis Mode <ArrowUpRight className="size-3.5" />
                  </Link>
                </Button>
              </motion.div>
            </div>
          </div>
        </section>

        {/* ------------------------------------------- fulfillment loop */}
        <section id="loop" className="border-t border-border/60">
          <div className="mx-auto max-w-6xl px-6 py-16 md:py-20">
            <motion.div {...fadeUp} className="flex flex-wrap items-end justify-between gap-4">
              <div>
                <p className="micro-label mb-3">The fulfillment loop</p>
                <h2 className="text-3xl font-bold tracking-tight md:text-4xl">
                  From order to inventory-updated.
                </h2>
              </div>
              <p className="max-w-sm text-sm leading-6 text-muted-foreground">
                Stock is committed at pick time, shipments are created at
                dispatch, and every transition writes to the decision ledger.
              </p>
            </motion.div>
            <motion.div {...fadeUp} className="mt-10 grid grid-cols-2 gap-px border border-border/70 bg-border/40 sm:grid-cols-3 lg:grid-cols-9">
              {LOOP_STEPS.map((step, i) => (
                <div key={step} className="group bg-card p-4 transition-colors hover:bg-accent">
                  <p className="mono text-[10px] text-swissblue">{String(i + 1).padStart(2, "0")}</p>
                  <p className="mt-3 text-[13px] leading-4 font-bold uppercase tracking-[0.08em]">
                    {step}
                  </p>
                </div>
              ))}
            </motion.div>
          </div>
        </section>

        {/* ------------------------------------------- crisis mode */}
        <section id="crisis" className="border-t border-border/60 bg-swissred">
          <div className="mx-auto max-w-6xl px-6 py-16 text-white md:py-20">
            <motion.div {...fadeUp} className="max-w-2xl">
              <p className="micro-label mb-3 text-white/70">Crisis mode</p>
              <h2 className="text-3xl font-bold tracking-tight md:text-4xl">
                Exception → Decision → Resolution.
              </h2>
              <p className="mt-4 text-sm leading-6 text-white/85">
                Every alert follows the same path: the system detects the
                exception, computes the best decision with real numbers, and
                offers a resolution — with the Why? exposed before you confirm.
                And it knows when <span className="font-bold underline">not</span> to
                reallocate.
              </p>
            </motion.div>
            <motion.div {...fadeUp} className="mt-10 grid gap-6 md:grid-cols-3">
              {[
                { t: "Exception", d: "Shortfall, stockout, missing or damaged item, bottleneck, deadline risk — raised with concrete, entity-specific suggestions.", icon: Activity },
                { t: "Decision", d: "Scoring, reallocation with a profit-positive & trust-safe gate, emergency POs — computed from live state, never guessed.", icon: Cpu },
                { t: "Resolution", d: "Approve in one click. Every decision lands in a permanent ledger that drives the customer trust model.", icon: Zap },
              ].map((c) => (
                <div key={c.t} className="border border-white/25 p-6">
                  <c.icon className="size-5 text-white" />
                  <p className="mt-4 text-sm font-bold uppercase tracking-[0.12em]">{c.t}</p>
                  <p className="mt-2 text-xs leading-5 text-white/80">{c.d}</p>
                </div>
              ))}
            </motion.div>
          </div>
        </section>

        {/* ------------------------------------------- features */}
        <section id="features" className="border-t border-border/60">
          <div className="mx-auto max-w-6xl px-6 py-16 md:py-20">
            <motion.div {...fadeUp}>
              <p className="micro-label mb-3">Capabilities</p>
              <h2 className="text-3xl font-bold tracking-tight md:text-4xl">
                Built for the warehouse manager.
              </h2>
            </motion.div>
            <div className="mt-10 grid gap-px border border-border/70 bg-border/40 md:grid-cols-2">
              {FEATURES.map((f) => (
                <motion.div key={f.index} {...fadeUp} className="group bg-card p-8 transition-colors hover:bg-accent">
                  <div className="flex items-center justify-between">
                    <span className="mono text-xs text-swissblue">{f.index}</span>
                    <f.icon className="size-5 text-muted-foreground transition-colors group-hover:text-swissblue" />
                  </div>
                  <h3 className="mt-8 text-lg font-bold tracking-tight">{f.title}</h3>
                  <p className="mt-3 max-w-md text-sm leading-6 text-muted-foreground">{f.body}</p>
                </motion.div>
              ))}
            </div>
          </div>
        </section>

        {/* ------------------------------------------- CTA */}
        <section className="border-t border-border/60">
          <div className="mx-auto flex max-w-6xl flex-col items-start justify-between gap-8 px-6 py-16 md:flex-row md:items-center">
            <div>
              <p className="micro-label mb-3">Ready when you are</p>
              <h2 className="max-w-lg text-3xl font-bold tracking-tight md:text-4xl">
                Your warehouse is already full of decisions. Start making them.
              </h2>
            </div>
            <Button asChild size="lg" className="gap-2 px-8">
              <Link to={AUTH_DASHBOARD}>
                Launch control room <ArrowRight className="size-4" />
              </Link>
            </Button>
          </div>
        </section>
      </main>

      {/* ---------------------------------------------------- footer */}
      <footer className="border-t border-border/60">
        <div className="mx-auto flex max-w-6xl flex-col gap-6 px-6 py-10 md:flex-row md:items-center md:justify-between">
          <div className="flex items-center gap-3">
            <span className="flex size-7 items-center justify-center bg-swissred text-white">
              <Boxes className="size-3.5" />
            </span>
            <span className="text-xs font-bold tracking-[0.22em] uppercase">WarehouseOS</span>
          </div>
          <p className="text-xs text-muted-foreground">
            An autonomous warehouse decision platform · built for warehouse managers · © 2026
          </p>
          <div className="flex items-center gap-5 text-xs text-muted-foreground">
            <Link to={AUTH_DASHBOARD} className="transition-colors hover:text-foreground">Control room</Link>
            <Link to={AUTH_DASHBOARD} className="transition-colors hover:text-foreground">Sign in</Link>
          </div>
        </div>
      </footer>
    </motion.div>
  );
}
