# Relay Studio: Option A Working Demo Application (Vercel Build Specification, v2)

> **Purpose of this file:** Give this specification to a coding agent that has the Vercel CLI (Claude Code or Cursor with `vercel/vercel-plugin` installed) to build and deploy **Relay Studio**, a working reference application for **Option A (augment the existing Python stack)** at **Fieldstone**, a B2B marketing software company.
>
> **Deployment target:** one public Vercel URL, shareable with reviewers, hosted on the Hobby plan with **no datastore**.
>
> **Not verified:** whether `v0.app` can build a two-service (Next.js + Python) project. Use a CLI-based coding agent.

---

## 1. Product context and what this demo proves

**Fieldstone** operates **Relay**, an agentic campaign operations assistant. Digital marketers use it to audit ad creatives, analyze cross-channel performance, reallocate wasted ad spend, and schedule repeatable checks across Google Ads, LinkedIn Ads, Meta Ads, Analytics, and CRM.

In production, Fieldstone's backend is Python: `FastAPI` + `LangGraph` on Kubernetes, scheduled `Temporal` Python DAGs, a Postgres-compatible database, and hosted models. Option A keeps that backend and adds Vercel around it.

**The claim this demo must prove:** a Python `LangGraph` agent can keep running as Python and still get a Vercel front end, model routing, and isolated code execution. So the agent in this demo **is** a Python `FastAPI` + `LangGraph` service. There is no TypeScript agent anywhere in the repository.

**Hosting note:** the demo runs the Python service on Vercel so that one URL contains everything. In Fieldstone's production, the same adapter code would run on their existing Kubernetes cluster, and only the front end, gateway, and sandbox would be on Vercel. Say this in the inspector.

### Vercel pieces

| # | Piece | Status in this demo | What it does here |
| :-- | :-- | :-- | :-- |
| 1 | **AI Gateway** (AI stack) | Demonstrated | The Python agent calls models through the gateway's OpenAI-compatible endpoint with a two-tier router, ordered fallback models, and prompt caching. |
| 2 | **AI SDK UI** (`@ai-sdk/react`, AI stack) | Demonstrated | The Next.js client renders the Python agent's stream as typed tool cards. The Python service speaks the UI Message Stream Protocol. |
| 3 | **Sandbox** | Demonstrated | The Python agent runs SQL over 10,400 rows inside an isolated microVM and returns only summary rows to the model. |
| 4 | **Services + Preview Deployments** | Demonstrated | Next.js and FastAPI deploy as one project. Every pull request gets a preview URL containing both. |
| 5 | **Rolling Releases** | Described only | Needs a Pro or Enterprise plan. The inspector explains it as the production recommendation. Do not claim the demo shows it. |

---

## 2. Hosting and cost constraints

The demo must cost nothing to host apart from model tokens.

| Item | Plan fact | Consequence for the build |
| :-- | :-- | :-- |
| Datastore | None used | All mutable state lives in the visitor's browser (Section 4). Do not add Redis, Postgres, Blob, or any Marketplace storage. |
| Vercel plan | Hobby is free for personal, non-commercial projects | The owner confirms the demo fits that use before sharing the URL. |
| Services | Beta, available on all plans | Two services in one project. No service bindings are needed. |
| Firewall rate limit | Hobby allows 1 rate-limit rule per project | Use that one rule on `/api/agent/*`. |
| Sandbox | Hobby has a monthly free allotment. When it runs out, sandbox creation pauses until the next cycle | The in-process fallback in Section 6.4 is required, and the UI must badge which mode ran. |
| Model tokens | AI Gateway free credits cover a subset of models, with lower per-model rate limits | Model IDs come from environment variables so the owner can pick free-tier models or buy a small credit balance. Set a project budget either way. |
| Gateway reporting tags | Each `user` or tag value is a billed write | Off by default. Enabled only with `GATEWAY_REPORTING_TAGS=1`. |
| Function duration | Hobby maximum is 300 seconds | Keep every agent turn under 60 seconds. |

