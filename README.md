# Relay Studio — Fieldstone Option A Reference Application

Relay Studio is an interactive reference application for **Fieldstone's** campaign operations assistant (**Relay**). It demonstrates **Option A (augment the existing Python stack)**: keeping a Python 3.12 `FastAPI` + `LangGraph` agent intact while pairing it with a Next.js App Router workspace (`@ai-sdk/react`), two-tier model routing through Vercel AI Gateway, isolated SQL execution inside Vercel Sandbox microVMs, and single-domain multi-service routing via Vercel Services—with zero external datastore.

## Architecture Specifications in This Repository

- [`01_Option_A_Relay_Studio_Vercel_App_Spec.md`](./01_Option_A_Relay_Studio_Vercel_App_Spec.md) — End-to-end build specification for this Option A application (routes, UI Message Stream Protocol v1 contract, Digital Twin state model, tools, Geist visual rubric, guardrails, and acceptance checks).
- [`02_Option_B_Roadmap_and_Architecture_White_Paper_Spec.md`](./02_Option_B_Roadmap_and_Architecture_White_Paper_Spec.md) — Companion architecture white paper comparing **Option A (Augment Now — Keep Python Intact)** with **Option B (Phase 2 Backend Runtime Migration to Vercel Workflows + `WorkflowAgent`)**, including a sourced Temporal vs. Vercel Workflows evaluation.

## System Topology

```text
Browser (Next.js App Router, @ai-sdk/react useChat, Geist light-first UI)
   │  POST /api/agent/chat          (UI Message Stream Protocol v1 SSE)
   │  POST /api/agent/twin/state    (Python-derived Digital Twin state)
   │  POST /api/agent/workflows/run (6-step workflow dry-run SSE)
   │  GET  /api/agent/health        (Python runtime & deployment metadata)
   ▼
Vercel Services Project (vercel.json — single domain, zero datastore)
   ├── frontend/  (Next.js App Router: /, /p/[slug], /api/og)
   └── backend/   (Python 3.12 FastAPI + LangGraph, entrypoint app.main:app)
          ├──▶ Vercel AI Gateway (two-tier router, ordered fallbacks, auto caching)
          └──▶ Vercel Sandbox    (ephemeral deny-all microVM sqlite3 + badged fallback)
```

- **Python owns agent orchestration and state derivation**: There is no TypeScript agent, no Next.js `/api/chat` route, no Edge runtime export, and no simulated model mode.
- **Browser-held mutations over a deterministic Digital Twin**: `scripts/generate_twin.py` (`seed = 20261117`) produces committed read-only `backend/data/twin.json` and `backend/data/rows.csv` (`12` campaigns, `104` ad groups, `10,400` daily performance rows across Google Ads, LinkedIn Ads, and Meta Ads, `$6,167` daily budget, `14` broken 404 creatives, and `9` UTM violations). Visitor mutations live in `localStorage["relay.twin.mutations.v1"]` (capped at 50 `pydantic`-validated items) and are replayed solely in Python on each request.

## Repository Layout

```text
.
├── vercel.json                                              # Two-service routing (/api/agent/* -> backend, /* -> frontend)
├── .env.example                                             # Environment variable template (zero secrets)
├── 01_Option_A_Relay_Studio_Vercel_App_Spec.md              # Option A build specification
├── 02_Option_B_Roadmap_and_Architecture_White_Paper_Spec.md # Option B white paper & Phase 2 roadmap
├── scripts/
│   └── generate_twin.py                                     # Deterministic Digital Twin generator (seed = 20261117)
├── backend/
│   ├── .python-version                                      # Pins Python 3.12
│   ├── pyproject.toml                                       # FastAPI, LangGraph, AI Gateway, Vercel Sandbox & pytest config
│   ├── uv.lock                                              # Locked Python dependencies
│   ├── data/                                                # Committed base twin.json & rows.csv (10,400 rows)
│   ├── app/                                                 # FastAPI routes, LangGraph agent, UI stream v1 adapter & tools
│   └── tests/                                               # pytest suite (twin invariants, golden SSE streams, sandbox parity)
└── frontend/                                                # Next.js App Router workspace, typed tool cards, /p/[slug] & /api/og
```

## Environment Variables

Copy `.env.example` to `.env.local` (or run `vercel env pull` on a linked Vercel project):

| Variable | Required | Default | Purpose |
| :--- | :--- | :--- | :--- |
| `VERCEL_OIDC_TOKEN` | On Vercel | `""` | Short-lived OIDC credential for AI Gateway and Vercel Sandbox |
| `AI_GATEWAY_API_KEY` | Optional locally | `""` | AI Gateway API key when `VERCEL_OIDC_TOKEN` is not present |
| `FAST_MODELS` | No | `nvidia/nemotron-3.5-lightning-free,reflection/beam-free,stealth/glyph-cluster` | Primary + ordered fallback free-tier models for fast-tier turns |
| `REASONING_MODELS` | No | `reflection/beam-free,humansand/ampersand-v0.1,recursive/flint-v1.0` | Primary + ordered fallback free-tier models for reasoning-tier turns |
| `GATEWAY_REPORTING_TAGS` | No | `"0"` | Set to `"1"` to attach `["app:relay-studio-demo"]` reporting tags |
| `SANDBOX_DISABLED` | No | `"0"` | Set to `"1"` to force the badged in-process Python `sqlite3` fallback |

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
cd backend && SANDBOX_DISABLED=1 uv run uvicorn app.main:app --host 127.0.0.1 --port 8000

# Terminal 2 — Next.js frontend
cd frontend && npm run dev
```
