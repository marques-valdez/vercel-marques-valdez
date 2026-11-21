# Relay Studio — Fieldstone Option A Reference Application

**Live Public Demo:** https://vercel-marques-valdez.vercel.app *(Opt-In Architect X-Ray: https://vercel-marques-valdez.vercel.app/?xray=1 · Health Probe: https://vercel-marques-valdez.vercel.app/api/agent/health)*  
**Public GitHub Repository:** https://github.com/marques-valdez/vercel-marques-valdez

Relay Studio is an interactive reference application for **Fieldstone's** campaign operations assistant (**Relay**). It demonstrates **Option A (augment the existing Python stack)**: keeping a Python 3.12 `FastAPI` + `LangGraph` agent intact while pairing it with a Next.js 15 App Router workspace (`ai@7`, `@ai-sdk/react`) on **Fluid Compute**, hybrid two-tier model routing through **Vercel AI Gateway**, isolated Python & SQL compute inside **Vercel Sandbox** microVMs, and single-domain multi-service routing via **Vercel Services**—running out of the box with zero required datastore (and optional Neon Serverless Postgres attachment).

## Customer-Ready Submission Package & Architecture Specs

- [`SUBMISSION.md`](./SUBMISSION.md) — **Complete 8-section customer-ready submission brief** covering Problem Statement, Current & Target Architecture (plus what stays on GCP `us-east4` and why), Vercel Choices & Trade-Offs, Working Demo Walkthrough, 5-Stage Rollout Plan (`Preview → Validation → Canary → Cutover → Rollback`), Technical & Business Success Measures, Pre-Kickoff Limitations & Risks, and Development Tooling & AI Behavior Validation.
- [`ONE_PAGER.md`](./ONE_PAGER.md) — Executive 1-page architecture summary distilling all 8 submission sections onto a single brief.
- [`01_Option_A_Relay_Studio_Vercel_App_Spec.md`](./01_Option_A_Relay_Studio_Vercel_App_Spec.md) — Baseline build specification for this Option A application (routes, UI Message Stream Protocol v1 contract, Digital Twin state model, tools, Geist visual rubric, guardrails, and acceptance checks).
- [`02_Option_B_Roadmap_and_Architecture_White_Paper_Spec.md`](./02_Option_B_Roadmap_and_Architecture_White_Paper_Spec.md) — Companion architecture white paper comparing **Option A (Augment Now — Keep Python Intact)** with **Option B (Phase 2 Backend Runtime Migration to Vercel Workflows + `WorkflowAgent`)**, including a sourced Temporal vs. Vercel Workflows evaluation, rollout plan, pre-kickoff risks, and AI validation methodology.

## 4-Step Live Demo Walkthrough

1. **Start an agent session & invoke stateful tools (`12` campaigns · `104` ad groups · `10,400` rows):** Click **Creative & UTM Hygiene Audit** (`14` broken `404` URLs + `9` UTM violations; apply 1-click remediation and test **Undo** in the header `Changes (N)` audit log) or **What-If Budget Simulator** (pick any `From` / `To` campaign pair, drag the daily shift slider to trigger `POST /api/agent/reallocation/simulate` 2,000-trial Sandbox Monte Carlo P10/P50/P90 forecasts, and test human approval gating).
2. **Inspect AI Gateway routing:** Toggle **`X-Ray`** in the header (`/?xray=1`) to view pre-send tier previews (`fast` vs. `reasoning`), `<1ms` card fast-path vs. AI Gateway `POST /v1/decisions` semantic classifier confidence, and live Neon Postgres / Sandbox runtime badges.
3. **Demonstrate model failover without redesigning the application:** Enable **`Primary 503 drill`** in the `X-Ray` bar and submit any prompt to watch automatic 2-hop primary-to-fallback model recovery, explicitly distinguishing live `gateway` failover from `simulated` drill failover.
4. **Inspect the run trace, conversation cost & latency:** Open `TelemetryStrip`, `Protocol X-Ray` (live `x-vercel-ai-ui-message-stream: v1` wire frames mapped to `backend/app/ui_stream.py`), and the **FinOps Inspector** drawer to review prompt/completion tokens, active cost vs. frontier counterfactual savings, `~140K` Sandbox tokens avoided, and hop latency.

