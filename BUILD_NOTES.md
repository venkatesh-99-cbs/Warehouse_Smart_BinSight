# WarehouseOS — Build Notes & Verification Matrix

Status: **complete**. Convex codegen (`bun convex dev --once`) passes with zero
errors and the full project typechecks clean (`bun tsc -b --noEmit`).

No requirement was dropped or silently degraded — there is no blocker to report
under §0.6. This file records where every non-negotiable rule lives, how the two
canonical dilemmas stay working across sessions, and the §16 verification
matrix for the demo script.

---

## 1. Architecture map (file → spec section)

| File | Responsibility |
| --- | --- |
| `src/convex/schema.ts` | §6.1 enums, §6.2 tables (products, orders, pickingTasks, alerts, shipments, decisionLog). `schemaValidation: false` per platform convention. |
| `src/convex/domain.ts` | **Single source of truth** for weights/caps/bands (§7.1), trust model (§7.7.1–7.7.3), reserved-stock math (§7.2), availability (§7.8), and pure helpers. Imports nothing server-only; shared by backend and frontend. |
| `src/convex/allocation.ts` | §7.1 scoring, §7.2 allocation engine (pure, exported), §7.2.4 stock scans, §7.4 deadline guard, §7.3/§7.7.3 reallocation plan + `netBenefit` gate, §7.6 FIFO baseline, and the `allocatePendingOrders` / `reallocate` mutations (§11 re-reads). |
| `src/convex/alerts.ts` | §7.5 alert lifecycle (deduped upserts, ack/resolve/dismiss) + reorder/receive-stock inventory actions. |
| `src/convex/analytics.ts` | §7.8 reactive read side: KPIs, funnel, stock health, zone load, shortfalls, trust summary, availability, revenue-vs-FIFO. All queries — the client subscribes, never copies server state. |
| `src/convex/fulfillment.ts` | §7.4 order lifecycle: picking tasks, stock committed at pick time, pack / QC / dispatch / delivery with trust events, missing/damaged issue path. |
| `src/convex/simulator.ts` | §7.6 what-if projection + the decision-support report (exception → decision → reason → resolution → impact → timeline), 4-strategy comparison, capacity/disruption modeling, and Apply. Contains **zero** copies of scoring/allocation/trust math — it calls the exported functions from `allocation.ts` (`runAllocationWave`, `runAllocationWaveWith`, `runFairAllocation`, `findReallocationPlan`, `revenueComparison`, `scoreOrder*`) (§7.6.1). |
| `src/convex/allocation.ts` | Also hosts the strategy allocators (`runAllocationWaveWith` for priority/deadline ordering, `runFairAllocation` for proportional sharing) plus shared `stockScanAlerts` / `deadlineRiskAlerts` helpers reused by every strategy run. |
| `src/convex/seed.ts` | §8 idempotent seed: 20 products, 26 orders, 11 picking tasks, 12 alerts, 7 shipments, decisionLog history incl. the Cascade Outfitters protection entries. |
| `src/pages/Landing.tsx` | Public landing with the live decision demo (URG-2001 / URG-2002 narrative), fulfillment loop, crisis mode, features, CTA → `/auth?returnTo=%2Fdashboard`. |
| `src/pages/Auth.tsx` | Email OTP + anonymous sign-in; `redirectAfterAuth` defaults to `/dashboard`. |
| `src/pages/Dashboard.tsx` | Authenticated shell: sidebar, run-allocation-wave button, live clock, seed-on-first-load, tour wiring. |
| `src/pages/dashboard/Overview.tsx` | §7.8 KPIs, pipeline funnel, stock health, zone load, top shortfalls, trust index, latest exceptions. |
| `src/pages/dashboard/Inventory.tsx` | Stock ledger with derived reserved/available, reorder + receive-stock actions. |
| `src/pages/dashboard/Orders.tsx` | Order table, filters, detail sheet with per-line live availability, full stage-advance workflow. |
| `src/pages/dashboard/Operations.tsx` | Zone-grouped picking board: claim / complete / issue workflow. |
| `src/pages/dashboard/Crisis.tsx` | §10.1 Exception → Decision → Resolution, Why? disclosures, reallocate dialog with trust cost (§7.7.4), withheld-gate callout, deep-link focus (§10.4). |
| `src/pages/dashboard/Simulator.tsx` | §7.6 builder + projection; runs `simulateScenario` client-side (same engine as production). |
| `src/lib/format.ts` | §10.1 `explainDecision` — formats only values the backend functions already produced; never re-derives scoring/trust math. |
| `src/components/warehouse/Tour.tsx` | §10.2 five-step spotlight tour (once per browser, replayable). |
| `src/components/warehouse/HowItWorks.tsx` | §10.4 one-screen reference with deep links into live examples. |
| `src/components/warehouse/badges.tsx` | Shared status/priority/severity/health/trust label + color source. |

