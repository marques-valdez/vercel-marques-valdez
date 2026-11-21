# Fieldstone Relay Studio — Executive Architecture One-Pager

**Live Demo:** https://vercel-marques-valdez.vercel.app *(Architect X-Ray: https://vercel-marques-valdez.vercel.app/?xray=1)* · **Public Repo:** https://github.com/marques-valdez/vercel-marques-valdez · **Full 8-Section Brief:** [`SUBMISSION.md`](./SUBMISSION.md)

**1. Problem Statement (`GKE + LangGraph + Vertex AI` → Production Agent Layer):** **Fieldstone** operates **Relay**, an agentic B2B paid-media assistant across Google Ads, LinkedIn Ads, Meta Ads, Analytics, and CRM. Built in **Python** (`FastAPI`, `LangGraph`, `Temporal`, `AlloyDB`, `Vertex AI`) on **GCP (`us-east4`)**, self-serve PLG onboarding exposes five scaling bottlenecks: **~90% unattributed frontier-model spend** *(illustrative baseline)* with no zero-deploy failover, **10,400 campaign rows per session in pod RAM**, **blank-screen cold-start drop-off**, **shared-branch staging contention**, and **tab-bound synchronous turns**.

**2. Two-Phase Target Architecture:**
- **Execute Now — Option A (Augment the Python Stack, 3–4 Weeks):** Add **Vercel AI Gateway**, **AI SDK 7 UI (`@ai-sdk/react`) + Next.js (`next/og`) on Fluid Compute**, **Vercel Sandbox**, and **Preview Deployments & Rolling Releases** (`iad1`, `~2–5 ms` from `us-east4`) while keeping **100% of Python `LangGraph`, `Temporal` cron DAGs, `AlloyDB`, `~200 TiB` lakehouse, `DeepEval`, and committed `Vertex AI` spend intact on GCP**.
- **Gate for Phase 2 — Option B (Durable Runtime Rebuild, 10–14 Weeks):** Migrate outer orchestration to **`WorkflowAgent` + `Vercel Workflows`** behind the unchanged Option A UI only once: (G1) **72h autonomous A/B runs & multi-day `$0`-compute approvals** ship, (G2) `vercel-workflow` Python reaches GA or MCP wraps Python connectors, and (G3) worker-fleet scale justifies consolidation.

---

### 3. Vercel Primitives, Cloud Boundary & Trade-Offs

| Layer / Component | Option A (Now) | Option B (Phase 2) | Rationale & Explicit Trade-Offs |
| :--- | :--- | :--- | :--- |
| **Vercel AI Gateway** | **Active** (`BYOK` to Vertex) | **Active** *(unchanged)* | Hybrid `card` + `/v1/decisions` routing, failover, `caching: 'auto'`, per-run cost tags, `0%` BYOK markup. *Trade-off:* Gateway budgets exclude BYOK (keep app-ledger caps); no-fallback toggle adds `$0.20/1K` calls. |
| **Next.js + `@ai-sdk/react` (Fluid Compute)** | **Active** (Python SSE v1) | **Active** *(zero UI rewrite)* | Live urgency playbooks, progressive Top-5/Top-6 cards, Undo log, `/p/[slug]` + `/api/og`; Fluid Compute bills Active CPU over idle SSE wait. *Trade-off:* Tab-bound until Phase 2 `WorkflowChatTransport`. |
| **Vercel Sandbox (+ Neon SQL)** | **Active** (`deny-all` VM + Neon DB) | **Active** *(unchanged)* | **Neon Postgres** serves 10,400-row SQL (`~140K` tokens avoided; `sqlite3` fallback); **Sandbox** isolates 2,000-trial Monte Carlo Python off pods (`$0.128/hr` Active CPU). *Trade-off:* `~300–900 ms` VM boot; `deny-all` blocks runtime `pip install`. |
| **Services, Previews & Releases** | **Active** (`iad1` / `us-east4`) | **Active** *(full-stack)* | `<3 min` PR Preview URLs, Pro/Enterprise Rolling Releases, `<5s` Instant Rollback, 1-domain Services demo. *Trade-off:* Services is Beta; Rolling Releases require Pro/Enterprise. |
| **Agent & DAG Runtime** | **Stays Python on GCP** | **`WorkflowAgent` + Workflows** | Preserves Python crons today (`~$0.00055` vs. `~$0.00066`/10-step run); unlocks tab-close survival, `50 MB` payloads & `$0` `createHook()` waits in Phase 2 (`vercel-workflow` Python currently Beta). |
| **Data, Lakehouse & Evals** | **Stays on GCP (`us-east4`)** | **Stays on GCP (`us-east4`)** | `AlloyDB` (`pgvector`/RLS), `~200 TiB` Iceberg lakehouse, `DeepEval`, and `Vertex AI` commit stay next to data gravity via OIDC federation. |