## System Topology

```text
Browser (Next.js 15 App Router on Fluid Compute, ai@7 @ai-sdk/react useChat, Geist UI + ?xray=1)
   │  POST /api/agent/chat                  (UI Message Stream Protocol v1 SSE + live step checklist)
   │  POST /api/agent/twin/state            (Python Fixed-Point Decimal Digital Twin replay)
   │  GET  /api/agent/trends?days=30        (30-day channel ROAS sparklines & 7d-vs-7d deltas)
   │  POST /api/agent/sandbox/query         (4 parameterized SQL slices without extra LLM turns)
   │  POST /api/agent/reallocation/simulate (What-If campaign-pair 2,000-trial Monte Carlo forecast)
   │  POST /api/agent/workflows/run         (6-step fan-out/fan-in workflow dry-run SSE)
   │  GET|PUT|DELETE /api/agent/workspace*  (Optional Neon Serverless Postgres workspace sync)
   │  GET  /api/agent/health                (Python runtime, Sandbox, pricing & DB status)
   ▼
Vercel Services Project (vercel.json — single domain, zero required datastore)
   ├── frontend/  (Next.js App Router: /, /p/[slug], /api/og, /icon.svg)
   └── backend/   (Python 3.12 FastAPI + LangGraph, entrypoint app.main:app)
          ├──▶ Vercel AI Gateway (card + /v1/decisions router, ordered fallbacks, auto caching)
          ├──▶ Vercel Sandbox    (deny-all microVM SQLite + 2,000-trial Monte Carlo Python)
          └──▶ Neon Postgres     (optional DATABASE_URL workspace & SQL analytics layer)
```

- **Python owns agent orchestration and state derivation**: There is no TypeScript agent, no Next.js `/api/chat` route, no Edge runtime export, and no simulated model mode.
- **Marketing Manager default UI + opt-in Architect X-Ray**: The default workspace stays focused on paid-media operations (30-day channel ROAS sparklines, live playbook urgency pills, concise progressive Top-5/Top-6 tool cards, sequential `Next table` follow-ups, interactive What-If campaign-pair budget modeling, floating `ImpactToast`, and a `Changes (N)` Undo audit popover). Toggling `X-Ray` in the header (or visiting `/?xray=1`) reveals the live Vercel Services topology bar, pre-send AI Gateway route preview, `Primary 503 drill`, `(N/4 ✓)` guided demo tour, `Protocol X-Ray` wire inspector, and FinOps Inspector drawer.
- **Deterministic Digital Twin + optional Neon Postgres**: `scripts/generate_twin.py` (`seed = 20261117`) produces committed read-only `backend/data/twin.json` and `backend/data/rows.csv` (`12` campaigns, `104` ad groups, `10,400` daily performance rows across Google Ads, LinkedIn Ads, and Meta Ads, `$6,167` daily budget, `14` broken 404 creatives, and `9` UTM violations). Visitor mutations live in `localStorage["relay.twin.mutations.v1"]` (capped at 50 `pydantic`-validated items) and replay deterministically in Python—syncing to Neon Serverless Postgres automatically when `DATABASE_URL` is configured.

## Production Rollout Plan & Pre-Kickoff Customer Readout

