"""Golden SSE transcript, AI Gateway client, router, pricing, tools, and UIMessage tests."""

from __future__ import annotations

import asyncio
import base64
from collections.abc import AsyncIterator, Iterator, Sequence
import json
import math
from pathlib import Path
from typing import Any

from fastapi.testclient import TestClient
import httpx
from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import (
    AIMessage,
    AIMessageChunk,
    BaseMessage,
    HumanMessage,
    ToolMessage,
)
from langchain_core.outputs import ChatGeneration, ChatGenerationChunk, ChatResult
from langchain_core.runnables import Runnable
from pydantic import ConfigDict
import pytest
from vercel import sandbox
from vercel.sandbox import CompletedCommand, NetworkPolicy

from app.agent import (
    MAX_MODEL_CALLS,
    GatewayChatOpenAI,
    build_agent_graph,
    build_model,
)
from app.main import app, reset_rate_limiter
from app.pricing import (
    PINNED_PRICING_SOURCE,
    compute_token_cost_usd,
    compute_turn_costs,
    ensure_model_prices_loaded,
    get_pricing_source,
    parse_models_catalog_payload,
    reset_pricing_cache,
)
from app.router import (
    DEFAULT_FAST_MODELS,
    DEFAULT_REASONING_MODELS,
    route_turn,
)
from app.ui_messages import convert_ui_messages
from app.ui_stream import (
    DONE_SSE,
    NO_GATEWAY_CREDENTIAL_ERROR,
    UI_MESSAGE_STREAM_HEADERS,
    stream_langgraph_to_sse,
)
from app.workflow import CANONICAL_WORKFLOW_NODES

EXPECTED_TELEMETRY_KEYS = {
    "tier",
    "routedBy",
    "primaryModel",
    "servedModel",
    "failover",
    "inputTokens",
    "cachedTokens",
    "outputTokens",
    "costUsd",
    "baselineCostUsd",
    "latencyMs",
}


class ScriptedStep:
    """Deterministic step specification for scripted streaming chat model doubles."""

    def __init__(
        self,
        *,
        text_deltas: Sequence[str] = (),
        tool_calls: Sequence[dict[str, Any]] = (),
        served_model: str | None = None,
        input_tokens: int = 120,
        cached_tokens: int = 30,
        output_tokens: int = 40,
        gateway_cost: float | None = None,
        provider_metadata: dict[str, Any] | None = None,
        raise_after_deltas: Exception | None = None,
        sleep_seconds: float = 0.0,
    ) -> None:
        self.text_deltas = tuple(text_deltas)
        self.tool_calls = tuple(tool_calls)
        self.served_model = served_model
        self.input_tokens = input_tokens
        self.cached_tokens = cached_tokens
        self.output_tokens = output_tokens
        self.gateway_cost = gateway_cost
        self.provider_metadata = provider_metadata
        self.raise_after_deltas = raise_after_deltas
        self.sleep_seconds = sleep_seconds


class _StepCursor:
    def __init__(self) -> None:
        self.index = 0
        self.invocations: list[dict[str, Any]] = []


class FakeStreamingChatModel(BaseChatModel):
    """Streaming BaseChatModel double driving real LangGraph + ui_stream execution."""

    model_config = ConfigDict(arbitrary_types_allowed=True)

    primary_model: str
    steps: list[ScriptedStep]
    cursor: _StepCursor

    @property
    def _llm_type(self) -> str:
        return "fake-streaming-gateway-chat"

    def bind_tools(
        self,
        tools: Sequence[Any],
        *,
        tool_choice: Any = None,
        **kwargs: Any,
    ) -> Runnable[Any, AIMessage]:
        self.cursor.invocations.append(
            {
                "primary": self.primary_model,
                "bound_tools": [getattr(t, "name", str(t)) for t in tools],
            }
        )
        return self

    def _next_step(self) -> ScriptedStep:
        idx = self.cursor.index
        self.cursor.index += 1
        if idx < len(self.steps):
            return self.steps[idx]
        return self.steps[-1]

    def _generate(
        self,
        messages: list[BaseMessage],
        stop: list[str] | None = None,
        run_manager: Any = None,
        **kwargs: Any,
    ) -> ChatResult:
        step = self._next_step()
        msg = AIMessage(
            content="".join(step.text_deltas),
            tool_calls=list(step.tool_calls),
            response_metadata={"model_name": step.served_model or self.primary_model},
        )
        return ChatResult(generations=[ChatGeneration(message=msg)])

    def _stream(
        self,
        messages: list[BaseMessage],
        stop: list[str] | None = None,
        run_manager: Any = None,
        **kwargs: Any,
    ) -> Iterator[ChatGenerationChunk]:
        step = self._next_step()
        for piece in step.text_deltas:
            yield ChatGenerationChunk(message=AIMessageChunk(content=piece))

    async def _astream(
        self,
        messages: list[BaseMessage],
        stop: list[str] | None = None,
        run_manager: Any = None,
        **kwargs: Any,
    ) -> AsyncIterator[ChatGenerationChunk]:
        step = self._next_step()
        if step.sleep_seconds > 0:
            await asyncio.sleep(step.sleep_seconds)

        for piece in step.text_deltas:
            yield ChatGenerationChunk(message=AIMessageChunk(content=piece))

        if step.raise_after_deltas is not None:
            raise step.raise_after_deltas

        if step.tool_calls:
            tc_chunks = [
                {
                    "name": tc["name"],
                    "args": json.dumps(tc.get("args") or {}),
                    "id": tc["id"],
                    "index": idx,
                    "type": "tool_call_chunk",
                }
                for idx, tc in enumerate(step.tool_calls)
            ]
            yield ChatGenerationChunk(
                message=AIMessageChunk(content="", tool_call_chunks=tc_chunks)
            )

        info: dict[str, Any] = {
            "model_name": step.served_model or self.primary_model,
        }
        if step.gateway_cost is not None:
            info["gateway_cost"] = step.gateway_cost
        if step.provider_metadata is not None:
            info["gateway_provider_metadata"] = step.provider_metadata

        usage_meta = {
            "input_tokens": step.input_tokens,
            "output_tokens": step.output_tokens,
            "total_tokens": step.input_tokens + step.output_tokens,
            "input_token_details": {"cache_read": step.cached_tokens},
        }
        yield ChatGenerationChunk(
            message=AIMessageChunk(
                content="",
                usage_metadata=usage_meta,  # type: ignore[arg-type]
                response_metadata=dict(info),
            ),
            generation_info=info,
        )


