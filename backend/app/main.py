"""FastAPI backend service for Relay Studio (/api/agent/* routes and §8 guardrails).

Architecture role:
    Mounted as the `backend` service in `vercel.json` (Vercel Services) behind
    `/api/agent/*` so the Next.js frontend and Python LangGraph runtime ship
    under one origin with zero CORS or auth proxy hops. In production, the exact
    same FastAPI routes can run on Fieldstone's existing GKE cluster unchanged.

Key invariants enforced at the HTTP boundary:
    - Stateless per-request execution: the browser sends its `localStorage`
      mutation log on every request; Python validates and replays it cleanly.
    - Bounded per-IP sliding-window rate limiting (`20 req / 60s / IP` on chat,
      `60 req / 60s / IP` on interactive `POST /api/agent/reallocation/simulate`)
      with LRU eviction (`4096` IPs) to prevent unbounded memory growth.
    - Exposes read-only helper routes (`GET /api/agent/trends`, `POST /api/agent/sandbox/query`,
      `POST /api/agent/reallocation/simulate`, and optional `/api/agent/workspace*`
      Neon sync) so UI sliders, sparklines, and SQL tabs run with zero LLM tokens.
    - Strict input sanitization: rejects NaN/Inf floats and lone UTF-16
      surrogates before they can break JSON serialization or downstream LLMs.
"""

from __future__ import annotations

from collections import OrderedDict, deque
import json
import math
import os
import platform
import re
import threading
import time
from typing import Any, AsyncIterator, Final, Literal, Mapping, Self

import anyio
from fastapi import Body, FastAPI, Query, Request
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import (
    AliasChoices,
    BaseModel,
    ConfigDict,
    Field,
    ModelWrapValidatorHandler,
    PrivateAttr,
    ValidationError,
    model_validator,
)
from pydantic_core import InitErrorDetails, PydanticCustomError

from app.agent import build_agent_graph
from app.backtest import (
    BACKTEST_MAX_DAYS,
    BACKTEST_MIN_DAYS,
    BacktestResult,
    run_guardrail_backtest,
)
from app.db import (
    fetch_campaign_daily_series,
    is_database_configured,
    load_workspace_snapshot,
    normalize_workspace_id,
    record_telemetry_event,
    reset_workspace_data,
    save_workspace_messages,
    save_workspace_mutations,
    save_workspace_workflows,
)
from app.portfolio import PortfolioOptimizeResult, optimize_portfolio
from app.pricing import get_pricing_source
from app.router import TierName, route_turn, route_turn_async
from app.sandbox_runner import (
    ChannelTrendsResponse,
    SandboxQueryResult,
    compute_channel_daily_trends,
    is_sandbox_available,
    reset_request_sandbox_budget,
    restore_request_sandbox_budget,
    run_monte_carlo_reallocation_in_sandbox,
    run_sandbox_query,
)
from app.sql_templates import TemplateInputId
from app.twin import (
    DerivedTwinState,
    MutationList,
    TwinStateRequest,
    _raise_if_non_finite_float,
    compute_twin_state,
    preview_budget_reallocation,
)
from app.ui_messages import (
    MAX_MESSAGES,
    ConvertedConversation,
    contains_lone_surrogate,
    convert_ui_messages,
)
from app.ui_stream import (
    TURN_TIMEOUT_SECONDS,
    UI_MESSAGE_STREAM_HEADERS,
    get_gateway_credential,
    stream_langgraph_to_sse,
    stream_missing_credential_sse,
)
from app.workflow import normalize_workflow_run_config, stream_workflow_dry_run

RATE_LIMIT_MAX_REQUESTS: Final[int] = 20
RATE_LIMIT_WINDOW_SECONDS: Final[float] = 60.0
RATE_LIMIT_MAX_TRACKED_IPS: Final[int] = 4096

WORKFLOW_STREAM_HEADERS: Final[dict[str, str]] = {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
}

_SURROGATE_RE: Final[re.Pattern[str]] = re.compile(r"[\ud800-\udfff]")