Reference pages: [Services](https://vercel.com/docs/services), [AI Gateway pricing](https://vercel.com/docs/ai-gateway/pricing), [free-tier models](https://vercel.com/ai-gateway/models?freeTier=true), [Sandbox pricing](https://vercel.com/docs/sandbox/pricing), [WAF rate limiting](https://vercel.com/docs/vercel-firewall/vercel-waf/rate-limiting), [Rolling Releases](https://vercel.com/docs/rolling-releases).

---

## 3. Architecture

```text
Browser (Next.js client, useChat)
   │  POST /api/agent/chat      { messages, twinMutations, tierHint, injectFailure }
   │  POST /api/agent/twin/state
   │  POST /api/agent/workflows/run
   ▼
Vercel project, one domain, one deployment
   ├── frontend service (Next.js App Router, Node.js 24)
   │      /            workspace UI
   │      /p/[slug]    public playbook page
   │      /api/og      social card image
   └── backend service (FastAPI + LangGraph, Python 3.12)
          /api/agent/*   agent, twin state, workflow dry run
              ├──▶ AI Gateway  (OpenAI-compatible endpoint, fallback models)
              └──▶ Vercel Sandbox (Python SDK, deny-all network)
```

### 3.1 Project configuration

Root `vercel.json`:

```json
{
  "$schema": "https://openapi.vercel.sh/vercel.json",
  "services": {
    "backend": { "root": "backend/", "framework": "fastapi", "entrypoint": "app.main:app" },
    "frontend": { "root": "frontend/", "framework": "nextjs" }
  },
  "rewrites": [
    { "source": "/api/agent/(.*)", "destination": { "service": "backend" } },
    { "source": "/(.*)", "destination": { "service": "frontend" } }
  ]
}
```

Rules:

- The backend receives the **original** path. FastAPI routes must be declared with the `/api/agent` prefix.
- Routing into a service is final. An unmatched `/api/agent/...` path returns the backend's own 404.
- Keep the Vercel project's Root Directory at the repository root.
- Local development: `vercel dev -L` from the repository root starts both services.
- Do not add `export const runtime = 'edge'` to any Next.js route.

Reference pages: [FastAPI on Vercel](https://vercel.com/docs/frameworks/backend/fastapi), [Python backend with Next.js guide](https://vercel.com/kb/guide/python-backend-on-vercel).

### 3.2 What is real and what is stood in

State this table in the inspector drawer as well. Reviewers should never have to guess.

| Production system | In this demo | Real or stand-in |
| :-- | :-- | :-- |
| Python `FastAPI` + `LangGraph` agent | Same stack, deployed as the backend service | **Real** |
| Model calls through a gateway | AI Gateway, live | **Real** |
| Isolated analytics execution | Vercel Sandbox, live, with in-process fallback | **Real**, fallback badged |
| Ad platform and CRM APIs | Seeded Digital Twin dataset | Stand-in |
| `LangGraph` checkpointer in the database | None. The graph is rebuilt from message history each turn | Stand-in |
| `Temporal` scheduled DAGs | Six steps run in-process, once, on click. Generated Temporal code is display-only | Stand-in |
| Slack and Sheets delivery | Digest preview rendered in the UI. Nothing is sent | Stand-in |

---

## 4. State model (no datastore)

Serverless instances do not share memory, and several visitors will use the same URL. State therefore lives with each visitor.

- **Base dataset:** generated once by `scripts/generate_twin.py` with `seed = 20261117` and committed as `backend/data/twin.json` and `backend/data/rows.csv`. It never changes at runtime.
- **Mutations:** an ordered list stored in `localStorage` under `relay.twin.mutations.v1`. The client sends the full list with every backend request.
- **Derived state:** the backend applies the list to the base dataset on every request. Python is the only implementation of this logic. The frontend never recomputes twin state.
- **Reset:** clears the `localStorage` key and refetches state.

Mutation types, validated with `pydantic` on every request (reject unknown IDs, cap list length at 50):

| Type | Fields | Rule |
| :-- | :-- | :-- |
| `pause_broken_creatives` | none | Marks every creative with a 404 destination as paused. |
| `fix_utm_taxonomy` | none | Rewrites every violating UTM to the canonical pattern. |
| `reallocate_budget` | `from_campaign`, `to_campaign`, `amount_per_day` | Both IDs must exist. Amount must be positive and no larger than the source budget. |

### 4.1 Dataset definition

Every number shown in the UI must come from this dataset or from live telemetry. Never hardcode a displayed figure.

| Channel | Campaigns | Ad groups per campaign | Ad groups | Daily budget | Broken 404 creatives | UTM violations |
| :-- | --: | --: | --: | --: | --: | --: |
| Google Ads | 5 | 10 | 50 | `$2,900` | 4 | 2 |
| LinkedIn Ads | 4 | 9 | 36 | `$2,200` | 6 | 3 |
| Meta Ads | 3 | 6 | 18 | `$1,067` | 4 | 4 |
| **Total** | **12** | | **104** | **`$6,167`** | **14** | **9** |

- Rows: 104 ad groups × 100 days = **10,400** daily rows with `date, channel, campaign_id, ad_group_id, spend, clicks, conversions, pipeline_value`.
- Monthly spend label: `$6,167` × 30 = `$185,010`, shown as "about `$185K` per month".
- Seed one LinkedIn campaign with a `$1,400` daily budget and the lowest return on ad spend in the dataset, and one Google exact-match campaign with the highest. The reallocation playbook then has a clear, reproducible answer.
- Add a generator test that asserts every total in this table.

---

## 5. Backend service (Python)

`backend/pyproject.toml`: `requires-python = ">=3.12"`. Dependencies: `fastapi`, `langgraph`, `langchain-openai`, `openai`, `pydantic`, `vercel-sandbox`, and `pytest` for tests. Keep the bundle well under the 500 MB Python limit.

### 5.1 Routes

| Route | Purpose |
| :-- | :-- |
| `POST /api/agent/chat` | Runs one agent turn and streams the UI Message Stream Protocol. |
| `POST /api/agent/twin/state` | Body `{ mutations }`. Returns derived channel health, campaign budgets, and counts. |
| `POST /api/agent/workflows/run` | Body `{ workflow, mutations }`. Streams six step events with measured timings. |
| `GET /api/agent/health` | Returns Python version, `VERCEL_ENV`, `VERCEL_DEPLOYMENT_ID`, commit SHA, pricing source, and sandbox availability. |

### 5.2 The stream adapter (`app/ui_stream.py`)

This file is the centre of the demo. It converts `LangGraph` events into Server-Sent Events that `useChat` understands. Follow the [stream protocol reference](https://ai-sdk.dev/docs/ai-sdk-ui/stream-protocol) and the [next-fastapi example](https://github.com/vercel/ai/tree/main/examples/next-fastapi).

Response headers:

```text
content-type: text/event-stream
cache-control: no-cache
x-vercel-ai-ui-message-stream: v1
```

Events to emit, each as `data: <json>\n\n`:

| Order | Event | When |
| :-- | :-- | :-- |
| 1 | `{"type":"start","messageId":...}` | Once per response |
| 2 | `{"type":"start-step"}` | Before each model call |
| 3 | `text-start`, `text-delta`, `text-end` (shared `id`) | As model text streams |
| 4 | `{"type":"tool-input-available","toolCallId","toolName","input"}` | When the model requests a tool |
| 5 | `{"type":"tool-output-available","toolCallId","output"}` | When the tool returns |
| 6 | `{"type":"data-telemetry","data":{...}}` | Once per model call (Section 5.5) |
| 7 | `{"type":"finish-step"}` | After each model call |
| 8 | `{"type":"finish"}` then `data: [DONE]` | End of response |
| any | `{"type":"error","errorText":...}` | On any exception. Never let the stream end silently. |

Inbound conversion (`app/ui_messages.py`): the client sends AI SDK `UIMessage` objects. Convert text parts to human or AI messages, and completed tool parts to an AI message with a tool call plus a matching tool message. Ignore parts in any other state.

Tests: a `pytest` golden-transcript test asserts the exact event order for a text-only turn, a single-tool turn, and an error turn.

### 5.3 Agent graph (`app/agent.py`)

- A `LangGraph` tool-calling agent with four tools (Section 6) and a hard limit of 6 model calls per turn.
- No checkpointer. Rebuild state from the request's message history every turn.
- Build the model client **per request**, not at import time, so the credential is always current:

```python
import os
from langchain_openai import ChatOpenAI

def build_model(primary: str, fallbacks: list[str]) -> ChatOpenAI:
    gateway = {"models": fallbacks, "caching": "auto"}
    if os.getenv("GATEWAY_REPORTING_TAGS") == "1":
        gateway["tags"] = ["app:relay-studio-demo"]
    return ChatOpenAI(
        model=primary,
        base_url="https://ai-gateway.vercel.sh/v1",
        api_key=os.getenv("AI_GATEWAY_API_KEY") or os.getenv("VERCEL_OIDC_TOKEN"),
        max_tokens=1200,
        stream_usage=True,
        extra_body={"providerOptions": {"gateway": gateway}},
    )
```

Reference pages: [AI Gateway from Python](https://vercel.com/docs/ai-gateway/sdks-and-apis/python), [model fallbacks](https://vercel.com/docs/ai-gateway/models-and-providers/model-fallbacks).

### 5.4 Tier router (`app/router.py`)

No extra model call. Two inputs decide the tier:

1. **Playbook cards** send an explicit `tierHint` of `fast` or `reasoning`.
2. **Free text** uses a keyword rule: `reasoning` if the message matches `realloc|budget|shift|strategy|plan|workflow|schedule|guardrail`, otherwise `fast`.

Model IDs come from environment variables with these defaults (prices checked against the [model list](https://ai-gateway.vercel.sh/v1/models) on 2026-11-17):

| Variable | Default |
| :-- | :-- |
| `FAST_MODELS` | `google/gemini-4-hydrogen,anthropic/claude-haiku-5.5,google/gemini-3.1-flash-lite` |
| `REASONING_MODELS` | `google/gemini-4-argon,anthropic/claude-sonnet-5.5,google/gemini-3.1-pro-preview` |

The first ID is the primary. The rest are the ordered fallbacks.

### 5.5 Telemetry (`data-telemetry` part)

Emit one per model call:

```json
{
  "tier": "fast", "routedBy": "card",
  "primaryModel": "...", "servedModel": "...",
  "failover": "none | gateway | simulated",
  "inputTokens": 0, "cachedTokens": 0, "outputTokens": 0,
  "costUsd": 0.0, "baselineCostUsd": 0.0, "latencyMs": 0
}
```

Rules:

- `servedModel` is the `model` field the gateway returns. Token counts come from the response usage. Report `cachedTokens` as returned, including `0`. Short prompts often cache nothing.
- `costUsd`: use the gateway's reported cost if the response carries one. Otherwise compute it from per-token prices loaded from the model list at first request and held in module memory, falling back to a pinned table in `app/pricing.py` dated 2026-11-17.
- `baselineCostUsd`: the same token counts priced at the reasoning-tier primary. This is the **only** savings baseline in the app. Label it "vs. every turn on the reasoning model".

### 5.6 Failure injection

The inspector has a switch labelled **Inject primary-model failure**. It must not overclaim.

1. **Spike first (about 30 minutes).** Send one request whose primary is an intentionally invalid model ID with a valid fallback list. Record whether the gateway serves the fallback and reports the failed attempt in its provider metadata (`modelAttempts`).
2. **If the gateway fails over:** use that path when the switch is on. Set `failover: "gateway"`. Badge: `Gateway failover → <servedModel>`.
3. **If the gateway rejects the request:** raise a synthetic 503 for the primary inside the service, then call the first fallback as the primary. Set `failover: "simulated"`. Badge: `Simulated outage · app-level retry → <servedModel>`.

Never label an app-level retry as a gateway failover. Independently of the switch, if a real failover happens on any turn, show it.

---

## 6. Agent tools (Python)

Tool names are part of the client contract. Each renders as a tool part of type `tool-<name>`.

### 6.1 `audit_campaign_hygiene`

Returns broken-URL creatives and UTM violations from the current twin state, grouped by channel, with daily spend at risk.

### 6.2 `propose_budget_reallocation`

Runs the SQL in Section 6.4, then returns `{ proposalId, fromCampaign, toCampaign, amountPerDay, before, after, blendedRoasBefore, blendedRoasAfter }`.

- Blended return formula: `Σ(budget_i × roas_i) / Σ(budget_i)`, computed before and after the shift. Show the formula in the card's details drawer.
- This tool **never** mutates state. See the approval flow in Section 7.4.

### 6.3 `compile_workflow`

Returns a six-node workflow as JSON plus a generated Python `Temporal` workflow as a string.

Nodes: Fetch channels → Check creative URL status → Validate UTM schema → Aggregate rows in Sandbox → Threshold gate → Digest.

### 6.4 `analyze_in_sandbox`

Runs one SQL aggregation over `rows.csv` using Python's standard-library `sqlite3`. No package installs, because the sandbox has no network.

```python
from vercel import sandbox
from vercel.sandbox import NetworkPolicy

async with sandbox.create_sandbox(
    network_policy=NetworkPolicy.deny_all(),
    execution_time_limit=30,
) as box:
    await box.fs.write_text("rows.csv", csv_text)
    await box.fs.write_text("job.py", job_source)
    result = await box.run_command("python", ["job.py"], capture_output=True, check=True)
    summary = json.loads(result.stdout.decode())
```

- The context manager stops and destroys the sandbox on exit.
- `job.py` loads the CSV into an in-memory `sqlite3` table and prints the query result as JSON.
- The SQL comes from a fixed set of parameterized templates in `app/sql_templates.py`. The model chooses a template and parameters. It does not write SQL.
- **Fallback:** on any sandbox error, or when `SANDBOX_DISABLED=1`, run the identical `job.py` logic in-process and return `mode: "in-process"`.
- Return `{ mode, sandboxMs, rowsScanned, rowsReturned, sql, table, estTokensAvoided }`.
  - `sandboxMs` is wall-clock time measured by the service.
  - `estTokensAvoided = len(csv_text) / 4 − len(json_summary) / 4`, labelled "estimated".

Reference page: [Sandbox Python SDK](https://vercel.com/docs/sandbox/python-sdk-reference).

### 6.5 Workflow dry run

`POST /api/agent/workflows/run` executes the six nodes in order against the twin and streams one event per node with `{ node, status, ms, detail }`.

- "Check creative URL status" reads the twin's status field. It makes no outbound HTTP requests.
- "Aggregate rows in Sandbox" calls the same code as Section 6.4.
- "Digest" returns the text a Slack or Sheets message would contain. Nothing is sent.

---

## 7. Frontend service (Next.js)

Node.js 24, App Router, `ai` and `@ai-sdk/react`. Use the current documented API for the installed major version. If a named API in this file differs from the installed documentation, follow the documentation.

### 7.1 Chat wiring

- `useChat` with `DefaultChatTransport({ api: '/api/agent/chat' })`.
- Attach `twinMutations`, `tierHint`, and `injectFailure` to every request through the transport's request-body option.
- Render `message.parts`. Handle `text`, the four `tool-*` types, and `data-telemetry`.
- There is no `/api/chat` route in Next.js.

### 7.2 Visual direction

- Light-first Geist surface. Load `Geist` and `Geist_Mono` with `next/font/google`.
- Colours (one value each): surface `#FFFFFF`, secondary surface `#FAFAFA`, border `#EAEAEA` at `1px`, ink `#171717`, secondary ink `#666666`, blue `#0070F3`, green `#0E8A16`, amber `#D97706`, red `#E5484D`.
- `font-variant-numeric: tabular-nums` on every number.
- One accent colour per card. No gradient text, no glow effects, no dark purple theme, no animated badges above headings.
- Raw SQL, generated Python, and request details go inside `<details>` drawers, never in the main stream.
- Cards in a row share the same vertical structure: eyebrow, title, summary, action pinned to the bottom with `margin-top: auto`.

### 7.3 Layout

**Header (`56px`, sticky)**

- Left: logomark, `Fieldstone / Relay Studio`, and a pill with the campaign and row counts from twin state.
- Right: a session spend pill, a **Share playbook** button, and an **Inspector** toggle.
- The session spend pill reads `Session: $<sum of costUsd> · <percent> less than every turn on the reasoning model`. Before the first turn it reads `Session: $0.00`.

**Cold start (no messages)**

1. Channel health strip: four items built from `POST /api/agent/twin/state`. Each shows campaigns, broken URLs, and UTM issues for that channel. The fourth shows the row count.
2. A 2×2 playbook grid. Each card sends a fixed prompt and a `tierHint`:

| Card | Eyebrow | Tier hint | Tool it should trigger |
| :-- | :-- | :-- | :-- |
| Creative and UTM hygiene audit | `FAST TIER` | `fast` | `audit_campaign_hygiene` |
| Cross-channel return analysis | `SANDBOX + FAST TIER` | `fast` | `analyze_in_sandbox` |
| Reallocate wasted paid social spend | `REASONING TIER + APPROVAL` | `reasoning` | `propose_budget_reallocation` |
| Compile a daily pacing guardrail | `REASONING TIER + WORKFLOW` | `reasoning` | `compile_workflow` |

Eyebrows name the tier, never a model. The served model appears only in the telemetry strip.

**Composer (always visible, bottom of the workspace)**

- Single-line text input that grows to four lines, a send button, and a stop button while streaming.
- Enter sends. Shift+Enter adds a line. Limit input to 2,000 characters.
- Disabled while a response streams.

**Conversation (one or more messages)**

- **Telemetry strip** above each assistant turn, monospace, built from the `data-telemetry` part: tier, how it was routed, served model, latency, input tokens with cached count, output tokens, and turn cost. Show the failover badge from Section 5.6 when present.
- **Hygiene card:** table of flagged items with channel pills and spend at risk. One button, labelled with live counts, for example `Fix 9 UTMs and pause 14 creatives`. On click, append both mutations, refetch twin state, and show `Applied`.
- **Sandbox card:** mode badge (`Vercel Sandbox` or `In-process fallback`), rows scanned and returned, estimated tokens avoided, horizontal bars by channel, and a drawer with the executed SQL.
- **Reallocation card:** before and after daily budgets side by side, blended return before and after, and **Approve** and **Decline** buttons.
- **Workflow card:** six-node pipeline, a **Test run** button that streams step results from the dry-run route, a **Share playbook** button, and a drawer holding the generated Temporal code under the heading `Generated for production. Not executed in this demo.`

**States every card needs:** streaming skeleton, completed, and error with a retry button. Stream errors render as a red inline card with the error text.

**Responsive and accessible:** single column below `768px`, with the inspector as a full-screen sheet. All controls keyboard reachable with visible focus. Body text contrast at least 4.5:1.

### 7.4 Approval flow

The demo has no checkpointer, so approval is client-held:

1. The agent returns a proposal. Nothing changes.
2. **Approve** appends a `reallocate_budget` mutation, refetches twin state, and sends the user message `Approved proposal <proposalId>.`
3. **Decline** sends `Declined proposal <proposalId>.` and changes nothing.
4. The backend validates the mutation on the next request like any other.

In the inspector, state plainly that production would pause the graph with a `LangGraph` interrupt backed by a database checkpointer.

### 7.5 Sharing (`/p/[slug]` and `/api/og`)

- A slug is `base64url(JSON)` of `{ template, channels, threshold }` only.
  - `template`: one of four fixed IDs.
  - `channels`: a subset of the three channel IDs.
  - `threshold`: an integer from 1 to 100.
- Validate with `zod` on every read. An invalid slug returns 404. Titles and descriptions come from the template table in code, never from the slug, so a crafted link cannot put arbitrary text on the page or the image.
- Four canonical slugs are precomputed, including `/p/creative-404-guard` as an alias.
- `/api/og?slug=...` returns a `1200×630` image with the template title, step count, and channels, plus the line `Built in Relay Studio`.
- The share modal shows the URL, a copy button with `Copied` feedback, and the live card image.
- `/p/[slug]` explains the playbook, shows its six steps, and has one button: **Open in Relay Studio**. It links to `/?remix=<slug>`, which **prefills** the composer and highlights the matching card. It does not send anything until the visitor clicks.

### 7.6 Inspector drawer

1. **Real and stand-in table** from Section 3.2.
2. **Inject primary-model failure** switch (Section 5.6).
3. **Session ledger:** calls, tokens, and cost by tier and by tool, with the single baseline from Section 5.5.
4. **Python adapter tab:** the actual source of `backend/app/ui_stream.py`, read at build time, with a copy button and the heading `This file is running. It produced the stream you are reading.`
5. **Deployment tab:** environment, deployment ID, commit SHA, and Python version from `/api/agent/health`, followed by a short note on Preview Deployments and on Rolling Releases as the production recommendation.
6. **Later phase note:** two or three sentences on what stays on the existing cloud today and what a later backend-runtime move would change.
7. **Reset demo** button.

---

## 8. Abuse and spend controls

The URL is public and has no login.

- **Firewall:** one rate-limit rule on `/api/agent/*`, for example 20 requests per minute per IP.
- **Gateway budget:** set a project budget in the AI Gateway dashboard, for example `$10`.
- **Per-request caps in the backend:** at most 30 messages, 2,000 characters in the newest user message, 6 model calls, `max_tokens = 1200`, and a 55-second overall timeout that emits an `error` part.
- **No auto-run:** nothing calls a model on page load, including `/?remix=`.
- **Sandbox:** at most one sandbox per request, 30-second limit, deny-all network.

---

## 9. Project structure

```text
relay-studio-demo/
├── vercel.json
├── scripts/
│   └── generate_twin.py            # Seeded dataset generator
├── backend/
│   ├── pyproject.toml
│   ├── data/
│   │   ├── twin.json
│   │   └── rows.csv
│   ├── app/
│   │   ├── main.py                 # FastAPI app and routes
│   │   ├── agent.py                # LangGraph graph and model client
│   │   ├── router.py               # Tier rules and model lists
│   │   ├── ui_stream.py            # LangGraph events → UI message stream
│   │   ├── ui_messages.py          # UIMessage → LangChain messages
│   │   ├── twin.py                 # Base data, mutations, derived state
│   │   ├── tools.py                # Four agent tools
│   │   ├── sandbox_runner.py       # Sandbox run with in-process fallback
│   │   ├── sql_templates.py
│   │   ├── workflow.py             # Six-step dry run and Temporal code generator
│   │   └── pricing.py              # Live price load with pinned fallback
│   └── tests/
│       ├── test_ui_stream.py       # Golden transcripts
│       ├── test_twin.py            # Dataset totals and mutation rules
│       └── test_sandbox_runner.py  # Fallback parity
└── frontend/
    ├── package.json
    ├── app/
    │   ├── layout.tsx
    │   ├── globals.css
    │   ├── page.tsx
    │   ├── p/[slug]/page.tsx
    │   └── api/og/route.tsx
    ├── components/
    │   ├── HeaderBar.tsx
    │   ├── ChannelHealthStrip.tsx
    │   ├── PlaybookGrid.tsx
    │   ├── Composer.tsx
    │   ├── TelemetryStrip.tsx
    │   ├── HygieneCard.tsx
    │   ├── SandboxCard.tsx
    │   ├── ReallocationCard.tsx
    │   ├── WorkflowCard.tsx
    │   ├── ShareModal.tsx
    │   └── InspectorDrawer.tsx
    └── lib/
        ├── twin-client.ts          # localStorage mutation log and state fetch
        ├── playbooks.ts            # Four templates and prompts
        └── share.ts                # Slug codec and validation
```

---

## 10. Environment variables

| Variable | Where | Purpose |
| :-- | :-- | :-- |
| `VERCEL_OIDC_TOKEN` | Set by Vercel on deployments | Gateway and Sandbox credential |
| `AI_GATEWAY_API_KEY` | Local development, optional on Vercel | Gateway credential when no OIDC token is present |
| `FAST_MODELS`, `REASONING_MODELS` | Optional | Override model lists (Section 5.4) |
| `GATEWAY_REPORTING_TAGS` | Optional, default off | Adds billed reporting tags |
| `SANDBOX_DISABLED` | Optional | Forces the in-process fallback |

If no gateway credential exists, `/api/agent/chat` emits one `error` part reading `No AI Gateway credential. Run "vercel env pull" or set AI_GATEWAY_API_KEY.` The UI shows it as a setup card. There is no scripted or simulated model mode.

---

## 11. Build order

Ship each milestone to a preview URL before starting the next.

1. **Skeleton:** `vercel.json`, both services, `/api/agent/health`, and a page that displays it. Proves two-service routing.
2. **Stream adapter:** a text-only `LangGraph` turn through AI Gateway rendered by `useChat`. Golden-transcript tests pass.
3. **Twin and state:** generator, mutations, state route, health strip, and reset.
4. **Tools and cards:** hygiene, then sandbox, then reallocation with approval, then workflow with dry run.
5. **Telemetry:** strip, ledger, session pill, and the failure-injection spike and switch.
6. **Sharing:** slug codec, `/p/[slug]`, `/api/og`, and remix prefill.
7. **Hardening:** rate-limit rule, budget, request caps, responsive pass, and accessibility pass.

If time runs short, cut milestone 6 before anything else.

---

## 12. Acceptance checklist

**Build**

1. `npm run build` and `npx tsc --noEmit` pass in `frontend/`. `pytest` passes in `backend/`.
2. `vercel dev -L` serves both services locally. A production deploy on the Hobby plan succeeds with no storage integration attached.

**The Python claim**

3. `curl -N -X POST <url>/api/agent/chat` returns `x-vercel-ai-ui-message-stream: v1` and ends with `data: [DONE]`.
4. `/api/agent/health` reports a Python version. The repository contains no Next.js chat route and no TypeScript model call.

**Flows**

5. Each of the four playbook cards produces its tool card. Free-text prompts work from the composer.
6. The telemetry strip shows the served model returned by the gateway. With the failure switch on, the badge matches the mode chosen in Section 5.6.
7. The sandbox card shows `Vercel Sandbox` on the deployed URL and `In-process fallback` with `SANDBOX_DISABLED=1`. Both return identical tables.
8. Approve changes the budgets in the health strip. Decline changes nothing. Reset restores every total in Section 4.1.

**State**

9. Two browsers on the same URL hold independent twin state.
10. Approving a reallocation, waiting ten minutes, then sending another message still shows the approved budgets.

**Sharing and safety**

11. `/p/creative-404-guard` renders. A tampered slug returns 404. `/api/og` returns a `1200×630` image.
12. Opening `/?remix=<slug>` makes no request to `/api/agent/chat` until the visitor clicks send.
13. More than 20 requests in a minute to `/api/agent/chat` from one IP are blocked.
14. No displayed number is a literal in the frontend source. Search the source for the dataset totals to confirm.