def _make_model_factory(
    steps: Sequence[ScriptedStep],
    recorded_factories: list[tuple[str, tuple[str, ...]]] | None = None,
):
    cursor = _StepCursor()

    def _factory(primary: str, fallbacks: Sequence[str]) -> BaseChatModel:
        if recorded_factories is not None:
            recorded_factories.append((primary, tuple(fallbacks)))
        return FakeStreamingChatModel(
            primary_model=primary,
            steps=list(steps),
            cursor=cursor,
        )

    return _factory


def _parse_sse_body(raw_text: str) -> tuple[list[dict[str, Any]], bool]:
    blocks = [blk for blk in raw_text.split("\n\n") if blk.strip()]
    frames: list[dict[str, Any]] = []
    saw_done = False
    for idx, blk in enumerate(blocks):
        assert blk.startswith("data: "), f"Unexpected SSE line {blk!r}"
        payload = blk[len("data: ") :]
        if payload == "[DONE]":
            assert idx == len(blocks) - 1, "[DONE] must be the final SSE frame"
            saw_done = True
        else:
            parsed = json.loads(payload)
            json.dumps(parsed, allow_nan=False)
            frames.append(parsed)
    return frames, saw_done


@pytest.fixture(autouse=True)
def _clean_state(monkeypatch: pytest.MonkeyPatch):
    reset_rate_limiter()
    reset_pricing_cache()
    monkeypatch.setenv("SANDBOX_DISABLED", "1")
    if hasattr(app.state, "model_factory"):
        delattr(app.state, "model_factory")
    if hasattr(app.state, "turn_timeout_seconds"):
        delattr(app.state, "turn_timeout_seconds")
    yield
    reset_rate_limiter()
    reset_pricing_cache()
    if hasattr(app.state, "model_factory"):
        delattr(app.state, "model_factory")
    if hasattr(app.state, "turn_timeout_seconds"):
        delattr(app.state, "turn_timeout_seconds")