def _raise_if_lone_surrogate(value: object, title: str) -> None:
    if contains_lone_surrogate(value):
        detail = InitErrorDetails(
            type=PydanticCustomError(
                "invalid_unicode_surrogate",
                "Unpaired UTF-16 surrogate code points are not allowed",
            ),
            loc=(),
            input="<surrogate>",
        )
        raise ValidationError.from_exception_data(title, [detail])


def _sanitize_json_value(obj: Any, *, _depth: int = 0) -> Any:
    """Sanitize non-finite floats and lone UTF-16 surrogates for JSON error responses."""
    if _depth > 64:
        return _SURROGATE_RE.sub("\ufffd", repr(obj))[:200]
    if isinstance(obj, float) and not isinstance(obj, bool):
        return repr(obj) if not math.isfinite(obj) else obj
    if isinstance(obj, str):
        return _SURROGATE_RE.sub("\ufffd", obj)
    if isinstance(obj, bytes):
        return obj.decode("utf-8", errors="replace")
    if isinstance(obj, Mapping):
        return {
            str(_sanitize_json_value(k, _depth=_depth + 1)): _sanitize_json_value(
                v, _depth=_depth + 1
            )
            for k, v in obj.items()
        }
    if isinstance(obj, (list, tuple, set, frozenset)):
        return [_sanitize_json_value(v, _depth=_depth + 1) for v in obj]
    if isinstance(obj, BaseException):
        return _SURROGATE_RE.sub("\ufffd", str(obj))
    return obj


class SlidingWindowRateLimiter:
    """Bounded LRU per-IP sliding-window rate limiter (20 requests / 60s / IP)."""

    def __init__(
        self,
        max_requests: int = RATE_LIMIT_MAX_REQUESTS,
        window_seconds: float = RATE_LIMIT_WINDOW_SECONDS,
        max_tracked_ips: int = RATE_LIMIT_MAX_TRACKED_IPS,
    ) -> None:
        self.max_requests = max_requests
        self.window_seconds = window_seconds
        self.max_tracked_ips = max_tracked_ips
        self._buckets: OrderedDict[str, deque[float]] = OrderedDict()
        self._lock = threading.Lock()

    def check(self, client_ip: str, *, now: float | None = None) -> tuple[bool, int]:
        with self._lock:
            ts = time.monotonic() if now is None else now
            cutoff = ts - self.window_seconds

            bucket = self._buckets.get(client_ip)
            if bucket is not None:
                while bucket and bucket[0] <= cutoff:
                    bucket.popleft()
                if not bucket:
                    del self._buckets[client_ip]
                    bucket = None

            if bucket is None:
                if len(self._buckets) >= self.max_tracked_ips:
                    expired = [
                        key
                        for key, q in self._buckets.items()
                        if not q or q[-1] <= cutoff
                    ]
                    for key in expired:
                        del self._buckets[key]
                    while len(self._buckets) >= self.max_tracked_ips:
                        self._buckets.popitem(last=False)
                bucket = deque()
                self._buckets[client_ip] = bucket
            else:
                self._buckets.move_to_end(client_ip)

            if len(bucket) >= self.max_requests:
                retry_after = max(1, math.ceil(bucket[0] + self.window_seconds - ts))
                return False, retry_after

            bucket.append(ts)
            return True, 0

    def reset(self) -> None:
        with self._lock:
            self._buckets.clear()


_chat_rate_limiter = SlidingWindowRateLimiter()
_simulate_rate_limiter = SlidingWindowRateLimiter(
    max_requests=60,
    window_seconds=RATE_LIMIT_WINDOW_SECONDS,
)
_backtest_rate_limiter = SlidingWindowRateLimiter(
    max_requests=30,
    window_seconds=RATE_LIMIT_WINDOW_SECONDS,
)


def reset_rate_limiter() -> None:
    """Clear all sliding-window rate-limiter buckets (used in isolated tests)."""
    _chat_rate_limiter.reset()
    _simulate_rate_limiter.reset()
    _backtest_rate_limiter.reset()


def extract_client_ip(request: Request) -> str:
    """Resolve client IP from first non-empty hop of X-Forwarded-For or request.client.host."""
    xff = request.headers.get("x-forwarded-for")
    if xff:
        for raw_hop in xff.split(","):
            hop = raw_hop.strip()[:128]
            if hop:
                return hop
    if request.client and request.client.host:
        return request.client.host[:128]
    return "unknown"