- **5-Stage Production Rollout (`Preview → Validation → Canary → Cutover → Rollback`):**
  1. **Preview (`Week 1`):** Link repo in `iad1` (`~2–5 ms` from GCP `us-east4`); wire GCP OIDC Workload Identity Federation and Vertex AI BYOK Virtual Models (`vmc/relay-fast`, `vmc/relay-reasoning`). Every PR generates an isolated Preview URL in `<3 min`.
  2. **Validation (`Weeks 1–2`):** Gate promotion on `156` Python `pytest` + `DeepEval` Digital Twin write checks, `36` frontend contract/whitebox tests, Playwright E2E suites, `70/30` shadow-traffic routing accuracy, and Week 1 verification of Vertex AI Provisioned Throughput over BYOK.
  3. **Canary (`Week 3`):** Shift `5% → 25% → 50%` of self-serve PLG cohorts via Pro/Enterprise **Rolling Releases**, gating on `<0.5%` AI Gateway 5xx, `>99%` SSE completion, `p95` TTFT, and flat `GKE` pod RSS during `10.4K`-row Sandbox queries.
  4. **Cutover (`Week 4`):** Promote to `100%` of UI traffic while keeping `100%` of Python `LangGraph`, `Temporal` cron DAGs, and `AlloyDB` intact on `GCP us-east4`.
  5. **Rollback (`< 5 Seconds`):** **Vercel Instant Rollback** reverts to the prior immutable build in `<5s` with zero rebuild, paired with Python `OPENAI_BASE_URL` / `SANDBOX_DISABLED=1` kill-switches on `GKE`.