---

## 2. Fidelity decisions (§0.1 — exact values, verbatim)

Every constant below is defined **once** in `src/convex/domain.ts` (or the
scoring function in `allocation.ts`) and imported everywhere it is used — no
duplicated logic anywhere (§0.4).

- §7.1 priority weights: urgent 100, high 60, medium 25, low 0.
- §7.1 deadline bands: ≤6h → +50, ≤24h → +35, ≤72h → +15.
- §7.1 age bonus: `min(20, ageHours × 0.4)`.
- §7.1 profit bonus: `min(15, revenue / 100)` — deliberately capped **below**
  a single priority tier and below the ≤6h deadline bonus so profit can never
  leapfrog an urgent/high order (rationale comment at the code site).
- §7.7.1 trust event weights: donor_raided −8, deadline_missed −15,
  partial_fulfilled −5, fulfilled_on_time +3, fulfilled_early +5.
- §7.7.2 trust floor **40**; strike window **24h**; aggregation window 30 days.
- §7.7.3 trust-cost multipliers by donor priority: urgent 1.5, high 1.2,
  medium 1.0, low 0.8.
- Reallocation ranking: cost asc → priority weight asc → deadline desc; a
  donor with `netBenefit ≤ 0` stops the draw for all lower-ranked donors.
- Reallocation proceeds only when `targetGain − donorTrustCost > 0` **and** the
  donor passes the trust gate (score ≥ 40, zero raids in 24h).
- Stock is committed at pick time (`item.picked`); `reserved` is always derived
  as Σ(allocated − picked) over holding statuses — never stored (§6.2 defines
  no `reserved` field).

---

## 3. The two canonical dilemmas (§2 / §8) — how they stay working

Seeded with `isDemoScenario: true` so the UI tags them, and rebuilt fresh on
every seed run because all timestamps are relative to `Date.now()`.

- **URG-2001 (Vertex Retail, urgent)** — short 10 × WRT-8800 with 2 free units
  on hand. Donors ORD-3010 (5) and ORD-3040 (3) hold reserved stock, both at
  trust 100 with no recent strikes, and both draws are profit-positive. This is
  the **reallocation-granted** path: the Crisis card offers `Reallocate`, the
  dialog shows gain vs cost before confirming.
- **URG-2002 (Metroline Wholesale, urgent)** — short 8 × BAT-LI12. The only
  holder is ORD-5010 (Cascade Outfitters), whose seeded history puts them at
  trust 39 with 3 donor raids inside the 24h window — below the 40 floor. The
  plan is **withheld**: no Reallocate button, a red trust-gate callout explains
  why, and the suggestion is an emergency PO. This is the pass/fail condition.
- `ensureSeeded` refreshes Cascade Outfitters' protection entries when they age
  out of the 24h strike window, so the withheld behavior survives across
  sessions (also reported via the "Demo state refreshed" toast).

---

## 4. §16 Verification matrix

The demo script below exercises every non-negotiable behavior. Each row names
the check, the place to look, and the pass condition.