class HealthResponse(BaseModel):
    """Response contract for GET /api/agent/health."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    status: Literal["ok"] = "ok"
    pythonVersion: str
    vercelEnv: str
    deploymentId: str
    commitSha: str
    pricingSource: str
    sandboxAvailable: bool
    databaseConnected: bool = False
    databaseProvider: Literal["neon-postgres", "browser-local"] = "browser-local"
    fastModels: list[str]
    reasoningModels: list[str]
    baselineModel: str
    serviceTopology: dict[str, str]


class WorkspaceWorkflowsRequest(BaseModel):
    """Inbound payload for PUT /api/agent/workspace/workflows."""

    model_config = ConfigDict(extra="forbid")

    workflows: list[dict[str, Any]] = Field(default_factory=list, max_length=25)


class WorkspaceMessagesRequest(BaseModel):
    """Inbound payload for PUT /api/agent/workspace/messages."""

    model_config = ConfigDict(extra="forbid")

    messages: list[dict[str, Any]] = Field(default_factory=list, max_length=MAX_MESSAGES)


class SandboxDirectQueryRequest(BaseModel):
    """Inbound payload for POST /api/agent/sandbox/query."""

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    templateId: TemplateInputId = "channel_roas_summary"
    channel: str | None = None
    zeroConversionsOnly: bool = False
    limit: int = Field(default=20, ge=1, le=50)
    sortOrder: Literal["asc", "desc"] = "desc"

    @model_validator(mode="wrap")
    @classmethod
    def _reject_invalid_scalars(
        cls,
        value: Any,
        handler: ModelWrapValidatorHandler[Self],
    ) -> Self:
        _raise_if_non_finite_float(value, cls.__name__)
        _raise_if_lone_surrogate(value, cls.__name__)
        return handler(value)


class WorkflowRunRequest(BaseModel):
    """Inbound payload for POST /api/agent/workflows/run."""

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    workflow: dict[str, Any] | None = None
    mutations: MutationList = Field(
        default_factory=list,
        validation_alias=AliasChoices("mutations", "twinMutations"),
    )

    @model_validator(mode="wrap")
    @classmethod
    def _reject_invalid_scalars(
        cls,
        value: Any,
        handler: ModelWrapValidatorHandler[Self],
    ) -> Self:
        _raise_if_non_finite_float(value, cls.__name__)
        _raise_if_lone_surrogate(value, cls.__name__)
        return handler(value)

    @model_validator(mode="after")
    def _validate_workflow_spec(self) -> Self:
        normalize_workflow_run_config(self.workflow)
        return self


class WorkflowBacktestRequest(BaseModel):
    """Inbound payload for POST /api/agent/workflows/backtest."""

    model_config = ConfigDict(extra="forbid")

    workflow: dict[str, Any] | None = None
    days: int = Field(default=BACKTEST_MAX_DAYS, ge=BACKTEST_MIN_DAYS, le=BACKTEST_MAX_DAYS)

    @model_validator(mode="wrap")
    @classmethod
    def _reject_invalid_scalars(
        cls,
        value: Any,
        handler: ModelWrapValidatorHandler[Self],
    ) -> Self:
        _raise_if_non_finite_float(value, cls.__name__)
        _raise_if_lone_surrogate(value, cls.__name__)
        return handler(value)

    @model_validator(mode="after")
    def _validate_workflow_spec(self) -> Self:
        normalize_workflow_run_config(self.workflow)
        return self


class PortfolioOptimizeRequest(BaseModel):
    """Inbound payload for POST /api/agent/reallocation/optimize."""

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    mutations: MutationList = Field(
        default_factory=list,
        validation_alias=AliasChoices("mutations", "twinMutations"),
    )

    @model_validator(mode="wrap")
    @classmethod
    def _reject_invalid_scalars(
        cls,
        value: Any,
        handler: ModelWrapValidatorHandler[Self],
    ) -> Self:
        _raise_if_non_finite_float(value, cls.__name__)
        _raise_if_lone_surrogate(value, cls.__name__)
        return handler(value)


class ReallocationSimulateRequest(BaseModel):
    """Inbound payload for POST /api/agent/reallocation/simulate."""

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    fromCampaign: str = Field(min_length=1, max_length=120)
    toCampaign: str = Field(min_length=1, max_length=120)
    amountPerDay: float = Field(gt=0.0, allow_inf_nan=False)
    proposalId: str | None = Field(default=None, max_length=120)
    mutations: MutationList = Field(
        default_factory=list,
        validation_alias=AliasChoices("mutations", "twinMutations"),
    )

    @model_validator(mode="wrap")
    @classmethod
    def _reject_invalid_scalars(
        cls,
        value: Any,
        handler: ModelWrapValidatorHandler[Self],
    ) -> Self:
        _raise_if_non_finite_float(value, cls.__name__)
        _raise_if_lone_surrogate(value, cls.__name__)
        return handler(value)


class ChatRequest(BaseModel):
    """Inbound payload for POST /api/agent/chat."""

    model_config = ConfigDict(extra="allow")

    messages: list[dict[str, Any]] = Field(min_length=1, max_length=MAX_MESSAGES)
    twinMutations: MutationList = Field(default_factory=list)
    tierHint: TierName | None = None
    injectFailure: bool = False

    _converted: ConvertedConversation | None = PrivateAttr(default=None)

    @model_validator(mode="wrap")
    @classmethod
    def _reject_invalid_scalars(
        cls,
        value: Any,
        handler: ModelWrapValidatorHandler[Self],
    ) -> Self:
        _raise_if_non_finite_float(value, cls.__name__)
        _raise_if_lone_surrogate(value, cls.__name__)
        return handler(value)

    @model_validator(mode="after")
    def _validate_and_convert_messages(self) -> Self:
        self._converted = convert_ui_messages(self.messages)
        return self

    @property
    def converted_conversation(self) -> ConvertedConversation:
        if self._converted is None:
            self._converted = convert_ui_messages(self.messages)
        return self._converted


app = FastAPI(
    title="Relay Studio Agent Service",
    version="0.1.0",
)


@app.exception_handler(RequestValidationError)
async def handle_request_validation_error(
    request: Request,
    exc: RequestValidationError,
) -> JSONResponse:
    try:
        safe_detail = _sanitize_json_value(jsonable_encoder(exc.errors()))
    except RecursionError:
        safe_detail = [{"msg": "Input nesting depth exceeded validation limit"}]
    return JSONResponse(status_code=422, content={"detail": safe_detail})


@app.exception_handler(ValidationError)
async def handle_pydantic_validation_error(
    request: Request,
    exc: ValidationError,
) -> JSONResponse:
    try:
        safe_detail = _sanitize_json_value(jsonable_encoder(exc.errors()))
    except RecursionError:
        safe_detail = [{"msg": "Input nesting depth exceeded validation limit"}]
    return JSONResponse(status_code=422, content={"detail": safe_detail})


@app.get("/api/agent/health", response_model=HealthResponse)
async def health_endpoint() -> HealthResponse:
    fast_route = route_turn("", tier_hint="fast")
    reasoning_route = route_turn("", tier_hint="reasoning")
    db_configured = is_database_configured()
    return HealthResponse(
        status="ok",
        pythonVersion=platform.python_version(),
        vercelEnv=os.getenv("VERCEL_ENV") or "development",
        deploymentId=os.getenv("VERCEL_DEPLOYMENT_ID") or "local",
        commitSha=os.getenv("VERCEL_GIT_COMMIT_SHA") or "local",
        pricingSource=get_pricing_source(),
        sandboxAvailable=is_sandbox_available(),
        databaseConnected=db_configured,
        databaseProvider="neon-postgres" if db_configured else "browser-local",
        fastModels=[fast_route.primary_model, *fast_route.fallback_models],
        reasoningModels=[reasoning_route.primary_model, *reasoning_route.fallback_models],
        baselineModel=reasoning_route.baseline_model,
        serviceTopology={
            "frontend": "Next.js App Router",
            "rewrite": "/api/agent/*",
            "backend": "Python FastAPI + LangGraph",
        },
    )


def _extract_workspace_id(request: Request) -> str | None:
    return normalize_workspace_id(request.headers.get("x-relay-workspace"))


@app.get("/api/agent/workspace")
async def workspace_get_endpoint(request: Request) -> JSONResponse:
    workspace_id = _extract_workspace_id(request)
    if workspace_id is None:
        return JSONResponse(
            status_code=422,
            content={"detail": [{"msg": "Missing or invalid X-Relay-Workspace header."}]},
        )
    try:
        snapshot = await anyio.to_thread.run_sync(load_workspace_snapshot, workspace_id)
    except Exception:
        snapshot = {
            "workspaceId": workspace_id,
            "databaseConnected": False,
            "mutations": [],
            "workflows": [],
            "messages": [],
            "telemetryCount": 0,
        }
    return JSONResponse(content=snapshot)


@app.put("/api/agent/workspace/mutations", response_model=DerivedTwinState)
async def workspace_put_mutations_endpoint(
    request: Request,
    payload: TwinStateRequest = Body(default_factory=TwinStateRequest),
) -> DerivedTwinState:
    _raise_if_lone_surrogate(payload.model_dump(), "TwinStateRequest")
    derived = compute_twin_state(payload.mutations)
    workspace_id = _extract_workspace_id(request)
    if workspace_id is not None and is_database_configured():
        serialized = [m.model_dump(mode="json") for m in payload.mutations]
        try:
            await anyio.to_thread.run_sync(save_workspace_mutations, workspace_id, serialized)
        except Exception:
            pass
    return derived


@app.put("/api/agent/workspace/workflows")
async def workspace_put_workflows_endpoint(
    request: Request,
    payload: WorkspaceWorkflowsRequest = Body(default_factory=WorkspaceWorkflowsRequest),
) -> JSONResponse:
    workspace_id = _extract_workspace_id(request)
    if workspace_id is None:
        return JSONResponse(
            status_code=422,
            content={"detail": [{"msg": "Missing or invalid X-Relay-Workspace header."}]},
        )
    persisted = False
    if is_database_configured():
        try:
            persisted = await anyio.to_thread.run_sync(
                save_workspace_workflows, workspace_id, payload.workflows
            )
        except Exception:
            persisted = False
    return JSONResponse(content={"ok": True, "persisted": persisted})


@app.put("/api/agent/workspace/messages")
async def workspace_put_messages_endpoint(
    request: Request,
    payload: WorkspaceMessagesRequest = Body(default_factory=WorkspaceMessagesRequest),
) -> JSONResponse:
    workspace_id = _extract_workspace_id(request)
    if workspace_id is None:
        return JSONResponse(
            status_code=422,
            content={"detail": [{"msg": "Missing or invalid X-Relay-Workspace header."}]},
        )
    persisted = False
    if is_database_configured():
        try:
            persisted = await anyio.to_thread.run_sync(
                save_workspace_messages, workspace_id, payload.messages
            )
        except Exception:
            persisted = False
    return JSONResponse(content={"ok": True, "persisted": persisted})


@app.delete("/api/agent/workspace")
async def workspace_delete_endpoint(request: Request) -> JSONResponse:
    workspace_id = _extract_workspace_id(request)
    if workspace_id is None:
        return JSONResponse(
            status_code=422,
            content={"detail": [{"msg": "Missing or invalid X-Relay-Workspace header."}]},
        )
    persisted = False
    if is_database_configured():
        try:
            persisted = await anyio.to_thread.run_sync(reset_workspace_data, workspace_id)
        except Exception:
            persisted = False
    return JSONResponse(content={"ok": True, "persisted": persisted})


@app.post("/api/agent/sandbox/query", response_model=SandboxQueryResult)
async def sandbox_query_endpoint(
    payload: SandboxDirectQueryRequest = Body(default_factory=SandboxDirectQueryRequest),
) -> SandboxQueryResult | JSONResponse:
    budget_token = reset_request_sandbox_budget()
    try:
        return await run_sandbox_query(
            payload.templateId,
            {
                "channel": payload.channel,
                "zero_conversions_only": payload.zeroConversionsOnly,
                "limit": payload.limit,
                "sort_order": payload.sortOrder,
            },
        )
    except ValueError as exc:
        return JSONResponse(
            status_code=422,
            content={"detail": [{"msg": str(exc)}]},
        )
    finally:
        restore_request_sandbox_budget(budget_token)


@app.post("/api/agent/twin/state", response_model=DerivedTwinState)
async def twin_state_endpoint(
    payload: TwinStateRequest = Body(default_factory=TwinStateRequest),
) -> DerivedTwinState:
    _raise_if_lone_surrogate(payload.model_dump(), "TwinStateRequest")
    return compute_twin_state(payload.mutations)


@app.get("/api/agent/trends", response_model=ChannelTrendsResponse)
async def trends_endpoint(
    days: int = Query(default=30, ge=7, le=90),
) -> ChannelTrendsResponse:
    return await anyio.to_thread.run_sync(compute_channel_daily_trends, days)


@app.post("/api/agent/reallocation/simulate")
async def reallocation_simulate_endpoint(
    request: Request,
    payload: ReallocationSimulateRequest,
) -> JSONResponse:
    allowed, retry_after = _simulate_rate_limiter.check(extract_client_ip(request))
    if not allowed:
        return JSONResponse(
            status_code=429,
            content={
                "detail": (
                    "Rate limit exceeded for live budget simulations. "
                    "Please wait a moment before dragging again."
                )
            },
            headers={"Retry-After": str(retry_after)},
        )

    from_ref = payload.fromCampaign.strip()
    to_ref = payload.toCampaign.strip()
    try:
        preview = preview_budget_reallocation(
            payload.mutations,
            from_campaign=from_ref,
            to_campaign=to_ref,
            amount_per_day=payload.amountPerDay,
        )
    except ValueError as exc:
        return JSONResponse(
            status_code=422,
            content={"detail": [{"msg": str(exc)}]},
        )

    current_state = compute_twin_state(payload.mutations)
    series_from_db = None
    if is_database_configured():
        try:
            series_from_db = await anyio.to_thread.run_sync(
                lambda: fetch_campaign_daily_series([preview.fromCampaign, preview.toCampaign])
            )
        except Exception:
            series_from_db = None

    budget_token = reset_request_sandbox_budget()
    try:
        simulation = await run_monte_carlo_reallocation_in_sandbox(
            from_campaign=preview.fromCampaign,
            to_campaign=preview.toCampaign,
            from_daily_budget=preview.before.fromDailyBudget,
            to_daily_budget=preview.before.toDailyBudget,
            from_roas=preview.before.fromRoas,
            to_roas=preview.before.toRoas,
            amount_per_day=preview.amountPerDay,
            portfolio_daily_budget=current_state.totals.dailyBudget,
            portfolio_blended_roas=current_state.totals.blendedRoas,
            campaign_series=series_from_db,
            prefer_in_process=False,
        )
    finally:
        restore_request_sandbox_budget(budget_token)

    return JSONResponse(
        content={
            "proposalId": payload.proposalId or "prop_live_sim",
            **preview.model_dump(),
            "simulation": simulation.model_dump(),
        }
    )


@app.post("/api/agent/reallocation/optimize", response_model=None)
async def reallocation_optimize_endpoint(
    request: Request,
    payload: PortfolioOptimizeRequest = Body(default_factory=PortfolioOptimizeRequest),
) -> PortfolioOptimizeResult | JSONResponse:
    allowed, retry_after = _simulate_rate_limiter.check(extract_client_ip(request))
    if not allowed:
        return JSONResponse(
            status_code=429,
            content={
                "detail": (
                    "Rate limit exceeded for live budget simulations. "
                    "Please wait a moment before comparing plans again."
                )
            },
            headers={"Retry-After": str(retry_after)},
        )

    budget_token = reset_request_sandbox_budget()
    try:
        result = await optimize_portfolio(payload.mutations)
    except ValueError as exc:
        return JSONResponse(status_code=422, content={"detail": [{"msg": str(exc)}]})
    finally:
        restore_request_sandbox_budget(budget_token)
    return JSONResponse(content=result.model_dump(mode="json"))


@app.post("/api/agent/workflows/backtest", response_model=None)
async def workflows_backtest_endpoint(
    request: Request,
    payload: WorkflowBacktestRequest = Body(default_factory=WorkflowBacktestRequest),
) -> BacktestResult | JSONResponse:
    allowed, retry_after = _backtest_rate_limiter.check(extract_client_ip(request))
    if not allowed:
        return JSONResponse(
            status_code=429,
            content={"detail": "Rate limit exceeded for backtests. Please wait a moment."},
            headers={"Retry-After": str(retry_after)},
        )
    config = normalize_workflow_run_config(payload.workflow)
    result = await run_guardrail_backtest(config, days=payload.days)
    return JSONResponse(content=result.model_dump(mode="json"))


@app.post("/api/agent/workflows/run", response_model=None)
async def workflows_run_endpoint(
    payload: WorkflowRunRequest = Body(default_factory=WorkflowRunRequest),
) -> StreamingResponse:
    config = normalize_workflow_run_config(payload.workflow)
    derived_state = compute_twin_state(payload.mutations)
    return StreamingResponse(
        stream_workflow_dry_run(config=config, state=derived_state),
        headers=dict(WORKFLOW_STREAM_HEADERS),
    )


@app.post("/api/agent/chat", response_model=None)
async def chat_endpoint(
    request: Request,
    payload: ChatRequest,
) -> JSONResponse | StreamingResponse:
    allowed, retry_after = _chat_rate_limiter.check(extract_client_ip(request))
    if not allowed:
        return JSONResponse(
            status_code=429,
            content={
                "detail": (
                    f"Rate limit exceeded: at most {RATE_LIMIT_MAX_REQUESTS} "
                    "chat requests per minute per IP."
                )
            },
            headers={"Retry-After": str(retry_after)},
        )

    if get_gateway_credential() is None:
        return StreamingResponse(
            stream_missing_credential_sse(),
            headers=dict(UI_MESSAGE_STREAM_HEADERS),
        )

    conv = payload.converted_conversation
    twin_state = compute_twin_state(payload.twinMutations)
    custom_factory = getattr(request.app.state, "model_factory", None)
    use_semantic_router = custom_factory is None or bool(
        getattr(request.app.state, "enable_semantic_router", False)
    )
    if use_semantic_router:
        route = await route_turn_async(
            conv.latest_user_text,
            tier_hint=payload.tierHint,
            api_key=get_gateway_credential(),
            http_client=getattr(request.app.state, "semantic_router_client", None),
        )
    else:
        route = route_turn(conv.latest_user_text, tier_hint=payload.tierHint)
    timeout_override = getattr(
        request.app.state, "turn_timeout_seconds", TURN_TIMEOUT_SECONDS
    )

    graph = build_agent_graph(
        route=route,
        mutations=payload.twinMutations,
        twin_state=twin_state,
        inject_failure=payload.injectFailure,
        model_factory=custom_factory,
    )
    initial_state = {
        "messages": conv.langchain_messages,
        "model_calls": 0,
        "pending_telemetry": None,
    }

    workspace_id = _extract_workspace_id(request)
    record_db_telemetry = workspace_id is not None and is_database_configured()

    async def _guarded_chat_stream() -> AsyncIterator[str]:
        budget_token = reset_request_sandbox_budget()
        try:
            async for frame in stream_langgraph_to_sse(
                graph,
                initial_state,
                timeout_seconds=float(timeout_override),
            ):
                if record_db_telemetry and workspace_id is not None and frame.startswith("data: {"):
                    try:
                        parsed_frame = json.loads(frame[6:].strip())
                        if (
                            isinstance(parsed_frame, dict)
                            and parsed_frame.get("type") == "data-telemetry"
                            and isinstance(parsed_frame.get("data"), dict)
                        ):
                            await anyio.to_thread.run_sync(
                                record_telemetry_event,
                                workspace_id,
                                parsed_frame["data"],
                            )
                    except Exception:
                        pass
                yield frame
        finally:
            restore_request_sandbox_budget(budget_token)

    return StreamingResponse(
        _guarded_chat_stream(),
        headers=dict(UI_MESSAGE_STREAM_HEADERS),
    )
