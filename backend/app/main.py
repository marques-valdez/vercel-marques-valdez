"""FastAPI backend service for Relay Studio (/api/agent/* routes and §8 guardrails)."""

from __future__ import annotations

from collections import OrderedDict, deque
import math
import os
import platform
import re
import time
from typing import Any, AsyncIterator, Final, Literal, Mapping, Self

from fastapi import Body, FastAPI, Request
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
from app.pricing import get_pricing_source
from app.router import TierName, route_turn
from app.sandbox_runner import (
    is_sandbox_available,
    reset_request_sandbox_budget,
    restore_request_sandbox_budget,
)
from app.twin import (
    DerivedTwinState,
    MutationList,
    TwinStateRequest,
    _raise_if_non_finite_float,
    compute_twin_state,
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

    def check(self, client_ip: str, *, now: float | None = None) -> tuple[bool, int]:
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
        self._buckets.clear()


_chat_rate_limiter = SlidingWindowRateLimiter()


def reset_rate_limiter() -> None:
    """Clear all sliding-window rate-limiter buckets (used in isolated tests)."""
    _chat_rate_limiter.reset()


def extract_client_ip(request: Request) -> str:
    """Resolve client IP from first hop of X-Forwarded-For or request.client.host."""
    xff = request.headers.get("x-forwarded-for")
    if xff:
        first_hop = xff.split(",")[0].strip()[:128]
        if first_hop:
            return first_hop
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
    return HealthResponse(
        status="ok",
        pythonVersion=platform.python_version(),
        vercelEnv=os.getenv("VERCEL_ENV") or "development",
        deploymentId=os.getenv("VERCEL_DEPLOYMENT_ID") or "local",
        commitSha=os.getenv("VERCEL_GIT_COMMIT_SHA") or "local",
        pricingSource=get_pricing_source(),
        sandboxAvailable=is_sandbox_available(),
    )


@app.post("/api/agent/twin/state", response_model=DerivedTwinState)
async def twin_state_endpoint(
    payload: TwinStateRequest = Body(default_factory=TwinStateRequest),
) -> DerivedTwinState:
    _raise_if_lone_surrogate(payload.model_dump(), "TwinStateRequest")
    return compute_twin_state(payload.mutations)


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
    route = route_turn(conv.latest_user_text, tier_hint=payload.tierHint)
    custom_factory = getattr(request.app.state, "model_factory", None)
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

    async def _guarded_chat_stream() -> AsyncIterator[str]:
        budget_token = reset_request_sandbox_budget()
        try:
            async for frame in stream_langgraph_to_sse(
                graph,
                initial_state,
                timeout_seconds=float(timeout_override),
            ):
                yield frame
        finally:
            restore_request_sandbox_budget(budget_token)

    return StreamingResponse(
        _guarded_chat_stream(),
        headers=dict(UI_MESSAGE_STREAM_HEADERS),
    )
