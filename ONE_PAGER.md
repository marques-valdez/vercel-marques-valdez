# Fieldstone Relay Studio — Executive Architecture One-Pager

**Scenario & Live Reference App:** **Fieldstone** operates **Relay**, an agentic B2B campaign operations assistant across Google Ads, LinkedIn Ads, Meta Ads, Analytics, and CRM. Built in **Python** (`FastAPI`, `LangGraph`, `Temporal`, `AlloyDB`, `Vertex AI`) on **GCP (`us-east4`)**, Relay faces five scaling bottlenecks as self-serve marketers onboard: **~90% frontier-model token spend** *(illustrative baseline)*, **~10,000 campaign rows per session in pod RAM**, **blank-screen cold-start drop-off**, **shared-branch release contention**, and **browser-bound synchronous turns**.

**Recommendation — Two-Phase Strategy:**
1. **Execute Now — Option A (Augment the Python Stack, 3–4 Weeks):** Add **Vercel AI Gateway**, **Vercel AI SDK UI (`@ai-sdk/react`) + Next.js (`next/og`)**, **Vercel Sandbox**, and **Preview Deployments** *(plus Rolling Releases on Pro/Enterprise)* while keeping **100% of Python `LangGraph`, `Temporal` DAGs, `AlloyDB`, and committed `Vertex AI` spend intact**.
2. **Gate for Phase 2 — Option B (Durable Runtime Rebuild, 10–14 Weeks):** Migrate outer agent orchestration to **`WorkflowAgent` + `Vercel Workflows`** only after three triggers clear: (a) product requires **72-hour autonomous A/B runs & multi-day approvals**, (b) the **Python-to-TypeScript barrier** retires (`vercel-workflow` Python GA or MCP connector boundary), and (c) worker-fleet ops justify consolidation.

---

### Where Vercel Fits & Cloud Boundary

| Layer / Component | Option A (Execute Now) | Option B (Phase 2 Rebuild) | Architectural Job & Business Value |
| :--- | :--- | :--- | :--- |
| **Vercel AI Gateway** | **Active** (`BYOK` to Vertex AI) | **Active** *(unchanged)* | Hybrid two-tier routing (`card` + `/v1/decisions` + fallbacks), `caching: 'auto'`, `0%` BYOK markup on GCP commit. |
| **Next.js + `@ai-sdk/react` + `next/og`** | **Active** (consumes Python SSE) | **Active** *(zero UI rewrite)* | Cold-start live playbooks, typed Glass Box cards over `x-vercel-ai-ui-message-stream: v1`, `/p/[slug]` viral share cards. |
| **Vercel Sandbox** | **Active** (`deny-all`, `persistent=False` microVMs) | **Active** *(unchanged)* | Isolates 10,400-row SQL (~`140K` tokens saved) & 2,000-trial Monte Carlo + diminishing-returns Python outside pod RAM. |
| **Previews & Rolling Releases** | **Active** (`iad1` next to `us-east4`) | **Active** *(full-stack)* | Per-PR preview URLs in <3 min, canary Rolling Releases, and second-level Instant Rollback. |
| **Agent & Workflow Runtime** | **Stays Python on GCP** (`LangGraph` + `Temporal`) | **`WorkflowAgent` + `Vercel Workflows`** | Keeps working Python cron DAGs today (`~$0.00055` vs. `~$0.00066`/10-step run); unlocks tab-close survival, `50 MB` payloads, Skew Protection, and `$0`-compute `createHook()` waits in Phase 2. |
| **Data, Lakehouse & Evals** | **Stays on GCP (`us-east4`)** | **Stays on GCP (`us-east4`)** | `AlloyDB` (`pgvector`/RLS), `~200 TiB` lakehouse, and `DeepEval` stay next to data gravity via OIDC federation. |

---

### What the Live Relay Studio Reference App Demonstrates

- **Real Python `FastAPI` + `LangGraph` Agent (`backend/`) + AI SDK 7 UI (`frontend/`):** Zero TypeScript agent and zero scripted fake-AI mode. Streams `x-vercel-ai-ui-message-stream: v1` SSE frames (with reconciled `id: "turn-progress"` live checklists), hybrid AI Gateway `POST /v1/decisions` tier routing, and honest `gateway` vs. `simulated` failover badges. *(Hosted via Vercel Services so one URL serves both services; in production, the same adapter runs on Fieldstone's GKE cluster.)*
- **Marketing Manager Default UI + Opt-In Architect X-Ray (`?xray=1`):** Distraction-free paid-media workspace featuring 30-day channel ROAS sparklines, live playbook urgency badges, concise progressive Top-5/Top-6 cards, sequential `Next table` follow-ups, floating `ImpactToast`, and a `Changes (N)` Undo audit popover. One click on `X-Ray` reveals live topology, `Primary 503 drill`, `(N/4 ✓)` guided demo tour, `Protocol X-Ray` wire frames, and the FinOps Inspector.
- **Four End-to-End AdOps Flows (`12` Campaigns · `104` Ad Groups · `$6,167/day` · `10,400` Rows):** (1) **Creative `404` & UTM Hygiene Audit** (`14` broken URLs, `9` UTM fixes, 1-click remediation & Undo), (2) **Sandbox / Neon SQL ROAS Workbench** (`4` parameterized templates + signed daily anomaly chart), (3) **Interactive What-If Campaign-Pair Simulator** (`From`/`To` campaign picker, slider, and 30-day P10/P50/P90 Monte Carlo forecast), and (4) **4-Stage Visual Workflow DAG + `/p/[slug]` & `1200x630` `/api/og` Share Cards**.
- **Dual-Mode State & Spend Guardrails:** `$0` browser-local `Decimal` mutation replay (`<=50` items) with optional **Neon Serverless Postgres** (`DATABASE_URL`) workspace & SQL sync, `20 req/min/IP` chat rate limit (`60 req/min/IP` simulator), `<=6` model calls/turn, `max_tokens=2048`, `1` sandbox/request, and `156` Python + `36` frontend + Playwright E2E checks passing.

---

### Key Guardrails & Target Outcomes

- **Operational Guardrails & Next Step:** AI Gateway budgets exclude BYOK spend (keep per-tenant caps in the app ledger); disabling BYOK fallback to Vercel keys costs `$0.20 / 1K` requests; never execute LLM-generated code in `experimental_dynamic` workflows—use a fixed workflow interpreter calling `deny-all` Sandboxes. **Production Next Step:** Extend the implemented **AI Gateway Decisions API (`POST /v1/decisions` / `experimental_decide`)** tier router to pre-flight prompt-injection and off-topic blocking before agent invocation.
- **30–90 Day Option A Targets *(vs. Illustrative Baseline)*:** Frontier spend share `~90%` → **`<=50%`** · Model routing updates `deploy` → **`<2 min`** · Pod session RAM `linear` → **`flat/stateless`** · Time-to-first-insight `blank chat` → **`<15s`** · PR preview `shared staging` → **`<3 min`** *(Phase 2 adds **`100%`** tab-close survival and **`0`** worker fleets).*