def test_gateway_chat_openai_omits_temperature_and_preserves_gateway_metadata(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("AI_GATEWAY_API_KEY", "test-gateway-key")
    monkeypatch.delenv("GATEWAY_REPORTING_TAGS", raising=False)

    llm = build_model(
        "anthropic/claude-sonnet-5.5",
        ["google/gemini-3.1-pro-preview", "google/gemini-2.5-pro"],
    )
    assert isinstance(llm, GatewayChatOpenAI)
    assert llm.temperature is None
    assert llm.max_tokens == 1200

    payload = llm._get_request_payload([HumanMessage(content="Audit campaign hygiene")])
    assert "temperature" not in payload
    assert payload["model"] == "anthropic/claude-sonnet-5.5"
    assert payload["max_completion_tokens"] == 1200
    assert payload["extra_body"] == {
        "providerOptions": {
            "gateway": {
                "models": ["google/gemini-3.1-pro-preview", "google/gemini-2.5-pro"],
                "caching": "auto",
            }
        }
    }

    monkeypatch.setenv("GATEWAY_REPORTING_TAGS", "1")
    tagged_llm = build_model("anthropic/claude-haiku-5.5", ["google/gemini-2.5-flash"])
    tagged_payload = tagged_llm._get_request_payload([HumanMessage(content="Ping")])
    assert "temperature" not in tagged_payload
    assert tagged_payload["extra_body"]["providerOptions"]["gateway"]["tags"] == [
        "app:relay-studio-demo"
    ]

    # Verify choices==[] final usage chunk preserves served model, cost, and routing metadata.
    usage_chunk = llm._convert_chunk_to_generation_chunk(
        {
            "id": "chatcmpl_1",
            "model": "google/gemini-3.1-pro-preview",
            "choices": [],
            "usage": {
                "prompt_tokens": 200,
                "completion_tokens": 50,
                "total_tokens": 250,
                "prompt_tokens_details": {"cached_tokens": 80},
                "cost": 0.00084,
            },
            "provider_metadata": {
                "gateway": {
                    "routing": {
                        "modelAttempts": [
                            {"model": "anthropic/claude-sonnet-5.5", "success": False},
                            {"model": "google/gemini-3.1-pro-preview", "success": True},
                        ]
                    }
                }
            },
        },
        AIMessageChunk,
        {},
    )
    assert usage_chunk is not None
    assert usage_chunk.generation_info is not None
    assert usage_chunk.generation_info["model_name"] == "google/gemini-3.1-pro-preview"
    assert usage_chunk.generation_info["gateway_cost"] == 0.00084
    assert "gateway_provider_metadata" in usage_chunk.generation_info
    assert (
        usage_chunk.message.response_metadata["model_name"]
        == "google/gemini-3.1-pro-preview"
    )

    chat_res = llm._create_chat_result(
        {
            "id": "chatcmpl_2",
            "model": "anthropic/claude-sonnet-5.5",
            "choices": [
                {
                    "index": 0,
                    "message": {"role": "assistant", "content": "Ready."},
                    "finish_reason": "stop",
                }
            ],
            "usage": {"prompt_tokens": 10, "completion_tokens": 2, "cost": 0.00004},
            "providerMetadata": {"gateway": {"cost": 0.00004}},
        }
    )
    assert chat_res.generations[0].message.response_metadata["gateway_cost"] == 0.00004


def test_router_tier_hint_keyword_and_env_overrides(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("FAST_MODELS", raising=False)
    monkeypatch.delenv("REASONING_MODELS", raising=False)

    by_card_fast = route_turn("Please reallocate budget immediately", tier_hint="fast")
    assert by_card_fast.tier == "fast"
    assert by_card_fast.routed_by == "card"
    assert by_card_fast.primary_model == DEFAULT_FAST_MODELS[0]
    assert by_card_fast.fallback_models == DEFAULT_FAST_MODELS[1:]
    assert by_card_fast.baseline_model == DEFAULT_REASONING_MODELS[0]

    by_card_reasoning = route_turn("Check 404 URLs", tier_hint="reasoning")
    assert by_card_reasoning.tier == "reasoning"
    assert by_card_reasoning.routed_by == "card"
    assert by_card_reasoning.primary_model == DEFAULT_REASONING_MODELS[0]

    by_kw_fast = route_turn("Show broken 404 creatives and UTM issues across channels")
    assert by_kw_fast.tier == "fast"
    assert by_kw_fast.routed_by == "keyword"

    for prompt in (
        "How should we reallocate social ad spend?",
        "Propose a daily budget shift from LinkedIn",
        "Build a daily pacing guardrail schedule",
        "Compile a workflow plan",
    ):
        decision = route_turn(prompt)
        assert decision.tier == "reasoning"
        assert decision.routed_by == "keyword"

    monkeypatch.setenv("FAST_MODELS", "anthropic/claude-haiku-5.5, google/gemini-2.5-flash")
    monkeypatch.setenv("REASONING_MODELS", "google/gemini-2.5-pro")
    overridden = route_turn("Quick status check")
    assert overridden.primary_model == "anthropic/claude-haiku-5.5"
    assert overridden.fallback_models == ("google/gemini-2.5-flash",)
    assert overridden.baseline_model == "google/gemini-2.5-pro"


async def test_pricing_pinned_and_live_catalog_and_baseline_math(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    assert get_pricing_source() == PINNED_PRICING_SOURCE

    fast_cost, baseline_cost = compute_turn_costs(
        served_model="google/gemini-3.1-flash-lite",
        tier="fast",
        input_tokens=1000,
        cached_tokens=200,
        output_tokens=100,
    )
    assert fast_cost < baseline_cost
    assert fast_cost == compute_token_cost_usd(
        "google/gemini-3.1-flash-lite",
        input_tokens=1000,
        cached_tokens=200,
        output_tokens=100,
    )

    reported_cost, reported_baseline = compute_turn_costs(
        served_model="anthropic/claude-sonnet-5.5",
        tier="reasoning",
        input_tokens=500,
        cached_tokens=0,
        output_tokens=100,
        gateway_reported_cost="0.00195",
    )
    assert reported_cost == 0.00195
    assert reported_baseline == 0.00195

    parsed = parse_models_catalog_payload(
        {
            "data": [
                {
                    "id": "google/gemini-3.1-flash-lite",
                    "pricing": {
                        "input": "0.0000002",
                        "output": "0.0000012",
                        "input_cache_read": "0.00000002",
                    },
                }
            ]
        }
    )
    assert "google/gemini-3.1-flash-lite" in parsed

    class _FakeAsyncClient:
        def __init__(self, *args: Any, **kwargs: Any) -> None:
            pass

        async def __aenter__(self) -> _FakeAsyncClient:
            return self

        async def __aexit__(self, *args: Any) -> bool:
            return False

        async def get(self, url: str) -> httpx.Response:
            return httpx.Response(
                200,
                json={
                    "data": [
                        {
                            "id": "google/gemini-3.1-flash-lite",
                            "pricing": {"input": "0.0000002", "output": "0.0000012"},
                        }
                    ]
                },
            )

    monkeypatch.delenv("PRICING_OFFLINE", raising=False)
    monkeypatch.setattr(httpx, "AsyncClient", _FakeAsyncClient)
    source = await ensure_model_prices_loaded()
    assert source == "live"
    assert get_pricing_source() == "live"


@pytest.mark.parametrize("env_value", [None, "", "   "])
def test_golden_sse_missing_gateway_credentials(
    env_value: str | None,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    if env_value is None:
        monkeypatch.delenv("AI_GATEWAY_API_KEY", raising=False)
        monkeypatch.delenv("VERCEL_OIDC_TOKEN", raising=False)
    else:
        monkeypatch.setenv("AI_GATEWAY_API_KEY", env_value)
        monkeypatch.setenv("VERCEL_OIDC_TOKEN", env_value)

    client = TestClient(app)
    for body in (
        {
            "id": "chat_ui_1",
            "trigger": "submit-message",
            "messages": [
                {
                    "id": "m1",
                    "role": "user",
                    "parts": [{"type": "text", "text": "Audit campaign hygiene"}],
                }
            ],
        },
        {"messages": [{"role": "user", "content": "Audit campaign hygiene"}]},
    ):
        reset_rate_limiter()
        resp = client.post("/api/agent/chat", json=body)
        assert resp.status_code == 200
        for hdr_key, hdr_val in UI_MESSAGE_STREAM_HEADERS.items():
            assert resp.headers.get(hdr_key) == hdr_val
        assert resp.headers.get("x-vercel-ai-ui-message-stream") == "v1"

        frames, saw_done = _parse_sse_body(resp.text)
        assert saw_done is True
        assert [f["type"] for f in frames] == ["start", "error", "finish"]
        assert frames[0]["messageId"].startswith("msg_")
        assert frames[1]["errorText"] == NO_GATEWAY_CREDENTIAL_ERROR


def test_golden_sse_text_only_turn(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("AI_GATEWAY_API_KEY", "test-gateway-key")
    app.state.model_factory = _make_model_factory(
        [
            ScriptedStep(
                text_deltas=("Campaign ", "health ", "looks solid."),
                input_tokens=240,
                cached_tokens=60,
                output_tokens=18,
            )
        ]
    )

    client = TestClient(app)
    resp = client.post(
        "/api/agent/chat",
        json={
            "messages": [
                {
                    "id": "u1",
                    "role": "user",
                    "parts": [{"type": "text", "text": "Summarize current status"}],
                }
            ],
            "tierHint": "fast",
        },
    )
    assert resp.status_code == 200
    for hdr_key, hdr_val in UI_MESSAGE_STREAM_HEADERS.items():
        assert resp.headers.get(hdr_key) == hdr_val
    assert resp.headers.get("x-vercel-ai-ui-message-stream") == "v1"

    frames, saw_done = _parse_sse_body(resp.text)
    assert saw_done is True
    assert [f["type"] for f in frames] == [
        "start",
        "start-step",
        "text-start",
        "text-delta",
        "text-delta",
        "text-delta",
        "text-end",
        "data-telemetry",
        "finish-step",
        "finish",
    ]
    assert frames[0]["messageId"].startswith("msg_")
    txt_id = frames[2]["id"]
    assert txt_id.startswith("txt_")
    assert all(f["id"] == txt_id for f in frames[2:7])
    assert "".join(f["delta"] for f in frames[3:6]) == "Campaign health looks solid."

    telemetry = frames[7]["data"]
    assert set(telemetry.keys()) == EXPECTED_TELEMETRY_KEYS
    assert telemetry["tier"] == "fast"
    assert telemetry["routedBy"] == "card"
    assert telemetry["primaryModel"] == DEFAULT_FAST_MODELS[0]
    assert telemetry["servedModel"] == DEFAULT_FAST_MODELS[0]
    assert telemetry["failover"] == "none"
    assert telemetry["inputTokens"] == 240
    assert telemetry["cachedTokens"] == 60
    assert telemetry["outputTokens"] == 18
    assert telemetry["costUsd"] < telemetry["baselineCostUsd"]
    assert telemetry["latencyMs"] >= 1
    assert all(
        math.isfinite(telemetry[k])
        for k in ("costUsd", "baselineCostUsd", "latencyMs")
    )


def test_golden_sse_single_tool_turn_zero_pre_text(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("AI_GATEWAY_API_KEY", "test-gateway-key")
    app.state.model_factory = _make_model_factory(
        [
            ScriptedStep(
                text_deltas=(),
                tool_calls=[
                    {
                        "id": "call_hygiene_01",
                        "name": "audit_campaign_hygiene",
                        "args": {},
                    }
                ],
            ),
            ScriptedStep(
                text_deltas=("Flagged 14 broken creatives and 9 UTM issues.",),
            ),
        ]
    )

    client = TestClient(app)
    resp = client.post(
        "/api/agent/chat",
        json={
            "messages": [{"role": "user", "content": "Audit campaign hygiene"}],
            "tierHint": "fast",
        },
    )
    assert resp.status_code == 200
    frames, saw_done = _parse_sse_body(resp.text)
    assert saw_done is True
    assert [f["type"] for f in frames] == [
        "start",
        "start-step",
        "tool-input-available",
        "tool-output-available",
        "data-telemetry",
        "finish-step",
        "start-step",
        "text-start",
        "text-delta",
        "text-end",
        "data-telemetry",
        "finish-step",
        "finish",
    ]
    assert frames[2]["toolCallId"] == "call_hygiene_01"
    assert frames[2]["toolName"] == "audit_campaign_hygiene"
    assert frames[3]["toolCallId"] == "call_hygiene_01"
    output = frames[3]["output"]
    assert output["brokenCount"] == 14
    assert output["utmCount"] == 9
    assert output["totalSpendAtRiskPerDay"] == 1567.4
    assert len(output["channels"]) == 3
    assert len(output["flaggedItems"]) == 23


@pytest.mark.parametrize(
    ("tool_name", "tool_args", "tier_hint"),
    [
        ("audit_campaign_hygiene", {"channel": "linkedin_ads"}, "fast"),
        (
            "analyze_in_sandbox",
            {"template_id": "channel_summary", "channel": "all"},
            "fast",
        ),
        ("propose_budget_reallocation", {}, "reasoning"),
        (
            "compile_workflow",
            {
                "template": "daily-pacing-guardrail",
                "channels": ["google_ads", "linkedin_ads"],
                "threshold": 20,
            },
            "reasoning",
        ),
    ],
)
def test_golden_sse_single_tool_turn_with_pre_text_and_all_four_tools(
    tool_name: str,
    tool_args: dict[str, Any],
    tier_hint: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("AI_GATEWAY_API_KEY", "test-gateway-key")
    call_id = f"call_{tool_name}_01"
    app.state.model_factory = _make_model_factory(
        [
            ScriptedStep(
                text_deltas=("Running check...",),
                tool_calls=[{"id": call_id, "name": tool_name, "args": tool_args}],
            ),
            ScriptedStep(text_deltas=("Completed operational check.",)),
        ]
    )

    client = TestClient(app)
    resp = client.post(
        "/api/agent/chat",
        json={
            "messages": [{"role": "user", "content": f"Execute {tool_name}"}],
            "tierHint": tier_hint,
        },
    )
    assert resp.status_code == 200
    frames, saw_done = _parse_sse_body(resp.text)
    assert saw_done is True
    assert [f["type"] for f in frames] == [
        "start",
        "start-step",
        "text-start",
        "text-delta",
        "text-end",
        "tool-input-available",
        "tool-output-available",
        "data-telemetry",
        "finish-step",
        "start-step",
        "text-start",
        "text-delta",
        "text-end",
        "data-telemetry",
        "finish-step",
        "finish",
    ]
    out = frames[6]["output"]
    if tool_name == "audit_campaign_hygiene":
        assert out["brokenCount"] == 6
        assert out["utmCount"] == 3
        assert len(out["channels"]) == 1
    elif tool_name == "analyze_in_sandbox":
        assert out["templateId"] == "channel_roas_summary"
        assert out["mode"] == "in-process"
        assert out["rowsScanned"] == 10400
        assert out["rowsReturned"] == 3
        assert out["estTokensAvoided"] > 100_000
    elif tool_name == "propose_budget_reallocation":
        assert out["proposalId"].startswith("prop_")
        assert out["fromCampaign"] == "cmp_linkedin_01"
        assert out["toCampaign"] == "cmp_google_01"
        assert out["amountPerDay"] == 700.0
        assert out["blendedRoasAfter"] > out["blendedRoasBefore"]
        assert out["formula"] == "Σ(budget_i × roas_i) / Σ(budget_i)"
    elif tool_name == "compile_workflow":
        assert out["workflowId"].startswith("wf_")
        assert out["template"] == "daily-pacing-guardrail"
        assert [s["index"] for s in out["steps"]] == [0, 1, 2, 3, 4, 5]
        assert [s["node"] for s in out["steps"]] == [
            n for n, _ in CANONICAL_WORKFLOW_NODES
        ]
        assert "RelayCampaignGuardrailWorkflow" in out["temporalCode"]
        padded = out["slug"] + "=" * (-len(out["slug"]) % 4)
        decoded_slug = json.loads(base64.urlsafe_b64decode(padded).decode("utf-8"))
        assert decoded_slug == {
            "template": "daily-pacing-guardrail",
            "channels": ["google_ads", "linkedin_ads"],
            "threshold": 20,
        }


def test_propose_budget_reallocation_preserves_sandbox_slot_for_analyze_in_sandbox(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    created_boxes: list[int] = []

    class _Box:
        def __init__(self) -> None:
            self._files: dict[str, str] = {}

            class _Fs:
                def __init__(self, store: dict[str, str]) -> None:
                    self._store = store

                async def write_text(self, path: str, content: str) -> None:
                    self._store[path] = content

            self.fs = _Fs(self._files)

        async def __aenter__(self) -> _Box:
            created_boxes.append(1)
            return self

        async def __aexit__(self, *args: Any) -> bool:
            return False

        async def run_command(self, *args: Any, **kwargs: Any) -> CompletedCommand:
            payload = json.dumps(
                {
                    "rowsScanned": 10400,
                    "rowsReturned": 3,
                    "table": [{"channel": "Google Ads", "roas": 4.49}],
                }
            ).encode("utf-8")
            return CompletedCommand(
                id="cmd_1",
                name="python",
                args=("job.py",),
                cwd="/vercel/sandbox",
                session_id="sess_1",
                started_at=1,
                returncode=0,
                stdout=payload,
                stderr=b"",
            )

    def _fake_create(*, network_policy: NetworkPolicy | None = None, **kw: Any) -> _Box:
        assert network_policy == NetworkPolicy.deny_all()
        return _Box()

    monkeypatch.setattr(sandbox, "create_sandbox", _fake_create)
    monkeypatch.setenv("SANDBOX_DISABLED", "0")
    monkeypatch.setenv("AI_GATEWAY_API_KEY", "test-gateway-key")

    app.state.model_factory = _make_model_factory(
        [
            ScriptedStep(
                tool_calls=[
                    {
                        "id": "call_prop_1",
                        "name": "propose_budget_reallocation",
                        "args": {},
                    },
                    {
                        "id": "call_sbx_1",
                        "name": "analyze_in_sandbox",
                        "args": {"template_id": "channel_roas_summary"},
                    },
                ]
            ),
            ScriptedStep(text_deltas=("Done.",)),
        ]
    )

    client = TestClient(app)
    resp = client.post(
        "/api/agent/chat",
        json={"messages": [{"role": "user", "content": "Reallocate and analyze"}]},
    )
    assert resp.status_code == 200
    frames, saw_done = _parse_sse_body(resp.text)
    assert saw_done is True
    tool_outputs = [f for f in frames if f["type"] == "tool-output-available"]
    assert len(tool_outputs) == 2
    assert tool_outputs[1]["output"]["mode"] == "sandbox"
    assert len(created_boxes) == 1


def test_golden_sse_tool_execution_error_part(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("AI_GATEWAY_API_KEY", "test-gateway-key")
    app.state.model_factory = _make_model_factory(
        [
            ScriptedStep(
                tool_calls=[
                    {
                        "id": "call_bad_ch",
                        "name": "audit_campaign_hygiene",
                        "args": {"channel": "invalid_network"},
                    }
                ]
            ),
            ScriptedStep(text_deltas=("Handled unsupported channel filter.",)),
        ]
    )

    client = TestClient(app)
    resp = client.post(
        "/api/agent/chat",
        json={"messages": [{"role": "user", "content": "Check invalid network"}]},
    )
    assert resp.status_code == 200
    frames, saw_done = _parse_sse_body(resp.text)
    assert saw_done is True
    assert "tool-output-error" in [f["type"] for f in frames]
    err_frame = next(f for f in frames if f["type"] == "tool-output-error")
    assert err_frame["toolCallId"] == "call_bad_ch"
    assert "invalid_network" in err_frame["errorText"]


def test_golden_sse_mid_stream_model_exception_closes_cleanly_and_redacts(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("AI_GATEWAY_API_KEY", "test-gateway-key")
    app.state.model_factory = _make_model_factory(
        [
            ScriptedStep(
                text_deltas=("Partial reply ",),
                raise_after_deltas=RuntimeError(
                    "Gateway failure at /var/tmp/relay-internal/config.json with sk-shortkey12"
                ),
            )
        ]
    )

    client = TestClient(app)
    resp = client.post(
        "/api/agent/chat",
        json={"messages": [{"role": "user", "content": "Trigger stream failure"}]},
    )
    assert resp.status_code == 200
    frames, saw_done = _parse_sse_body(resp.text)
    assert saw_done is True
    assert [f["type"] for f in frames] == [
        "start",
        "start-step",
        "text-start",
        "text-delta",
        "text-end",
        "finish-step",
        "error",
        "finish",
    ]
    err_text = frames[6]["errorText"]
    assert "/var/tmp/relay-internal" not in err_text
    assert "sk-shortkey12" not in err_text
    assert "<redacted-path>" in err_text
    assert "<redacted-credential>" in err_text


def test_golden_sse_turn_timeout_emits_error_part(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("AI_GATEWAY_API_KEY", "test-gateway-key")
    app.state.turn_timeout_seconds = 0.05
    app.state.model_factory = _make_model_factory(
        [ScriptedStep(text_deltas=("Slow...",), sleep_seconds=0.4)]
    )

    client = TestClient(app)
    resp = client.post(
        "/api/agent/chat",
        json={"messages": [{"role": "user", "content": "Slow turn"}]},
    )
    assert resp.status_code == 200
    frames, saw_done = _parse_sse_body(resp.text)
    assert saw_done is True
    assert [f["type"] for f in frames] == [
        "start",
        "start-step",
        "finish-step",
        "error",
        "finish",
    ]
    assert "time limit" in frames[3]["errorText"]


async def test_client_disconnect_cancelled_error_propagates_cleanly() -> None:
    class _CancellingGraph:
        async def astream(self, *args: Any, **kwargs: Any) -> AsyncIterator[dict[str, Any]]:
            yield {"kind": "step_start"}
            raise asyncio.CancelledError()

    gen = stream_langgraph_to_sse(_CancellingGraph(), {"messages": []})
    first = await anext(gen)
    assert '"type":"start"' in first
    second = await anext(gen)
    assert '"type":"start-step"' in second
    with pytest.raises(asyncio.CancelledError):
        await anext(gen)


def test_inject_failure_simulated_and_gateway_failover_telemetry(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("AI_GATEWAY_API_KEY", "test-gateway-key")

    # 1. injectFailure=True -> synthetic primary 503 + app-level retry on fallbacks[0] ("simulated")
    recorded_calls: list[tuple[str, tuple[str, ...]]] = []
    app.state.model_factory = _make_model_factory(
        [ScriptedStep(text_deltas=("Served by fallback.",))],
        recorded_factories=recorded_calls,
    )
    client = TestClient(app)
    sim_resp = client.post(
        "/api/agent/chat",
        json={
            "messages": [{"role": "user", "content": "Check status"}],
            "tierHint": "fast",
            "injectFailure": True,
        },
    )
    sim_frames, _ = _parse_sse_body(sim_resp.text)
    sim_tel = next(f["data"] for f in sim_frames if f["type"] == "data-telemetry")
    assert recorded_calls == [(DEFAULT_FAST_MODELS[1], DEFAULT_FAST_MODELS[2:])]
    assert sim_tel["primaryModel"] == DEFAULT_FAST_MODELS[0]
    assert sim_tel["servedModel"] == DEFAULT_FAST_MODELS[1]
    assert sim_tel["failover"] == "simulated"

    # 2. injectFailure=False, gateway itself serves fallback ("gateway")
    app.state.model_factory = _make_model_factory(
        [
            ScriptedStep(
                text_deltas=("Gateway switched provider.",),
                served_model=DEFAULT_FAST_MODELS[1],
            )
        ]
    )
    gw_resp = client.post(
        "/api/agent/chat",
        json={
            "messages": [{"role": "user", "content": "Check status"}],
            "tierHint": "fast",
            "injectFailure": False,
        },
    )
    gw_frames, _ = _parse_sse_body(gw_resp.text)
    gw_tel = next(f["data"] for f in gw_frames if f["type"] == "data-telemetry")
    assert gw_tel["primaryModel"] == DEFAULT_FAST_MODELS[0]
    assert gw_tel["servedModel"] == DEFAULT_FAST_MODELS[1]
    assert gw_tel["failover"] == "gateway"


def test_ui_messages_converts_parts_multi_step_tools_and_ignores_other_states() -> None:
    raw_history = [
        {
            "id": "u_1",
            "role": "user",
            "parts": [{"type": "text", "text": "Run hygiene and sandbox checks"}],
        },
        {
            "id": "a_1",
            "role": "assistant",
            "parts": [
                {"type": "step-start"},
                {"type": "reasoning", "text": "Internal thought"},
                {
                    "type": "tool-audit_campaign_hygiene",
                    "toolCallId": "call_1",
                    "state": "output-available",
                    "input": {"channel": "all"},
                    "output": {"brokenCount": 14, "utmCount": 9},
                },
                {
                    "type": "dynamic-tool",
                    "toolName": "analyze_in_sandbox",
                    "toolCallId": "call_2",
                    "state": "output-available",
                    "input": {"template_id": "channel_roas_summary"},
                    "output": {"rowsScanned": 10400},
                },
                {
                    "type": "tool-propose_budget_reallocation",
                    "toolCallId": "call_ignored_streaming",
                    "state": "input-streaming",
                    "input": {},
                },
                {
                    "type": "tool-compile_workflow",
                    "toolCallId": "call_ignored_err",
                    "state": "output-error",
                    "errorText": "failed",
                },
                {"type": "data-telemetry", "data": {"tier": "fast"}},
                {"type": "step-start"},
                {"type": "text", "text": "Both checks finished."},
            ],
        },
        {
            "id": "u_2",
            "role": "user",
            "parts": [{"type": "text", "text": "Approved proposal prop_1234567890."}],
        },
    ]

    conv = convert_ui_messages(raw_history)
    assert conv.latest_user_text == "Approved proposal prop_1234567890."
    msgs = conv.langchain_messages
    assert len(msgs) == 6
    assert isinstance(msgs[0], HumanMessage)
    assert isinstance(msgs[1], AIMessage)
    assert [tc["id"] for tc in msgs[1].tool_calls] == ["call_1", "call_2"]
    assert isinstance(msgs[2], ToolMessage) and msgs[2].tool_call_id == "call_1"
    assert isinstance(msgs[3], ToolMessage) and msgs[3].tool_call_id == "call_2"
    assert isinstance(msgs[4], AIMessage) and msgs[4].content == "Both checks finished."
    assert isinstance(msgs[5], HumanMessage) and msgs[5].content == "Approved proposal prop_1234567890."


def test_max_six_model_calls_cap_per_turn(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("AI_GATEWAY_API_KEY", "test-gateway-key")
    endless_steps = [
        ScriptedStep(
            tool_calls=[
                {
                    "id": f"call_loop_{idx}",
                    "name": "audit_campaign_hygiene",
                    "args": {},
                }
            ]
        )
        for idx in range(10)
    ]
    app.state.model_factory = _make_model_factory(endless_steps)

    client = TestClient(app)
    resp = client.post(
        "/api/agent/chat",
        json={"messages": [{"role": "user", "content": "Loop tools"}]},
    )
    assert resp.status_code == 200
    frames, saw_done = _parse_sse_body(resp.text)
    assert saw_done is True
    telemetry_frames = [f for f in frames if f["type"] == "data-telemetry"]
    assert len(telemetry_frames) == MAX_MODEL_CALLS == 6
    err_frames = [f for f in frames if f["type"] == "error"]
    assert len(err_frames) == 1
    assert "maximum of 6 model calls" in err_frames[0]["errorText"]
    assert frames[-1] == {"type": "finish"}


def test_ui_stream_source_is_concise_and_stakeholder_readable() -> None:
    ui_stream_path = Path(__file__).resolve().parents[1] / "app" / "ui_stream.py"
    source = ui_stream_path.read_text(encoding="utf-8")
    lines = source.splitlines()
    assert 100 <= len(lines) <= 250
    assert "x-vercel-ai-ui-message-stream" in source
    assert DONE_SSE == "data: [DONE]\n\n"
    route = route_turn("Audit hygiene", tier_hint="fast")
    graph = build_agent_graph(
        route=route,
        model_factory=_make_model_factory([ScriptedStep(text_deltas=("ok",))]),
    )
    assert graph is not None


def test_chat_tools_respect_prior_visitor_twin_mutations_without_mutating_base(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("AI_GATEWAY_API_KEY", "test-gateway-key")
    app.state.model_factory = _make_model_factory(
        [
            ScriptedStep(
                tool_calls=[
                    {"id": "call_mut_hyg", "name": "audit_campaign_hygiene", "args": {}},
                    {
                        "id": "call_mut_prop",
                        "name": "propose_budget_reallocation",
                        "args": {},
                    },
                ]
            ),
            ScriptedStep(text_deltas=("Replayed visitor state accurately.",)),
        ]
    )

    client = TestClient(app)
    resp = client.post(
        "/api/agent/chat",
        json={
            "messages": [{"role": "user", "content": "Review updated budgets"}],
            "twinMutations": [
                {"type": "pause_broken_creatives"},
                {
                    "type": "reallocate_budget",
                    "from_campaign": "cmp_linkedin_01",
                    "to_campaign": "cmp_google_01",
                    "amount_per_day": 700.0,
                },
            ],
        },
    )
    assert resp.status_code == 200
    frames, saw_done = _parse_sse_body(resp.text)
    assert saw_done is True
    outputs = [f["output"] for f in frames if f["type"] == "tool-output-available"]
    assert outputs[0]["brokenCount"] == 0
    assert outputs[0]["utmCount"] == 9
    assert outputs[1]["fromCampaign"] == "cmp_linkedin_01"
    assert outputs[1]["before"]["fromDailyBudget"] == 700.0
    assert outputs[1]["amountPerDay"] == 350.0


def test_inject_failure_with_no_fallback_models_emits_clean_error_frame(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("AI_GATEWAY_API_KEY", "test-gateway-key")
    monkeypatch.setenv("FAST_MODELS", "google/gemini-3.1-flash-lite")
    app.state.model_factory = _make_model_factory([ScriptedStep(text_deltas=("unused",))])

    client = TestClient(app)
    resp = client.post(
        "/api/agent/chat",
        json={
            "messages": [{"role": "user", "content": "Check status"}],
            "tierHint": "fast",
            "injectFailure": True,
        },
    )
    assert resp.status_code == 200
    frames, saw_done = _parse_sse_body(resp.text)
    assert saw_done is True
    assert [f["type"] for f in frames] == [
        "start",
        "start-step",
        "finish-step",
        "error",
        "finish",
    ]
    assert "Simulated 503 outage" in frames[3]["errorText"]


async def test_concurrent_chat_requests_enforce_single_sandbox_across_parallel_and_sequential_steps(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    created_boxes: list[Any] = []

    class _AsyncDelayedBox:
        def __init__(self) -> None:
            self.closed = False
            self._files: dict[str, str] = {}

            class _Fs:
                def __init__(self, store: dict[str, str]) -> None:
                    self._store = store

                async def write_text(self, path: str, content: str) -> None:
                    self._store[path] = content

            self.fs = _Fs(self._files)

        async def __aenter__(self) -> _AsyncDelayedBox:
            created_boxes.append(self)
            await asyncio.sleep(0.02)
            return self

        async def __aexit__(self, *args: Any) -> bool:
            self.closed = True
            return False

        async def run_command(self, *args: Any, **kwargs: Any) -> CompletedCommand:
            await asyncio.sleep(0.02)
            payload = json.dumps(
                {
                    "rowsScanned": 10400,
                    "rowsReturned": 3,
                    "table": [{"channel": "Google Ads", "roas": 4.49}],
                }
            ).encode("utf-8")
            return CompletedCommand(
                id="cmd_conc_1",
                name="python",
                args=("job.py",),
                cwd="/vercel/sandbox",
                session_id="sess_conc_1",
                started_at=1,
                returncode=0,
                stdout=payload,
                stderr=b"",
            )

    def _fake_create_sandbox(
        *,
        network_policy: NetworkPolicy | None = None,
        **kwargs: Any,
    ) -> _AsyncDelayedBox:
        assert network_policy == NetworkPolicy.deny_all()
        return _AsyncDelayedBox()

    class _StatelessMultiStepModel(BaseChatModel):
        model_config = ConfigDict(arbitrary_types_allowed=True)
        primary_model: str

        @property
        def _llm_type(self) -> str:
            return "stateless-multi-step-chat"

        def bind_tools(self, tools: Sequence[Any], **kwargs: Any) -> Runnable[Any, AIMessage]:
            return self

        def _generate(self, messages: list[BaseMessage], **kwargs: Any) -> ChatResult:
            return ChatResult(generations=[ChatGeneration(message=AIMessage(content="ok"))])

        async def _astream(
            self,
            messages: list[BaseMessage],
            **kwargs: Any,
        ) -> AsyncIterator[ChatGenerationChunk]:
            tool_msg_count = sum(1 for m in messages if isinstance(m, ToolMessage))
            if tool_msg_count == 0:
                calls = [
                    {
                        "name": "analyze_in_sandbox",
                        "args": json.dumps({"template_id": "channel_roas_summary"}),
                        "id": "call_step1_a",
                        "index": 0,
                        "type": "tool_call_chunk",
                    },
                    {
                        "name": "analyze_in_sandbox",
                        "args": json.dumps({"template_id": "campaign_roas_ranking"}),
                        "id": "call_step1_b",
                        "index": 1,
                        "type": "tool_call_chunk",
                    },
                ]
                yield ChatGenerationChunk(
                    message=AIMessageChunk(content="", tool_call_chunks=calls)
                )
            elif tool_msg_count == 2:
                calls = [
                    {
                        "name": "analyze_in_sandbox",
                        "args": json.dumps({"template_id": "daily_pacing_anomalies"}),
                        "id": "call_step2_a",
                        "index": 0,
                        "type": "tool_call_chunk",
                    }
                ]
                yield ChatGenerationChunk(
                    message=AIMessageChunk(content="", tool_call_chunks=calls)
                )
            else:
                yield ChatGenerationChunk(
                    message=AIMessageChunk(content="Completed 3 analytics queries.")
                )

            info = {"model_name": self.primary_model}
            usage = {
                "input_tokens": 100,
                "output_tokens": 25,
                "total_tokens": 125,
                "input_token_details": {"cache_read": 0},
            }
            yield ChatGenerationChunk(
                message=AIMessageChunk(
                    content="",
                    usage_metadata=usage,  # type: ignore[arg-type]
                    response_metadata=dict(info),
                ),
                generation_info=info,
            )

    monkeypatch.setattr(sandbox, "create_sandbox", _fake_create_sandbox)
    monkeypatch.setenv("SANDBOX_DISABLED", "0")
    monkeypatch.setenv("AI_GATEWAY_API_KEY", "test-gateway-key")
    app.state.model_factory = lambda primary, fallbacks: _StatelessMultiStepModel(
        primary_model=primary
    )

    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        responses = await asyncio.gather(
            *[
                client.post(
                    "/api/agent/chat",
                    headers={"X-Forwarded-For": f"198.51.100.{idx + 1}"},
                    json={
                        "messages": [
                            {
                                "role": "user",
                                "content": f"Compare ROAS and pacing ({idx})",
                            }
                        ],
                        "tierHint": "fast",
                    },
                )
                for idx in range(10)
            ]
        )

    assert len(created_boxes) == 10
    assert all(box.closed for box in created_boxes)
    for resp in responses:
        assert resp.status_code == 200
        frames, saw_done = _parse_sse_body(resp.text)
        assert saw_done is True
        modes = [
            f["output"]["mode"]
            for f in frames
            if f["type"] == "tool-output-available"
        ]
        assert modes == ["sandbox", "in-process", "in-process"]


async def test_tools_reject_boolean_values_for_numeric_parameters(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from pydantic import ValidationError

    from app.tools import build_agent_tools

    tool_map = {t.name: t for t in build_agent_tools()}

    for tool_name, bad_args in (
        ("analyze_in_sandbox", {"days": True}),
        ("analyze_in_sandbox", {"days": False}),
        ("analyze_in_sandbox", {"limit": True}),
        ("analyze_in_sandbox", {"limit": False}),
        ("propose_budget_reallocation", {"amount_per_day": True}),
        ("propose_budget_reallocation", {"amount_per_day": False}),
        ("compile_workflow", {"threshold": True}),
        ("compile_workflow", {"threshold": False}),
    ):
        with pytest.raises(
            ValidationError, match="Boolean value is not valid for numeric parameter"
        ):
            await tool_map[tool_name].ainvoke(bad_args)

    # Confirm genuine boolean parameter zero_conversions_only still works cleanly.
    valid_bool_res = await tool_map["analyze_in_sandbox"].ainvoke(
        {"template_id": "ad_group_efficiency", "zero_conversions_only": True, "limit": 5}
    )
    assert valid_bool_res["rowsReturned"] == 5

    # Verify end-to-end SSE turn converts boolean numeric tool args into tool-output-error parts.
    monkeypatch.setenv("AI_GATEWAY_API_KEY", "test-gateway-key")
    app.state.model_factory = _make_model_factory(
        [
            ScriptedStep(
                tool_calls=[
                    {
                        "id": "call_bool_days",
                        "name": "analyze_in_sandbox",
                        "args": {"days": True},
                    },
                    {
                        "id": "call_bool_limit",
                        "name": "analyze_in_sandbox",
                        "args": {"limit": True},
                    },
                    {
                        "id": "call_bool_amt",
                        "name": "propose_budget_reallocation",
                        "args": {"amount_per_day": True},
                    },
                    {
                        "id": "call_bool_thr",
                        "name": "compile_workflow",
                        "args": {"threshold": True},
                    },
                ]
            ),
            ScriptedStep(text_deltas=("Rejected invalid boolean parameters.",)),
        ]
    )

    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        resp = await client.post(
            "/api/agent/chat",
            json={"messages": [{"role": "user", "content": "Test malformed bool args"}]},
        )

    assert resp.status_code == 200
    frames, saw_done = _parse_sse_body(resp.text)
    assert saw_done is True
    assert [f for f in frames if f["type"] == "tool-output-available"] == []
    err_frames = [f for f in frames if f["type"] == "tool-output-error"]
    assert [f["toolCallId"] for f in err_frames] == [
        "call_bool_days",
        "call_bool_limit",
        "call_bool_amt",
        "call_bool_thr",
    ]
    assert all(
        "Boolean value is not valid for numeric parameter" in f["errorText"]
        for f in err_frames
    )


