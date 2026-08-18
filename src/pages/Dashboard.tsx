import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { HowItWorks } from "@/components/warehouse/HowItWorks";
import { Tour, TOUR_KEY } from "@/components/warehouse/Tour";
import {
  AlertTriangle,
  Bell,
  Boxes,
  CalendarDays,
  ClipboardCheck,
  FlaskConical,
  HelpCircle,
  LayoutDashboard,
  LogOut,
  Play,
  ScrollText,
  ShoppingCart,
  Zap,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link, NavLink, Outlet, useLocation, useNavigate } from "react-router";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

const NAV = [
  { to: "/dashboard", label: "Overview", icon: LayoutDashboard, tourId: undefined },
  { to: "/dashboard/inventory", label: "Inventory", icon: Boxes },
  { to: "/dashboard/orders", label: "Orders", icon: ShoppingCart },
  { to: "/dashboard/operations", label: "Operations", icon: ClipboardCheck },
  { to: "/dashboard/crisis", label: "Crisis Center", icon: AlertTriangle, tourId: "tour-crisis-badge" },
  { to: "/dashboard/simulator", label: "What-if Simulator", icon: FlaskConical, tourId: "tour-sim-nav" },
  { to: "/dashboard/activity", label: "Activity Logs", icon: ScrollText },
];

const TITLES: Record<string, string> = {
  "/dashboard": "Dashboard",
  "/dashboard/inventory": "Inventory",
  "/dashboard/orders": "Orders",
  "/dashboard/operations": "Operations",
  "/dashboard/crisis": "Crisis Center",
  "/dashboard/simulator": "What-if Simulator",
  "/dashboard/activity": "Activity Logs",
};

const SUBTITLES: Record<string, string> = {
  "/dashboard": "Real-time overview of warehouse operations",
  "/dashboard/inventory": "Stock position, health and reorder activity",
  "/dashboard/orders": "Order pipeline and fulfilment status",
  "/dashboard/operations": "Picking, packing and dispatch workflow",
  "/dashboard/crisis": "What needs attention right now",
  "/dashboard/simulator": "Test decisions and their impact before committing",
  "/dashboard/activity": "Audit trail — what happened and who decided it",
};

function initials(name?: string | null): string {
  if (!name) return "WM";
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const first = parts[0]?.[0] ?? "";
  const last = parts.length > 1 ? parts[parts.length - 1][0] : "";
  return (first + last).toUpperCase() || "WM";
}