---

### 4. Working Demo Proof & 5. Production Rollout Plan

- **4-Step Live Demo Walkthrough (`12` Campaigns · `104` Ad Groups · `$6,167/day` · `10,400` Rows):** (1) **Invoke stateful tools:** fix `14` broken `404` URLs + `9` UTM tags (with 1-click **Undo** in `Changes (N)`) or drag the `From`/`To` campaign-pair slider for 2,000-trial Sandbox Monte Carlo P10/P50/P90 forecasts; (2) **Verify AI Gateway routing:** open `?xray=1` for `/v1/decisions` tier confidence & Neon/Sandbox badges; (3) **Trigger failover:** toggle `Primary 503 drill` for 2-hop recovery without code changes; (4) **Inspect cost & trace:** open `Protocol X-Ray` & **FinOps Inspector** for per-turn cost, `~140K` tokens saved, and hop latency.
- **5-Stage Rollout (`Preview → Validation → Canary → Cutover → Rollback`):** **1. Preview (Wk 1):** `<3m` PR URLs in `iad1` + GCP OIDC + Vertex BYOK Virtual Models → **2. Validation (Wk 1–2):** `156` `pytest` + `DeepEval`, `36` UI tests, Playwright E2E, `70/30` shadow routing & BYOK Provisioned Throughput check → **3. Canary (Wk 3):** Rolling Releases (`5% → 25% → 50%` PLG traffic, `<0.5%` 5xx & flat pod RSS gates) → **4. Cutover (Wk 4):** `100%` UI traffic while Python `LangGraph`/`Temporal`/`AlloyDB` stay untouched → **5. Rollback (`<5s`):** Vercel Instant Rollback (`0` rebuild) + Python `OPENAI_BASE_URL` / `SANDBOX_DISABLED=1` switches.

---

### 6. Success Measures, 7. Pre-Kickoff Risks & 8. Dev Tooling / AI Validation

- **30–90 Day Outcomes *(vs. Illustrative Baseline)*:** **Business:** Frontier spend `~90%` → **`<=50%`** · **`100%`** Vertex BYOK commit + per-run FinOps attribution · Cold-start insight `blank chat` → **`<15s`** + `/p/[slug]` shares. **Technical:** Routing update `deploy` → **`<2 min`** · Pod RAM `linear` → **`flat/stateless`** · PR preview **`<3m`** / rollback **`<5s`** *(Phase 2: **`100%`** tab survival, **`0`** worker fleets).*
- **Known Pre-Kickoff Limitations & Risks:** (1) Tab-close survival waits for Phase 2 (`vercel-workflow` Python Beta); (2) AI Gateway budgets exclude BYOK spend (enforce caps in app ledger; Vertex service-account key org-policy exception + Week 1 PT check required); (3) `deny-all` Sandboxes disallow runtime `pip`; keep `iad1 ↔ us-east4` calls coarse-grained; never run LLM code in `experimental_dynamic` workflows.
- **Dev Tooling & AI Behavior Validation:** Built via **agentic CLI/IDE orchestration** (planner + parallel Python `uv`/`FastAPI`/`LangGraph` & Next.js builders + headless Chromium verifiers). Validated across **5 layers:** (1) deterministic Digital Twin (`seed = 20261117`, fixed-point `Decimal` ground truth), (2) **`156` Python `pytest` checks** (`/v1/decisions` fallbacks, `unwrap_llm_str` malformed tool-arg recovery, SSE v1 ordering, Monte Carlo math), (3) **`36` frontend tests** (`toolCallId` approval gates, `zod`-strict slugs), (4) **Playwright live `503` failover & E2E suites** (`0` HTTP `>=400`), and (5) manual transcript review enforcing concise `2–4` bullet replies + `Next table` follow-up chips.