| # | Test | Where | Pass condition |
| --- | --- | --- | --- |
| 1 | **URG-2001 reallocation is offered and applied** | Crisis Mode → URG-2001 card → Reallocate | Dialog lists ORD-3010 and ORD-3040 with positive net benefit; confirming moves 8 × WRT-8800, donor orders drop to `review` with backorder alerts, URG-2001 becomes `allocated`. |
| 2 | **URG-2002 reallocation is withheld** | Crisis Mode → URG-2002 card | No Reallocate button; red trust-gate callout cites Cascade Outfitters' score and strike count; suggestion is the emergency PO. Clicking anything never triggers a no-op handler. |
| 3 | **Scoring orders the wave** | Overview → Run allocation wave | With ORD-4025 (high, 9h) and ORD-4021 (medium, 30h) competing for SWT-2424, the high-priority order is fully allocated first; the FIFO baseline in the same run captures the other order. |
| 4 | **Profit-positive, trust-safe gate holds** | Crisis Mode → any reallocate dialog | Every listed donor shows gain vs cost; ineligible donors are listed with their reason (test 4's UI-explainability requirement) and are never drawn from. |
| 5 | **Trust score is decisionLog-derived** | Orders → any order → Customer trust; Overview → Customer Trust Index | Scores change only through logged trust events (delivery early/on-time/missed, donor raids). Below-floor customers appear as "Trust-protected". |
| 6 | **Revenue captured vs FIFO is live-computed** | Overview KPI + Simulator | `revenueComparison` runs both engines on current state; delta reflects the score-ordered wave's advantage. Never hardcoded. |
| 7 | **Simulator is the same engine** | Simulator page | Projection uses `runAllocationWave`/`findReallocationPlan`/`revenueComparison` from `allocation.ts`; previews match what Apply produces (Apply re-validates against live DB state first, §11). |
| 15 | **Scenario → Exception → Decision → Resolution → Impact** | Simulator → any preset → Run | The report shows the exception banner, a decision derived from the exact simulated numbers, a reason, resolution actions, before/after metrics, impact (positive/risks/actions), and the timeline with the failing stage highlighted. |
| 16 | **Real calculations, no hardcoding** | Simulator | Allocated ≤ qty, usable = on hand − damaged − missing − pre-wave reservations, remaining = usable − newly allocated; every metric comes from `countMetrics` over the simulated world. Changing an input and re-running recomputes everything. |
| 17 | **Validation blocks invalid inputs** | Simulator config panel | Negative quantities, damaged/missing > on-hand stock, unknown SKUs/orders, past deadlines, and negative capacity all show inline field errors and disable Run/Apply. |
| 18 | **Strategy comparison** | Simulator → Compare strategies | Four strategies (current policy, priority first, deadline first, fair allocation) run the same engine with different ordering; the table shows all §4 metrics and a weighted-score recommendation with the numbers behind it. |
| 19 | **Presets surface real dilemmas** | Simulator preset chips | Each of the 8 presets sets concrete, valid inputs; running one reproduces its dilemma (e.g., Urgent order → trust-protected donor → reallocation withheld; Picking bottleneck → critical capacity headline). |
| 20 | **Apply persists accepted changes** | Simulator → Apply to warehouse | Write-offs (damaged/missing), deadline delays, restocks, priority overrides and new orders are committed with decisionLog entries, then the live allocation wave re-runs (§11 re-reads). Capacity/disruption are what-if knobs and are not persisted (no schema change). |
| 8 | **Reserved stock is always derived** | Inventory + Orders line availability | Reserved = Σ(allocated − picked) across holding statuses, recomputed per query; completing a pick reduces reserved on the next read. |
| 9 | **Full fulfillment loop commits state** | Orders → an allocated order | Start picking → complete every task (stock decremented at pick time) → pack → QC (clears deadline_risk alert) → dispatch (creates in-transit shipment) → mark delivered (logs fulfilled_early/on_time/missed trust event). |
| 10 | **Every decision is logged** | Crisis Mode → decision ledger / Overview → Latest exceptions | Allocation waves, reallocation raids, POs, restocks, resolves, and fulfillment transitions all write `decisionLog` entries; reallocation/exception entries carry `customer` + `refId`. |
| 11 | **Why? shows real numbers** | Crisis Mode → any card → Why? | Scoring breakdown, donor gain/cost, trust before → after — all formatted from backend-computed values, never re-derived in the formatter. |
| 12 | **Onboarding works end-to-end** | Fresh browser → dashboard | 5-step tour auto-shows once; How-this-works deep links land on the live examples (`/dashboard/crisis?focus=URG-2002`, Simulator). |
| 13 | **Concurrency safety** | Reallocate under conflicting edits | Every mutation re-fetches the alert/target/donors from the DB and re-derives quantities at execution time; stale or already-resolved alerts no-op with a reason. |
| 14 | **Idempotent seed** | Reload dashboard | `ensureSeeded` skips when products exist; URG-2002 protection entries are re-freshed only when aged out (>12h) so the demo stays valid. |

---

## 5. Commands

```bash
bun convex dev --once        # codegen (regenerates src/convex/_generated)
bun tsc -b --noEmit          # full-project typecheck
```

`vite.config.ts` is untouched (`server.hmr: false` preserved). No `.env` edits.