export default function Dashboard() {
  const { user, signOut } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const alerts = useQuery(api.analytics.listAlerts);
  const ensureSeeded = useMutation(api.seed.ensureSeeded);
  const allocatePendingOrders = useMutation(api.allocation.allocatePendingOrders);

  const [clock, setClock] = useState(() => new Date());
  const [waveRunning, setWaveRunning] = useState(false);
  const [tourOpen, setTourOpen] = useState(false);
  const [howOpen, setHowOpen] = useState(false);
  const [seeded, setSeeded] = useState(false);

  useEffect(() => {
    const timer = window.setInterval(() => setClock(new Date()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  // §8 — seed on first dashboard load (idempotent). Per §10.5 the demo script,
  // the allocation wave itself is deliberately NOT auto-run: the user triggers
  // it via the "Run allocation wave" button (the tour teaches exactly this).
  useEffect(() => {
    let cancelled = false;
    ensureSeeded().then((res) => {
      if (cancelled) return;
      setSeeded(true);
      if (res.seeded) {
        toast.success(res.refreshed ? "Demo state refreshed" : "Warehouse data loaded", {
          description: res.refreshed
            ? "URG-2002's protection history was refreshed."
            : "20 products, 26 orders, 12 alerts seeded.",
        });
      }
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // §10.2 — first-run tour, once per browser, replayable from the "?" icon
  useEffect(() => {
    if (seeded && !localStorage.getItem(TOUR_KEY)) {
      const t = window.setTimeout(() => setTourOpen(true), 800);
      return () => window.clearTimeout(t);
    }
  }, [seeded]);

  const openAlertCount = useMemo(
    () => alerts?.filter((a) => a.status === "open").length ?? 0,
    [alerts],
  );

  const runWave = async () => {
    if (waveRunning) return;
    setWaveRunning(true);
    try {
      const res = await allocatePendingOrders();
      if (res.applied) {
        const s = res.stats;
        toast.success(`Allocation wave complete`, {
          description: `${s.processed} order(s) processed · ${s.fullyAllocated} fully allocated · ${s.partial} flagged · ${s.blocked} blocked`,
        });
      } else {
        toast.info("Allocation wave finished", { description: "No open orders to process." });
      }
    } catch (e) {
      toast.error("Allocation wave failed", {
        description: e instanceof Error ? e.message : "Unknown error",
      });
    } finally {
      setWaveRunning(false);
    }
  };

  const handleSignOut = async () => {
    await signOut();
    navigate("/");
  };

  const path = location.pathname;
  const title = TITLES[path] ?? "Control deck";
  const subtitle = SUBTITLES[path] ?? "Autonomous warehouse decision platform";

  return (
    <div className="min-h-screen bg-background text-foreground">
      {/* ------------------------------------------------- sidebar */}
      <aside className="fixed inset-y-0 left-0 z-40 hidden w-60 flex-col border-r border-border/60 bg-sidebar lg:flex">
        <div className="flex items-center gap-3 border-b border-border/60 px-5 py-5">
          <span className="flex size-9 items-center justify-center bg-primary text-primary-foreground">
            <Zap className="size-4" />
          </span>
          <div>
            <p className="text-[13px] leading-4 font-bold tracking-[0.14em] uppercase">WarehouseOS</p>
            <p className="mt-0.5 text-[10px] font-medium text-muted-foreground">Smart Warehouse</p>
          </div>
        </div>

        <nav className="flex-1 space-y-0.5 overflow-y-auto px-3 py-4">
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === "/dashboard"}
              id={item.tourId}
              className={({ isActive }) =>
                cn(
                  "group flex items-center justify-between border-l-2 px-3 py-2.5 text-[13px] font-semibold transition-colors",
                  isActive
                    ? "border-primary bg-primary/10 text-foreground"
                    : "border-transparent text-muted-foreground hover:bg-accent/60 hover:text-foreground",
                )
              }
            >
              <span className="flex items-center gap-3">
                <item.icon className={cn("size-4", "shrink-0")} />
                {item.label}
              </span>
              {item.label === "Crisis Center" && openAlertCount > 0 && (
                <span
                  className={cn(
                    "tnum flex h-5 min-w-5 items-center justify-center px-1 text-[10px] font-bold",
                    openAlertCount > 0 ? "bg-swissred text-white" : "bg-muted text-muted-foreground",
                  )}
                >
                  {openAlertCount}
                </span>
              )}
            </NavLink>
          ))}
        </nav>

        {/* today's snapshot + user profile */}
        <div className="border-t border-border/60 px-5 py-4">
          <p className="micro-label mb-2">Today's snapshot</p>
          <p className="text-[13px] leading-5 font-bold">
            {clock.toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" })}
          </p>
          <p className="mono mt-0.5 text-xs text-muted-foreground">
            {clock.toLocaleTimeString("en-US", { hour12: false })}
          </p>
          <div className="mt-4 flex items-center gap-3 border-t border-border/60 pt-4">
            <span className="flex size-9 shrink-0 items-center justify-center border border-primary/40 bg-primary/15 text-xs font-bold text-primary">
              {initials(user?.name)}
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-xs font-bold">{user?.name ?? "Warehouse Manager"}</p>
              <p className="truncate text-[11px] text-muted-foreground">Warehouse Manager</p>
            </div>
            <Button type="button" variant="ghost" size="icon-sm" onClick={handleSignOut} aria-label="Sign out">
              <LogOut className="size-4" />
            </Button>
          </div>
        </div>
      </aside>

      {/* ------------------------------------------------- main column */}
      <div className="lg:pl-60">
        <div className="accent-bar" />

        {/* mobile top bar */}
        <div className="flex items-center justify-between gap-3 border-b border-border/60 px-4 py-3 lg:hidden">
          <div className="flex items-center gap-2">
            <span className="flex size-7 items-center justify-center bg-primary text-primary-foreground">
              <Zap className="size-3.5" />
            </span>
            <div>
              <p className="text-[11px] leading-3 font-bold tracking-[0.12em] uppercase">WarehouseOS</p>
              <p className="text-[9px] text-muted-foreground">Smart Warehouse</p>
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            <Link to="/dashboard/crisis" aria-label="Crisis Center">
              <Button type="button" variant="outline" size="icon-sm" className="relative">
                <Bell className="size-4" />
                {openAlertCount > 0 && (
                  <span className="tnum absolute -top-1 -right-1 flex h-4 min-w-4 items-center justify-center bg-swissred px-0.5 text-[9px] font-bold text-white">
                    {openAlertCount}
                  </span>
                )}
              </Button>
            </Link>
            <Button type="button" variant="outline" size="icon-sm" onClick={() => setHowOpen(true)} aria-label="How it works">
              <HelpCircle className="size-4" />
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={handleSignOut}>
              <LogOut className="size-3.5" /> Sign out
            </Button>
          </div>
        </div>
        {/* mobile nav */}
        <nav className="flex gap-1 overflow-x-auto border-b border-border/60 px-3 py-2 lg:hidden">
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === "/dashboard"}
              id={item.tourId}
              className={({ isActive }) =>
                cn(
                  "flex shrink-0 items-center gap-1.5 px-2.5 py-1.5 text-xs font-semibold",
                  isActive ? "bg-primary/15 text-foreground" : "text-muted-foreground hover:text-foreground",
                )
              }
            >
              <item.icon className="size-3.5" />
              {item.label}
              {item.label === "Crisis Center" && openAlertCount > 0 && (
                <span className="tnum ml-0.5 text-[10px] font-bold text-swissred">{openAlertCount}</span>
              )}
            </NavLink>
          ))}
        </nav>

        {/* top bar */}
        <header className="sticky top-0 z-30 flex items-center justify-between gap-4 border-b border-border/60 bg-background/90 px-6 py-4 backdrop-blur">
          <div className="min-w-0">
            <h1 className="text-lg font-bold tracking-tight">{title}</h1>
            <p className="micro-label mt-0.5 hidden sm:block">{subtitle}</p>
          </div>
          <div className="flex items-center gap-2.5">
            <span className="hidden items-center gap-1.5 border border-border/60 px-3 py-1.5 text-[11px] font-semibold text-muted-foreground xl:flex">
              <CalendarDays className="size-3.5" />
              {clock.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })}
            </span>
            <Link to="/dashboard/crisis" aria-label="Open alerts" title={`${openAlertCount} open alert(s)`}>
              <Button type="button" variant="outline" size="icon" className="relative">
                <Bell className="size-4" />
                {openAlertCount > 0 && (
                  <span className="tnum absolute -top-1.5 -right-1.5 flex h-4 min-w-4 items-center justify-center bg-swissred px-1 text-[9px] font-bold text-white">
                    {openAlertCount}
                  </span>
                )}
              </Button>
            </Link>
            <Button
              type="button"
              size="sm"
              id="tour-wave-btn"
              className="gap-2"
              onClick={runWave}
              disabled={waveRunning}
            >
              {waveRunning ? (
                <>
                  <span className="size-3 animate-pulse bg-white/80" />
                  Running…
                </>
              ) : (
                <>
                  <Play className="size-3.5" />
                  Run allocation wave
                </>
              )}
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button type="button" variant="outline" size="icon" aria-label="Help">
                  <HelpCircle className="size-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-60 border-border/70">
                <DropdownMenuLabel>Learn the product</DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => setTourOpen(true)} className="cursor-pointer">
                  Replay the tour
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setHowOpen(true)} className="cursor-pointer">
                  How this works
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  aria-label="User menu"
                  className="flex items-center justify-center border-primary/40 bg-primary/10 text-xs font-bold text-primary"
                >
                  {initials(user?.name)}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56 border-border/70">
                <DropdownMenuLabel>
                  <p className="truncate text-xs font-bold">{user?.name ?? "Warehouse Manager"}</p>
                  <p className="truncate text-[11px] font-normal text-muted-foreground">{user?.email ?? "Signed in"}</p>
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => navigate("/dashboard/crisis")} className="cursor-pointer">
                  Crisis Center
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => navigate("/dashboard/activity")} className="cursor-pointer">
                  Activity Logs
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={handleSignOut} className="cursor-pointer">
                  <LogOut className="size-3.5" /> Sign out
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </header>

        <main className="mx-auto max-w-[1400px] px-4 py-8 sm:px-6" id="tour-kpis">
          <Outlet />
        </main>

        <footer className="border-t border-border/60 px-6 py-4">
          <p className="micro-label">Every decision logged · every number recomputed from live state</p>
        </footer>
      </div>

      <Tour open={tourOpen} onClose={() => setTourOpen(false)} />
      <HowItWorks open={howOpen} onOpenChange={setHowOpen} />
    </div>
  );
}
