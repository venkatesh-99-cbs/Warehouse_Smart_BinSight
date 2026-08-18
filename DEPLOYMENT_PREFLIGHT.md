# Deployment Preflight — WarehouseOS

Run before **every** deployment or redeployment. The pipeline is
**Inspect → Validate → Detect Conflicts → Fix Safe Issues → Build → Test → Deploy → Health Check**.
Never deploy on a failed critical check. Never print secret values — status only.

## Stack (detected, not assumed)

| Layer | Technology |
| --- | --- |
| Frontend | Vite 7 · React 19 · TypeScript 5.9 · Tailwind 4 · recharts |
| Backend | Convex (cloud) — functions in `src/convex/`, schema in `src/convex/schema.ts` |
| Auth | Convex Auth: email OTP (`CONVEX_SITE_URL`) + Freebuff `customJwt` (`VLY_CONVEX_AUTH_ISSUER`) |
| Runtime | Bun 1.x (Node 22 available) — `bun.lock` is the source of truth |
| Hosting | Freebuff platform (managed hostname/port/deployments — **use the platform's own deploy mechanism**) |

## Required environment variables

| Variable | Used by | Where | Notes |
| --- | --- | --- | --- |
| `VITE_CONVEX_URL` | Frontend (build-time, `import.meta.env`) | `src/main.tsx` | Must be injected by the build environment. If prod shows a blank dashboard, check this first. |
| `CONVEX_SITE_URL` | Auth provider domain | `src/convex/auth.config.ts` | **Must be the deployed site URL in production**, never `localhost:5173` (that is only the documented dev default). If missing, email sign-in breaks. |
| `CONVEX_DEPLOYMENT` | Convex CLI | CLI | Project/deployment selector for `convex dev --once` |
| `VLY_CONVEX_AUTH_ISSUER` | Freebuff JWT issuer | `src/convex/auth.config.ts` | Optional; defaults to `https://freebuff.com` |

## Commands (run from project root)

```bash
bun install --frozen-lockfile     # dependency + lockfile validation (no changes allowed)
bun convex dev --once             # backend compile + codegen + CLI↔Convex connectivity
bun tsc -b --noEmit               # full-project typecheck
bun run build                     # production build (tsc -b && vite build)
```

No dev server is started or stopped here: the platform manages dev/preview processes.
Port/host checks are platform-managed — production listens on the platform-provided port.

## Hostname / stale-resource rules (redeployment)

- If the platform reports **“host name is already in use”**: the hostname belongs to this
  project's existing deployment → **update/redeploy the existing deployment**. Never create a
  duplicate host. Never delete or overwrite another project's resource — stop and report.
- Detect stale deployments before retrying: previous failed deploys leave resources attached
  to the hostname; identify them by deployment ID and clean up only what is clearly this
  project's, then retry once with the fix. Do not repeatedly retry the same failed deploy.
- If a required port is already occupied locally, identify the owning process; stop it only
  if it is a stale instance of this project, otherwise pick the configured port.

## This run — preflight log

| Check | Result | Evidence |
| --- | --- | --- |
| Project structure | ✅ | Vite+React+Convex layout confirmed; no Docker/deploy manifests (platform-managed) |
| Dependencies | ✅ | `bun install --frozen-lockfile` — 459 packages, no changes |
| Lockfile integrity | ✅ | `bun.lock` in sync |
| Environment variables | ⚠️ | Contract confirmed via `.env.example`; values platform-injected, not inspected |
| TypeScript | ✅ | `bun tsc -b --noEmit` — clean |
| Convex backend | ✅ | `bun convex dev --once` — functions compile, CLI authenticated (deployment `acoustic-rook-20.convex.cloud`) |
| Production build | ✅ | `bun run build` — built in 13.56s, all chunks emitted, no warnings |
| Static output | ✅ | `dist/index.html` → `assets/index-BjQf61Yc.js` referenced correctly |
| Dev-URL leak | ✅ | No `localhost` / `127.0.0.1` in `src/` |
| Port config | ✅ | Dev-only `port: 5173` + `host: true`; no hardcoded production port |
| Hostname conflict | ⏸ platform | Freebuff manages hostname/deployments — redeploy existing deployment on conflict |
| Live health check | ⏸ post-deploy | Smoke test after deploy: landing → auth → dashboard → activity logs |

### Warnings (non-blocking, verify on platform)

1. **`CONVEX_SITE_URL` must be the production URL at deploy time** — `.env.example` documents
   `http://localhost:5173` for dev only. Confirm the platform injects the deployed site URL.
2. **`VITE_CONVEX_URL` must be injected at build time** — confirmed working in this
   environment; verify production build injection.
3. **Duplicate lockfile** — `package-lock.json` coexists with `bun.lock` (Bun is the project
   convention). Safe to delete `package-lock.json` to avoid npm/bun drift.
4. **`vite.config.ts` contains a `server.hmr` object** — file is platform-managed; do not modify.
5. **Root leftovers** — `main.ts`, `isolate`, `sst-env.d.ts` are unused template artifacts
   (entry is `src/main.tsx`); cleanup candidates only.

## Result

**All critical checks pass → READY FOR DEPLOYMENT** (with the two env confirmations above
and the non-critical warnings). If any critical check fails: classify the failure
(Configuration / Build / Resource conflict / Runtime / Database / Network / Platform), fix the
root cause, re-run only the failed check, then re-run the pipeline. Never blind-retry, never
destroy the known-good version before the replacement passes health checks.
