/**
 * Tour.tsx — §10.2 five-step spotlight tour. Shown once per browser
 * (localStorage `warehouseos_tour_seen`), dismissible, and replayable anytime
 * from the top-bar "?" icon. Steps navigate to their target route, then a
 * highlight box tracks the target element.
 */
import { AnimatePresence, motion } from "framer-motion";
import { X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { Button } from "@/components/ui/button";

export const TOUR_KEY = "warehouseos_tour_seen";

export const TOUR_STEPS = [
  {
    target: "tour-kpis",
    route: "/dashboard",
    title: "Warehouse health at a glance",
    body: "The Overview turns live warehouse data into decisions: open and at-risk orders, revenue at risk, on-time fulfillment, and the Customer Trust Index.",
  },
  {
    target: "tour-wave-btn",
    route: "/dashboard",
    title: "This button makes decisions",
    body: "Run allocation wave scores every open order, grants stock greedily to the highest-scoring one, and raises shortfall alerts the moment supply runs short.",
  },
  {
    target: "tour-crisis-badge",
    route: "/dashboard",
    title: "Live dilemmas are waiting",
    body: "The Crisis badge counts open alerts. Two live dilemmas — URG-2001 and URG-2002 — are waiting for you right now.",
  },
  {
    target: "tour-crisis-card",
    route: "/dashboard/crisis",
    title: "Watch a decision get made",
    body: "Open URG-2001, expand Why?, then Reallocate. You'll see the donor's trust score and the exact impact before you confirm.",
  },
  {
    target: "tour-sim-nav",
    route: "/dashboard",
    title: "Test before it happens",
    body: "The Simulator runs the exact production engine on what-if scenarios. Add a line, watch revenue at risk change, apply when confident.",
  },
];

type Rect = { top: number; left: number; width: number; height: number } | null;

export function Tour({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [step, setStep] = useState(0);
  const [rect, setRect] = useState<Rect>(null);
  const [ready, setReady] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();
  const rafRef = useRef<number | null>(null);

  const current = TOUR_STEPS[Math.min(step, TOUR_STEPS.length - 1)];

  // navigate to the step's route whenever the step changes
  useEffect(() => {
    if (!open) return;
    setReady(false);
    setRect(null);
    const target = TOUR_STEPS[Math.min(step, TOUR_STEPS.length - 1)];
    if (location.pathname !== target.route) {
      navigate(target.route);
    }
  }, [open, step, location.pathname, navigate]);

  // measure the target element once the route has settled
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const measure = () => {
      const el = document.getElementById(current.target);
      if (!el) return;
      const r = el.getBoundingClientRect();
      if (!cancelled) {
        setRect({ top: r.top, left: r.left, width: r.width, height: r.height });
        setReady(true);
      }
    };
    const timer = window.setTimeout(measure, 450);
    const onScroll = () => window.requestAnimationFrame(measure);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
      if (rafRef.current) window.cancelAnimationFrame(rafRef.current);
    };
  }, [open, step, current.target, location.pathname]);

  const finish = () => {
    localStorage.setItem(TOUR_KEY, "1");
    onClose();
  };

  const skip = () => {
    localStorage.setItem(TOUR_KEY, "1");
    onClose();
  };

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-[80]"
        >
          {/* backdrop — click to dismiss */}
          <div
            className="absolute inset-0 bg-black/70"
            onClick={() => {
              localStorage.setItem(TOUR_KEY, "1");
              onClose();
            }}
          />

          {/* highlighted target */}
          {ready && rect && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="absolute border-2 border-swissblue bg-swissblue/10 shadow-[0_0_0_9999px_rgba(0,0,0,0)]"
              style={{
                top: rect.top - 4,
                left: rect.left - 4,
                width: rect.width + 8,
                height: rect.height + 8,
                pointerEvents: "none",
              }}
            />
          )}

          {/* step card */}
          <div className="absolute inset-x-0 bottom-8 flex justify-center px-4">
            <motion.div
              key={step}
              initial={{ opacity: 0, y: 24 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.3 }}
              className="w-full max-w-lg border border-border/70 bg-card p-6 shadow-2xl"
            >
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="micro-label mb-2">
                    Step {step + 1} of {TOUR_STEPS.length}
                  </p>
                  <h3 className="text-lg font-bold tracking-tight">{current.title}</h3>
                  <p className="mt-2 text-sm leading-6 text-muted-foreground">{current.body}</p>
                </div>
                <button
                  type="button"
                  onClick={skip}
                  className="shrink-0 text-muted-foreground transition-colors hover:text-foreground"
                  aria-label="Close tour"
                >
                  <X className="size-4" />
                </button>
              </div>
              <div className="mt-6 flex items-center justify-between">
                <div className="flex gap-1.5">
                  {TOUR_STEPS.map((_, i) => (
                    <span
                      key={i}
                      className={`h-1 w-6 ${i === step ? "bg-swissred" : "bg-muted"}`}
                    />
                  ))}
                </div>
                <div className="flex items-center gap-3">
                  {step > 0 && (
                    <Button type="button" variant="ghost" size="sm" onClick={() => setStep((s) => s - 1)}>
                      Back
                    </Button>
                  )}
                  <Button
                    type="button"
                    size="sm"
                    onClick={() => (step === TOUR_STEPS.length - 1 ? finish() : setStep((s) => s + 1))}
                  >
                    {step === TOUR_STEPS.length - 1 ? "Finish" : "Next"}
                  </Button>
                </div>
              </div>
            </motion.div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
