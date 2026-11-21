# Fieldstone Relay Studio — Customer-Ready Architecture & Working Demo Submission

> **Scenario Summary (`GKE + LangGraph + Vertex AI` → Production Agent & PLG Layer on Vercel)**
> - **Current state and problem:** **Fieldstone** operates **Relay**, an agentic B2B campaign operations assistant built in Python (`FastAPI`, `LangGraph`, `Temporal`, `AlloyDB`, `Vertex AI`) on GCP (`us-east4`). As self-serve marketers onboard, manual model pickers leave **~90% of token spend** *(illustrative baseline)* on frontier models, Finance lacks per-conversation cost attribution, direct model calls lack zero-deploy failover, **10,400 campaign rows per session** bloat Kubernetes pod RAM, blank-screen chat stalls activation, shared staging slows PRs, and closed browser tabs drop active runs.
> - **Vercel role — augment the model, UX, and ephemeral compute layers now (Option A); gate durable orchestration for Phase 2 (Option B):**
>   - Route model calls through **Vercel AI Gateway** for one API, hybrid two-tier model routing (`POST /v1/decisions`), per-run spend attribution, `caching: 'auto'`, and automatic model failover over **Vertex AI BYOK** (`0%` token markup).
>   - Serve the workspace on **Next.js App Router + AI SDK 7 UI (`@ai-sdk/react`)** running on **Fluid Compute** (charging for Active CPU rather than idle SSE wall-clock waits), turning blank chat into live urgency playbooks, progressive Glass Box cards, and `/p/[slug]` + `next/og` share links.
>   - Isolate `10,400`-row SQL slices and `2,000`-trial Monte Carlo Python simulations inside **Vercel Sandbox** (`NetworkPolicy.deny_all()`) microVMs, and ship every PR on **Preview Deployments & Rolling Releases**.
> - **What stays outside Vercel (`GCP us-east4`):** `Vertex AI` inference (behind AI Gateway BYOK to retire Fieldstone's committed GCP spend), `AlloyDB` (`pgvector` + Row-Level Security), `~200 TiB` `GCS Iceberg` lakehouse, `BigQuery` / `DeepEval` test harnesses, and—in Phase 1—100% of Python `LangGraph` (`GKE`) and `Temporal` scheduled Python DAGs.
> - **Working demo:** **Live App:** https://vercel-marques-valdez.vercel.app *(Architect X-Ray: https://vercel-marques-valdez.vercel.app/?xray=1)* · **Public Repo:** https://github.com/marques-valdez/vercel-marques-valdez

---

## 1. Problem Statement: Customer, Current Stack, Pain & Why It Matters

- **Customer:** **Fieldstone**, an established B2B marketing software company launching self-serve Product-Led Growth (`PLG`) onboarding for **Relay**, its agentic paid-media assistant spanning Google Ads, LinkedIn Ads, Meta Ads, Analytics, and CRM.
- **Current As-Built Stack (`GCP us-east4`):** Single-page React chat UI + DAG viewer behind Envoy/Istio; single-tenant **Python 3.12 `FastAPI` + `LangGraph`** pods on self-managed `GKE` loading `~10,000` ad-platform rows into in-process `DuckDB` per session; **Temporal** running 5–10 node scheduled Python DAGs; direct SDK calls to **Vertex AI & Model Garden** (`Claude Sonnet` & `Gemini` families) with a raw model selector in the UI; **AlloyDB** (`PostgreSQL + pgvector`), **Memorystore**, a 28-day message purge cap, a `~200 TiB` `GCS Iceberg` lakehouse, and offline **`DeepEval`** Digital Twin regression tests.
- **Five Scaling Bottlenecks & Business Impact:**
  1. **Unattributed frontier-model spend & brittle failover:** End users default to frontier reasoning models (`~90%` of AI spend, illustrative baseline) even for routine lookups; Finance cannot attribute cost per conversation or tenant, and provider hiccups surface `~4%` error bursts with no zero-deploy fallback—eroding self-serve gross margin.
  2. **Session datasets inside pod RAM:** Holding `10,400` daily campaign rows in-process couples `GKE` pod memory and OOMKill risk linearly to concurrent sessions.
  3. **Blank-screen cold start & wall-of-text cognitive overload:** New self-serve signups face an empty prompt with no guided workflows, no interactive budget controls, and no peer-shareable artifacts—stalling activation and viral expansion.
  4. **Shared-branch release contention:** Frontend and routing changes contend on shared staging environments, slowing a lean team.
  5. **Tab-bound synchronous turns:** Closing a tab kills active SSE turns, blocking planned 72-hour autonomous A/B experiments and multi-day Slack/email budget approvals.

---

## 2. Current-State & Target-State Architecture (Including What Stays Outside Vercel & Why)

### Two-Phase Strategy: Augment Python Now (`Option A`), Gate Runtime Rebuild (`Option B`)
- **Phase 1 — Option A: Augment the Existing Python Stack (`3–4 Weeks`, Execute Now):** Place Vercel (`iad1`, Northern Virginia—`~2–5 ms` from GCP `us-east4`) in front of Fieldstone's Python `FastAPI` + `LangGraph` service. Next.js 15 (`@ai-sdk/react`) consumes Python's standard `x-vercel-ai-ui-message-stream: v1` SSE stream (`ui_stream.py`), Python swaps its OpenAI-compatible `base_url` to **Vercel AI Gateway**, and Python offloads session SQL and Monte Carlo math to **Vercel Sandbox** via `vercel-sandbox`. Solves Pains 1–4 with **zero rewrite of Python business logic**.
- **Phase 2 — Option B: Rebuild Outer Runtime on `WorkflowAgent` + `Vercel Workflows` (`10–14 Weeks`, Gated):** Defer porting orchestration until three hard triggers clear: **(G1)** product ships 72-hour autonomous A/B tests and multi-day `$0`-compute approvals, **(G2)** the Python-to-TypeScript barrier retires (`vercel-workflow` Python SDK exits Beta into GA, or Python connectors are wrapped behind typed MCP boundaries), and **(G3)** `GKE` + `Temporal` worker-fleet ops justify consolidation—preserving the **exact Option A Next.js UI unchanged**.

```text
 CURRENT AS-BUILT (GCP us-east4)                      TARGET PHASE 1 — OPTION A (Vercel iad1 + GCP us-east4)
 ┌──────────────────────────────┐                     ┌──────────────────────────────────────────────────────────┐
 │ SPA Chat UI (Envoy / Istio)  │                     │ Vercel (iad1): Next.js 15 + @ai-sdk/react (Fluid Compute)│
 └──────────────┬───────────────┘                     │  • Live Playbooks, Concise Cards, Undo Log, /p/[slug]+OG │
                ▼                                     │  • Preview Deployments (<3m), Rolling Releases, Rollback │
 ┌──────────────────────────────┐                     └────────────┬─────────────────────────────┬───────────────┘
 │ GKE: Python FastAPI+LangGraph│                                  │ SSE v1 (OIDC)               │
 │  • In-pod 10.4K-row DuckDB   │  ── Augment Now ──▶ ┌────────────▼───────────────┐   ┌─────────▼───────────────┐
 │  • Direct Vertex SDK calls   │  (0 Python Rewrite) │ GCP us-east4 (STAYS INTACT)│   │ Vercel AI Gateway +     │
 │  • Temporal Python Cron DAGs │                     │ • Python FastAPI+LangGraph │──▶│ Vercel Sandbox (iad1)   │
 │  • AlloyDB + 200TiB Lakehouse│                     │ • Temporal Python Cron DAGs│   │ • /v1/decisions + BYOK  │
 └──────────────────────────────┘                     │ • AlloyDB, Lakehouse, Evals│◀──│ • Deny-all SQL & 2,000- │
                                                      │ • Vertex AI (BYOK Commit)  │   │   trial Monte Carlo VM  │
                                                      └────────────────────────────┘   └─────────────────────────┘
```

### Explicit Cloud Boundary: What Stays Outside Vercel (`GCP us-east4`) & Why
1. **Vertex AI & Model Garden Inference:** Remains the backing provider behind AI Gateway **BYOK** (`0%` Vercel token markup) so model spend continues retiring Fieldstone's committed GCP contract.
2. **AlloyDB (`pgvector` + RLS), Memorystore, 28-Day Purge Pipeline & `~200 TiB` Lakehouse:** Stay co-located with petabyte-scale account/intent data gravity and Row-Level Security in `us-east4`, avoiding cross-cloud egress fees and chatty cross-WAN database loops.
3. **BigQuery Trace Sink & `DeepEval` Digital Twin Suite:** Proven offline write-safety assets kept intact.
4. **Python `LangGraph` (`GKE`) & `Temporal` Python Cron DAGs (in Option A):** Kept 100% intact today because rewriting stabilized Python skills into TypeScript mid-launch risks velocity, and 10-step cron orchestration fees on Temporal (`~$0.00055`/run) vs. Vercel Workflows (`~$0.00066`/run) provide no reason to migrate working Python crons prematurely.

---

## 3. Vercel Choices: Primitives, Rationale & Trade-Offs

| Vercel Primitive | Role & Rationale in Fieldstone's Architecture | Explicit Trade-Offs & Plan Nuances |
| :--- | :--- | :--- |
| **1. Vercel AI Gateway** | Single endpoint (`~25`-line Python `base_url` swap) delivering `<1ms` card routing + `POST /v1/decisions` semantic tier classification, ordered model failover, `caching: 'auto'`, per-run FinOps cost attribution, and `0%`-markup Vertex AI BYOK. | AI Gateway spend budgets exclude BYOK spend (keep hard tenant caps in Relay's app ledger); disabling fallback to Vercel keys costs `$0.20 / 1K` BYOK calls; Custom Reporting tags cost `$0.075 / 1K` writes. |
| **2. AI SDK 7 UI (`@ai-sdk/react`) + Next.js (`next/og`) on Fluid Compute** | Renders typed `UIMessage` tool cards, live step checklists, Undo audit logs, and `/p/[slug]` + `/api/og` share cards over Python SSE (`ui_stream.py`). **Fluid Compute** shares instance concurrency across I/O waits, billing Active CPU instead of idle LLM wall-clock duration. | Option A SSE turns stay tab-bound until Phase 2 `WorkflowChatTransport`; requires maintaining the `~150`-line Python UI Message Stream v1 adapter (`ui_stream.py`). |
| **3. Vercel Sandbox** (`vercel-sandbox` Python SDK) | Ephemeral `NetworkPolicy.deny_all()` Firecracker microVMs (`persistent=False`, `$0.128/hr` Active CPU, `30s` cap) isolate `10,400`-row SQL queries (`~140K` prompt tokens avoided) and `2,000`-trial Monte Carlo simulations off `FastAPI` pods. | Ephemeral microVM execution adds `~300–900 ms` vs. in-process memory; `deny-all` blocks runtime `pip install` (use stdlib `sqlite3`/Python or pre-built snapshots); capped at `1` sandbox/request with badged fallback. |
| **4. Services, Preview Deployments & Rolling Releases** | Immutable per-PR Preview URLs in `<3 min` (`iad1`), Pro/Enterprise canary **Rolling Releases**, `<5s` **Instant Rollback**, and **Vercel Services** (`vercel.json`) routing Next.js (`frontend/`) + Python `FastAPI` (`backend/`) on one domain for portable previews. | Vercel Services is in Beta (in production Option A, Python stays on `GKE` while Services powers self-contained previews/demos); Rolling Releases require Pro/Enterprise (Hobby includes 1 WAF rule). |
| **5. Vercel Workflows + `WorkflowAgent`** *(Gated Phase 2)* | Serverless durable execution (`50 MB` payloads vs. Temporal's `2 MB`, deployment-pinned Skew Protection, `$0`-compute `createHook()` waits, and reconnectable `WorkflowChatTransport` streams) with zero worker fleets. | `vercel-workflow` Python SDK is in Beta while TypeScript is GA; gated behind Phase 2 readiness triggers rather than forced today. |

---

## 4. Working Demo: Public URL, Public Repository & Evaluator Walkthrough

- **Public Live Demo URL:** https://vercel-marques-valdez.vercel.app
  - **Direct Architect X-Ray View:** https://vercel-marques-valdez.vercel.app/?xray=1
  - **Live Python 3.12 + Sandbox + Neon Health Probe:** https://vercel-marques-valdez.vercel.app/api/agent/health
- **Public GitHub Repository:** https://github.com/marques-valdez/vercel-marques-valdez

### 4-Step Evaluator Walkthrough (End-to-End Proof)
1. **Start an agent session & invoke stateful tools (`12` campaigns · `104` ad groups · `10,400` rows):** Click **Creative & UTM Hygiene Audit** (`14` broken `404` URLs + `9` UTM violations; apply 1-click fix and test **Undo** in the header `Changes (N)` audit log) or **What-If Budget Simulator** (pick any `From` / `To` campaign pair, drag the shift slider to trigger `POST /api/agent/reallocation/simulate` 2,000-trial Sandbox Monte Carlo P10/P50/P90 forecasts, and test the human approval gate).
2. **Inspect AI Gateway model routing:** Toggle **`X-Ray`** in the header (`/?xray=1`) to watch live pre-send route previews (`fast` vs. `reasoning`), `<1ms` card fast-path vs. AI Gateway `POST /v1/decisions` classifier confidence, and Neon Postgres / Sandbox execution badges.
3. **Demonstrate model failover without redesigning the application:** Toggle **`Primary 503 drill`** in the `X-Ray` bar and submit any prompt to observe automatic 2-hop primary-to-fallback model recovery, explicitly distinguishing live `gateway` failover from `simulated` drill failover.
4. **Inspect the run trace, conversation cost & latency breakdown:** Open `TelemetryStrip`, `Protocol X-Ray` (raw `x-vercel-ai-ui-message-stream: v1` frames mapped to `backend/app/ui_stream.py`), and the **FinOps Inspector** drawer to review prompt/completion tokens, active cost vs. frontier counterfactual savings, `~140K` Sandbox tokens avoided, and per-hop latency.

---

## 5. Rollout Plan: Preview, Validation, Canary, Cutover & Rollback

1. **Preview (`Week 1`):** Connect the repository to Vercel (`iad1`), configure **OIDC Workload Identity Federation** (`vercel.com/docs/oidc/gcp`) to staging `FastAPI` on `GKE` (`us-east4`), and define AI Gateway Virtual Models (`vmc/relay-fast`, `vmc/relay-reasoning`) backed by Vertex AI BYOK. Every pull request mints an isolated Preview URL in `<3 min`.
2. **Validation (`Weeks 1–2`):** Gate promotion on automated CI + shadow-traffic checks: `156` Python `pytest` + `DeepEval` Digital Twin write-accuracy checks, `36` frontend contract/whitebox tests, Playwright E2E flows, `70/30` fast-to-reasoning routing accuracy on replayed transcripts, and Week 1 verification of Vertex AI Provisioned Throughput over BYOK.
3. **Canary (`Week 3`):** Enable Pro/Enterprise **Rolling Releases** (`5% → 25% → 50%` of self-serve PLG traffic over 48 hours). Gate advancement on AI Gateway 5xx rate (`<0.5%`), SSE stream completion (`>99%`), `p95` TTFT, and flat `GKE` pod RSS during `10,400`-row Sandbox SQL queries.
4. **Cutover (`Week 4`):** Promote Rolling Release to `100%` of production UI traffic while keeping `100%` of Python `LangGraph`, `Temporal` cron DAGs, and `AlloyDB` untouched on `GCP us-east4`. Subsequent model/fallback updates ship in `<2 min` via AI Gateway Virtual Models with zero backend deploys. *(Phase 2 later uses a 4-wave Strangler-Fig cutover behind feature flags.)*
5. **Rollback (`< 5 Seconds`):** Two independent, zero-data-loss switches: (a) **Vercel Instant Rollback** reverts the frontend/Services alias to the prior immutable build in `<5s` with zero rebuild, and (b) flipping `OPENAI_BASE_URL` / `SANDBOX_DISABLED=1` on `GKE` restores direct Vertex AI calls and in-process execution immediately.

---

## 6. Success Measures: Technical & Business Outcomes

| Category | Metric | Illustrative Baseline Today | Option A Target (30–90d) | Phase 2 Target (Post-Gate) | Measurement Source |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Business** | **Frontier-model share of AI spend** | `~90%` on frontier tier | **`<= 50%`** (`70/30` call mix) | **`<= 40%`** | AI Gateway spend by model/tier |
| **Business** | **GCP commit & FinOps attribution** | Unattributed logs; 3P leakage | **`100%` BYOK commit** + per-run cost | **`100%` BYOK commit** | App credit ledger + Gateway tags |
| **Business** | **Cold-start time-to-first-insight** | Blank chat (high PLG drop-off) | **`< 15 seconds`** + `/p/[slug]` shares | **`< 15 seconds`** | Activation & peer-remix funnel |
| **Technical** | **Model / fallback routing change** | Code edit + backend redeploy | **`< 2 minutes`** (`0` deploys) | **`< 2 minutes`** | AI Gateway Virtual Model log |
| **Technical** | **Pod RAM under `10.4K`-row queries** | Scales linearly per session | **Flat / stateless** (in Sandbox) | **Scale-to-zero** | `GKE` RSS & Sandbox telemetry |
| **Technical** | **PR preview & rollback speed** | Shared staging contention | **`< 3m` preview · `< 5s` rollback** | **`< 3m` · `< 5s`** | Vercel Deployments audit log |
| **Technical** | **Tab-close survival / worker fleets** | `0%` survival / `2` fleets | *Deferred by design (`0` rewrite)* | **`100%` / `0` fleets** | Disconnect & infra inventory |

---

## 7. Known Limitations & Risks (What We Tell the Customer Before Kickoff)

1. **Multi-day tab-close durability waits for Phase 2 (`Option B`):** Option A intentionally keeps synchronous HTTP SSE so Fieldstone ships in 3–4 weeks without a risky mid-launch Python-to-TypeScript port (`vercel-workflow` Python SDK is still in Beta). 72-hour autonomous A/B runs require Phase 2 (`WorkflowAgent` + `Workflows`).
2. **AI Gateway BYOK billing, budget & GCP org-policy caveats:** AI Gateway budgets meter Vercel-billed credits only and **do not cap BYOK spend**—Fieldstone must keep hard per-tenant daily caps in its application ledger (fed by SSE usage or `$0.075 / 1K` Custom Reporting tags). Disabling *Fallback to Vercel Keys* adds `$0.20 / 1K` BYOK requests, Vertex BYOK requires a scoped GCP service-account key org-policy exception, and pre-purchased Vertex Provisioned Throughput parity over BYOK must be validated during Week 1 PoC.
3. **Sandbox microVM boundaries:** `NetworkPolicy.deny_all()` blocks runtime `pip install` and outbound ad-API calls inside the microVM (pass pre-fetched session rows in and run stdlib `sqlite3`/Python or pre-baked snapshots), and cold microVM startup adds `~300–900 ms`.
4. **Cross-cloud & dynamic-code guardrails:** Keep Vercel (`iad1`) ↔ GCP (`us-east4`) calls coarse-grained (`~2–5 ms` RTT; chatty `AlloyDB` queries remain inside GCP), budget for Pro/Enterprise to unlock Rolling Releases, and **never** execute LLM-generated customer DAG code inside `experimental_dynamic` workflows—always run a fixed interpreter dispatching untrusted Python to `deny-all` Sandboxes.

---

## 8. Development Tooling & How We Validated AI Behavior

- **IDE & Agentic Development Workflow:** Built in a Linux cloud environment using **agentic CLI/IDE orchestration** with specialized subagents (architecture planner, parallel Python `uv`/`FastAPI`/`LangGraph` + TypeScript/Next.js 15/`@ai-sdk/react` builders, and Playwright headless Chromium UX verifiers) working against locked Option A/B Markdown specifications (`01_...`, `02_...`).
- **Five-Layer AI Behavior Validation & Regression Process:**
  1. **Deterministic Digital Twin Ground Truth (`scripts/generate_twin.py`, `seed = 20261117`):** Generates `12` campaigns, `104` ad groups, and `10,400` daily performance rows with fixed-point Python `Decimal` mutation replay (`backend/app/twin.py`). Every AI tool output (`audit_campaign_hygiene`, `analyze_in_sandbox`, `propose_budget_reallocation`, `compile_and_run_workflow`) is checked to the exact cent and basis point against deterministic ground truth—catching hallucinated numbers or budget-conservation drift immediately.
  2. **156 Automated Python Backend & Agent Evals (`uv run pytest`):** Verifies AI Gateway `POST /v1/decisions` semantic routing and `<0.60` low-confidence fallbacks (`test_semantic_router.py`), malformed/double-quoted LLM tool-argument recovery (`unwrap_llm_str` + Pydantic `before` validators added after live testing exposed free-tier models emitting `"\"all\""`), `x-vercel-ai-ui-message-stream: v1` golden SSE frame ordering, `max_tokens=2048` truncation alerts, 2,000-trial Monte Carlo invariants, and system-prompt anti-hallucination constraints (`test_whitebox_coverage.py`).
  3. **36 Frontend Contract & Whitebox Checks (`npm test` via `node --test`):** Validates AI SDK 7 `UIMessage` card rendering, suppressed retry error cards (`tool-errors.ts`), per-`toolCallId` human approval isolation before budget mutations execute, `zod`-strict zero-PII `/p/[slug]` share slugs, and progressive Top-5/Top-6 table disclosure.
  4. **Live Browser & Failure-Drill E2E Rubric (Playwright Headless Chromium):** Automated Chromium runs (`229` baseline E2E checks plus V5–V7 live verifiers) test end-to-end AI Gateway tool turns, `Primary 503 drill` 2-hop failover, campaign-pair Sandbox Monte Carlo sliders, `Changes (N)` Undo replay, `375px`/`1440px` responsive geometry, and `0` HTTP `>=400` errors.
  5. **Manual Transcript & Cognitive-Load Review:** Reviewing live multi-turn transcripts surfaced wall-of-text cognitive overload when models repeated tool-card tables in Markdown; resolved via `build_system_prompt()` visual de-duplication rules (`2–4` bullets, `~60–110` words max, zero internal IDs unless asked) + sequential `Next table` follow-up pills, then re-verified in live Chromium runs.