- **Known Limitations & Pre-Kickoff Risks:** (1) Tab-close survival waits for Phase 2 (`WorkflowAgent` + `Workflows`, gated while `vercel-workflow` Python SDK is in Beta); (2) AI Gateway budgets exclude BYOK spend (enforce tenant caps in Relay's app ledger; Vertex BYOK needs a GCP service-account key org-policy exception); (3) `deny-all` Sandboxes block runtime `pip install` (`~300–900 ms` boot); and (4) never execute LLM-generated code in `experimental_dynamic` workflows.

## Development Tooling & How We Validated AI Behavior

- **IDE & Agentic Build Stack:** Built in a Linux cloud workstation via **agentic CLI/IDE orchestration** (architecture planner, parallel Python `uv`/`FastAPI`/`LangGraph` + TypeScript/Next.js 15 builders, and Playwright headless Chromium UX reviewers) anchored to committed Option A/B specs.
- **5-Layer AI Validation Suite:**
  1. **Deterministic Digital Twin Ground Truth (`seed = 20261117`):** Fixed-point Python `Decimal` mutation replay checks every tool call's ROAS, spend-at-risk, and budget math to the cent.
  2. **156 Python Backend & Agent Tests (`uv run pytest`):** Covers `/v1/decisions` confidence fallbacks (`test_semantic_router.py`), malformed/double-quoted LLM tool-arg recovery (`unwrap_llm_str` caught on live free-tier models), golden SSE v1 ordering, `max_tokens=2048` truncation alerts, and 2,000-trial Monte Carlo invariants.
  3. **36 Frontend Contract & Whitebox Tests (`npm test`):** Verifies AI SDK 7 `UIMessage` cards, retry error suppression (`tool-errors.ts`), per-`toolCallId` human approval gates, and `zod`-strict `/p/[slug]` codecs.
  4. **Live Browser & `503` Failover Rubric (Playwright Chromium):** Automated E2E runs verify AI Gateway turns, `Primary 503 drill` 2-hop failover, campaign-pair Sandbox simulations, `Changes (N)` Undo replay, `375px`/`1440px` layout geometry, and `0` HTTP `>=400` responses.
  5. **Manual Transcript Review:** Eliminated post-card duplicate Markdown tables via `build_system_prompt()` visual de-duplication rules (`2–4` bullets, `~60–110` words max) + sequential `Next table` follow-up chips.

## Repository Layout

```text
.
├── vercel.json                                              # Two-service routing (/api/agent/* -> backend, /* -> frontend)
├── .env.example                                             # Environment variable template (zero secrets)
├── SUBMISSION.md                                            # Complete 8-section customer-ready submission package
├── ONE_PAGER.md                                             # 1-page executive architecture summary
├── 01_Option_A_Relay_Studio_Vercel_App_Spec.md              # Option A baseline build specification
├── 02_Option_B_Roadmap_and_Architecture_White_Paper_Spec.md # Option B white paper & Phase 2 roadmap
├── scripts/
│   └── generate_twin.py                                     # Deterministic Digital Twin generator (seed = 20261117)
├── backend/
│   ├── .python-version                                      # Pins Python 3.12
│   ├── pyproject.toml                                       # FastAPI, LangGraph, AI Gateway, Vercel Sandbox, psycopg & pytest
│   ├── uv.lock                                              # Locked Python dependencies
│   ├── data/                                                # Committed base twin.json & rows.csv (10,400 rows)
│   ├── app/                                                 # FastAPI routes, LangGraph agent, UI stream v1 adapter, Sandbox & DB
│   └── tests/                                               # 156 pytest checks (twin, SSE, semantic router, Monte Carlo, DB)
└── frontend/                                                # Next.js 15 workspace, typed cards, charts, Undo ledger, /p/[slug] & /api/og
```

## Environment Variables

Copy `.env.example` to `.env.local` (or run `vercel env pull` on a linked Vercel project):

| Variable | Required | Default | Purpose |
| :--- | :--- | :--- | :--- |
| `VERCEL_OIDC_TOKEN` | On Vercel | `""` | Short-lived OIDC credential for AI Gateway and Vercel Sandbox |
| `AI_GATEWAY_API_KEY` | Optional locally | `""` | AI Gateway API key when `VERCEL_OIDC_TOKEN` is not present |
| `FAST_MODELS` | No | `nvidia/nemotron-3.5-lightning-free,reflection/beam-free,stealth/glyph-cluster` | Primary + ordered fallback models for fast-tier turns |
| `REASONING_MODELS` | No | `reflection/beam-free,humansand/ampersand-v0.1,recursive/flint-v1.0` | Primary + ordered fallback models for reasoning-tier turns |
| `SEMANTIC_ROUTER_MODE` | No | `"decisions"` | Tier router mode (`"decisions"` -> `$0` `"free-llm"` -> `"keyword"`) |
| `DECISION_ROUTER_MODEL` | No | `"baseten/joey-1"` | Primary AI Gateway `POST /v1/decisions` classifier model |
| `GATEWAY_REPORTING_TAGS` | No | `"0"` | Set to `"1"` to attach `["app:relay-studio-demo"]` reporting tags |
| `SANDBOX_DISABLED` | No | `"0"` | Set to `"1"` to force the badged in-process Python fallback |
| `DATABASE_URL` | No | `""` | Optional Neon Serverless Postgres URL (falls back to browser-local mode) |

When neither `VERCEL_OIDC_TOKEN` nor `AI_GATEWAY_API_KEY` is configured, `POST /api/agent/chat` streams a valid `x-vercel-ai-ui-message-stream: v1` setup `error` part instructing the operator to run `vercel env pull` or set `AI_GATEWAY_API_KEY`.

## Local Setup & Verification

### 1. Backend (Python 3.12 + `uv`)

```bash
cd backend
uv python install 3.12
uv sync --python 3.12
uv run pytest
```

Regenerate and verify deterministic Digital Twin artifacts from the repository root:

```bash
uv run --project backend python scripts/generate_twin.py
```

### 2. Frontend (Node.js + Next.js App Router)

```bash
cd frontend
npm install
npx tsc --noEmit
npm test
npm run build
```

### 3. Run Locally

With Vercel CLI (`>= 48.1.8`) from the repository root:

```bash
vercel dev -L
```

Or as two standalone local processes (when `VERCEL` is unset, `frontend/next.config.mjs` proxies `/api/agent/*` to `http://127.0.0.1:8000`):

```bash
# Terminal 1 — Python 3.12 FastAPI backend
cd backend && SANDBOX_DISABLED=1 uv run uvicorn app.main:app --host 127.0.0.1:8000 --port 8000

# Terminal 2 — Next.js frontend
cd frontend && npm run dev
```
