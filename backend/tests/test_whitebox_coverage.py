"""Adversarial white-box coverage and boundary test suite for Relay Studio backend."""

from __future__ import annotations

import ast
import asyncio
import contextvars
import csv
import importlib.util
import io
import json
import math
from pathlib import Path
import subprocess
import sys
from typing import Any, AsyncIterator

from fastapi import Request
from fastapi.exceptions import RequestValidationError
from fastapi.testclient import TestClient
import httpx
from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import (
    AIMessage,
    AIMessageChunk,
    BaseMessage,
    HumanMessage,
    SystemMessage,
    ToolMessage,
)
from langchain_core.outputs import ChatGeneration, ChatResult
from langchain_core.runnables import Runnable
from pydantic import BaseModel, ConfigDict, ValidationError
import pytest
from vercel import sandbox

from app.agent import (
    MAX_MODEL_CALLS,
    GatewayChatOpenAI,
    _extract_chunk_text,
    _gateway_attempted_failover,
    build_agent_graph,
    build_model,
    resolve_gateway_api_key,
)
from app.main import (
    ChatRequest,
    RATE_LIMIT_MAX_TRACKED_IPS,
    SlidingWindowRateLimiter,
    _sanitize_json_value,
    app,
    extract_client_ip,
    handle_pydantic_validation_error,
    handle_request_validation_error,
    reset_rate_limiter,
)
from app.pricing import (
    PINNED_PRICING_SOURCE,
    compute_token_cost_usd,
    compute_turn_costs,
    ensure_model_prices_loaded,
    get_model_price,
    get_pricing_source,
    parse_models_catalog_payload,
    reset_pricing_cache,
)
from app.router import (
    DEFAULT_FAST_MODELS,
    DEFAULT_REASONING_MODELS,
    route_turn,
    select_route,
)
from app.sandbox_runner import (
    _normalize_cell,
    _request_sandbox_budget,
    build_job_script,
    compute_estimated_tokens_avoided,
    get_request_sandbox_count,
    is_sandbox_available,
    is_sandbox_disabled,
    reset_request_sandbox_budget,
    restore_request_sandbox_budget,
    run_sandbox_query,
    run_sqlite_job,
)
from app.sql_templates import (
    compile_sql_template,
    normalize_channel_filter,
    normalize_template_id,
)
from app.tools import build_agent_tools
from app.twin import (
    _find_non_finite_in_value,
    _quantize_budget,
    clear_twin_caches,
    compute_blended_roas,
    compute_twin_state,
    get_rows_csv_text,
    preview_budget_reallocation,
)
from app.ui_messages import contains_lone_surrogate, convert_ui_messages
from app.ui_stream import (
    get_gateway_credential,
    sanitize_error_text,
    stream_langgraph_to_sse,
)
from app.workflow import (
    compile_workflow,
    normalize_schedule,
    normalize_threshold,
    normalize_workflow_channels,
    normalize_workflow_run_config,
    normalize_workflow_template,
    stream_workflow_dry_run,
)

REPO_ROOT = Path(__file__).resolve().parents[2]
GENERATOR_SCRIPT = REPO_ROOT / "scripts" / "generate_twin.py"


def _load_generator_module(module_name: str = "generate_twin_whitebox"):
    spec = importlib.util.spec_from_file_location(module_name, GENERATOR_SCRIPT)
    assert spec is not None and spec.loader is not None
    mod = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = mod
    spec.loader.exec_module(mod)
    return mod


def _parse_sse_frames(raw_text: str) -> tuple[list[dict[str, Any]], bool]:
    blocks = [blk for blk in raw_text.split("\n\n") if blk.strip()]
    frames: list[dict[str, Any]] = []
    saw_done = False
    for idx, blk in enumerate(blocks):
        assert blk.startswith("data: ")
        payload = blk[len("data: ") :]
        if payload == "[DONE]":
            assert idx == len(blocks) - 1
            saw_done = True
        else:
            frames.append(json.loads(payload))
    return frames, saw_done


@pytest.fixture(autouse=True)
def _isolated_backend_env(monkeypatch: pytest.MonkeyPatch):
    reset_rate_limiter()
    reset_pricing_cache()
    monkeypatch.setenv("SANDBOX_DISABLED", "1")
    monkeypatch.delenv("AI_GATEWAY_API_KEY", raising=False)
    monkeypatch.delenv("VERCEL_OIDC_TOKEN", raising=False)
    if hasattr(app.state, "model_factory"):
        delattr(app.state, "model_factory")
    if hasattr(app.state, "turn_timeout_seconds"):
        delattr(app.state, "turn_timeout_seconds")
    yield
    reset_rate_limiter()
    reset_pricing_cache()
    clear_twin_caches()
    if hasattr(app.state, "model_factory"):
        delattr(app.state, "model_factory")
    if hasattr(app.state, "turn_timeout_seconds"):
        delattr(app.state, "turn_timeout_seconds")


# ===========================================================================
# 1. Defect & Polish Regression Tests
# ===========================================================================


async def test_adv_workflow_two_channel_est_tokens_avoided_matches_scoped_table() -> None:
    """2-channel workflow dry run must compute estTokensAvoided against its 2-row scoped_table."""
    frames_two: list[dict[str, Any]] = []
    async for raw in stream_workflow_dry_run(
        workflow={
            "template": "cross-channel-roas",
            "channels": ["google_ads", "linkedin_ads"],
            "threshold": 20,
        }
    ):
        if raw.startswith("data: {"):
            frames_two.append(json.loads(raw[len("data: ") :].strip()))

    frames_three: list[dict[str, Any]] = []
    async for raw in stream_workflow_dry_run(
        workflow={
            "template": "cross-channel-roas",
            "channels": ["google_ads", "linkedin_ads", "meta_ads"],
            "threshold": 20,
        }
    ):
        if raw.startswith("data: {"):
            frames_three.append(json.loads(raw[len("data: ") :].strip()))

    step3_two = frames_two[3]
    step3_three = frames_three[3]
    assert step3_two["summary"]["rowsReturned"] == 2
    assert len(step3_two["summary"]["table"]) == 2

    expected_two = compute_estimated_tokens_avoided(
        get_rows_csv_text(),
        step3_two["summary"]["table"],
    )
    assert step3_two["summary"]["estTokensAvoided"] == expected_two
    assert step3_two["summary"]["estTokensAvoided"] > step3_three["summary"]["estTokensAvoided"]
    assert f"~{expected_two:,} est. tokens avoided" in step3_two["detail"]


def test_adv_sandbox_budget_restore_cross_context_suppresses_value_error() -> None:
    """Restoring a ContextVar token across ASGI contexts on stream close must not raise ValueError."""
    ctx_a = contextvars.copy_context()
    token = ctx_a.run(reset_request_sandbox_budget)

    ctx_b = contextvars.copy_context()
    ctx_b.run(restore_request_sandbox_budget, token)


def test_adv_sandbox_job_script_preserves_crlf_inside_quoted_csv_fields(
    tmp_path: Path,
) -> None:
    """Generated job.py and in-process run_sqlite_job must preserve CRLF inside quoted CSV cells."""
    buf = io.StringIO()
    writer = csv.writer(buf, lineterminator="\n")
    writer.writerow(
        [
            "date",
            "channel",
            "campaign_id",
            "ad_group_id",
            "spend",
            "clicks",
            "conversions",
            "pipeline_value",
        ]
    )
    writer.writerow(
        [
            "2026-11-16",
            "Google Ads",
            "cmp_line1\r\ncmp_line2",
            "ag_cr\r_only",
            "100.00",
            "25",
            "2",
            "500.00",
        ]
    )
    csv_bytes = buf.getvalue().encode("utf-8")
    (tmp_path / "rows.csv").write_bytes(csv_bytes)

    compiled = compile_sql_template("ad_group_efficiency")
    job_code = build_job_script(compiled.sql, compiled.params)
    (tmp_path / "job.py").write_text(job_code, encoding="utf-8")

    proc = subprocess.run(
        [sys.executable, "-I", "-B", "job.py"],
        cwd=tmp_path,
        capture_output=True,
        text=True,
        check=True,
    )
    sandbox_out = json.loads(proc.stdout)
    in_proc_out = run_sqlite_job(csv_bytes.decode("utf-8"), compiled.sql, compiled.params)

    assert sandbox_out == in_proc_out
    assert sandbox_out["table"][0]["campaign_id"] == "cmp_line1\r\ncmp_line2"
    assert sandbox_out["table"][0]["ad_group_id"] == "ag_cr\r_only"
    assert get_rows_csv_text(tmp_path) == csv_bytes.decode("utf-8")


def test_adv_extract_client_ip_skips_empty_leading_xff_hops_and_handles_missing_client() -> None:
    """extract_client_ip must skip blank leading X-Forwarded-For hops and handle client=None."""

    def _make_req(headers: list[tuple[bytes, bytes]], client: tuple[str, int] | None) -> Request:
        scope = {
            "type": "http",
            "method": "POST",
            "path": "/api/agent/chat",
            "headers": headers,
            "client": client,
        }
        return Request(scope)

    req_leading_comma = _make_req(
        [(b"x-forwarded-for", b" , , 198.51.100.77, 10.0.0.1")],
        ("127.0.0.1", 50000),
    )
    assert extract_client_ip(req_leading_comma) == "198.51.100.77"

    req_blank_xff = _make_req(
        [(b"x-forwarded-for", b"   ,   ")],
        ("192.0.2.55", 50000),
    )
    assert extract_client_ip(req_blank_xff) == "192.0.2.55"

    req_no_client = _make_req([], None)
    assert extract_client_ip(req_no_client) == "unknown"

    long_ip = "2001:db8:" + ("a" * 200)
    req_oversized = _make_req([(b"x-forwarded-for", long_ip.encode("ascii"))], None)
    assert len(extract_client_ip(req_oversized)) == 128


def test_adv_gateway_failover_detects_flat_and_nested_model_attempts() -> None:
    """_gateway_attempted_failover must detect multi-attempt metadata in both flat and nested shapes."""
    primary = "google/gemini-3.1-flash-lite"
    assert (
        _gateway_attempted_failover(
            primary,
            primary,
            {
                "gateway_provider_metadata": {
                    "gateway": {
                        "modelAttempts": [
                            {"model": primary, "success": False},
                            {"model": primary, "success": True},
                        ]
                    }
                }
            },
        )
        is True
    )
    assert (
        _gateway_attempted_failover(
            primary,
            primary,
            {
                "gateway": {
                    "routing": {
                        "attempts": [
                            {"model": primary, "success": False},
                            {"model": primary, "success": True},
                        ]
                    }
                }
            },
        )
        is True
    )
    assert (
        _gateway_attempted_failover(
            primary,
            primary,
            {"gateway_provider_metadata": {"gateway": {"modelAttempts": [{"model": primary}]}}},
        )
        is False
    )


async def test_adv_pricing_live_catalog_ttl_expiry_and_error_fallbacks(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """ensure_model_prices_loaded must fall back on HTTP/JSON errors and refresh after TTL expiry."""
    import app.pricing as pricing_mod

    # 1. PRICING_OFFLINE=1 short-circuits without HTTP calls.
    monkeypatch.setenv("PRICING_OFFLINE", "true")
    assert await ensure_model_prices_loaded() == PINNED_PRICING_SOURCE
    monkeypatch.delenv("PRICING_OFFLINE", raising=False)

    # 2. Timeout, 503, malformed JSON, and negative/missing rates all keep pinned-2026-11-17.
    scenarios: list[Any] = [
        httpx.ReadTimeout("Timed out reading /v1/models"),
        httpx.Response(503, text="Service unavailable"),
        httpx.Response(200, content=b"{not-json"),
        httpx.Response(
            200,
            json={
                "data": [
                    None,
                    {"id": "", "pricing": {"input": "0.001", "output": "0.002"}},
                    {"id": "bad/neg", "pricing": {"input": "-0.001", "output": "0.002"}},
                    {"id": "bad/nan", "pricing": {"input": "NaN", "output": "0.002"}},
                    {"id": "bad/bool", "pricing": {"input": True, "output": "0.002"}},
                    {"id": "bad/missing", "pricing": {"input": "0.001"}},
                ]
            },
        ),
    ]
    for outcome in scenarios:
        reset_pricing_cache()

        class _ErrClient:
            def __init__(self, *args: Any, **kwargs: Any) -> None:
                pass

            async def __aenter__(self) -> _ErrClient:
                return self

            async def __aexit__(self, *args: Any) -> bool:
                return False

            async def get(self, url: str) -> httpx.Response:
                if isinstance(outcome, Exception):
                    raise outcome
                return outcome

        monkeypatch.setattr(httpx, "AsyncClient", _ErrClient)
        assert await ensure_model_prices_loaded() == PINNED_PRICING_SOURCE
        assert get_pricing_source() == PINNED_PRICING_SOURCE

    # 3. Cache hit within TTL avoids re-fetching; advancing clock past TTL refreshes live rates.
    reset_pricing_cache()
    clock = [1000.0]
    fetch_count = [0]

    class _TtlClient:
        def __init__(self, *args: Any, **kwargs: Any) -> None:
            pass

        async def __aenter__(self) -> _TtlClient:
            return self

        async def __aexit__(self, *args: Any) -> bool:
            return False

        async def get(self, url: str) -> httpx.Response:
            fetch_count[0] += 1
            rate = "0.00000015" if fetch_count[0] == 1 else "0.00000045"
            return httpx.Response(
                200,
                json={
                    "data": [
                        {
                            "id": "google/gemini-3.1-flash-lite",
                            "pricing": {"input": rate, "output": "0.0000010"},
                        }
                    ]
                },
            )

    monkeypatch.setattr(httpx, "AsyncClient", _TtlClient)
    monkeypatch.setattr(pricing_mod.time, "monotonic", lambda: clock[0])

    res_a, res_b = await asyncio.gather(
        ensure_model_prices_loaded(),
        ensure_model_prices_loaded(),
    )
    assert res_a == "live" and res_b == "live"
    assert fetch_count[0] == 1
    assert get_model_price("google/gemini-3.1-flash-lite").input_per_token == 0.00000015

    clock[0] += 600.0
    await ensure_model_prices_loaded()
    assert fetch_count[0] == 1

    clock[0] += 3601.0
    await ensure_model_prices_loaded()
    assert fetch_count[0] == 2
    assert get_model_price("google/gemini-3.1-flash-lite").input_per_token == 0.00000045


def test_adv_ui_messages_rejects_non_list_parts_field() -> None:
    """Malformed non-list 'parts' fields must raise ValueError instead of silently falling through."""
    with pytest.raises(ValueError, match="parts"):
        convert_ui_messages(
            [{"role": "user", "parts": "not-a-list", "content": "Fallback content"}]
        )
    with pytest.raises(ValueError, match="parts"):
        convert_ui_messages(
            [
                {"role": "user", "content": "First"},
                {"role": "assistant", "parts": {"bad": 1}, "content": "Second"},
                {"role": "user", "content": "Third"},
            ]
        )


def test_adv_generator_largest_remainder_rejects_zero_negative_or_nan_weights() -> None:
    """_largest_remainder_cents must raise ValueError on empty, zero-sum, negative, or NaN weights."""
    gen = _load_generator_module("gen_twin_weights")
    for bad_total, bad_weights in (
        (100, []),
        (1, [1.0, 1.0]),
        (100, [0.0, 0.0]),
        (100, [-1.0, 3.0]),
        (100, [float("nan"), 1.0]),
        (100, [float("inf"), 1.0]),
    ):
        with pytest.raises(ValueError):
            gen._largest_remainder_cents(bad_total, bad_weights, min_cents=1)


# ===========================================================================
# 2. Comprehensive White-Box Branch & Edge-Case Suite Across All Modules
# ===========================================================================


def test_adv_pricing_edge_rates_free_models_cache_write_and_unknown_fallbacks() -> None:
    """Cover parse_models_catalog_payload, :free models, cache_write rates, and unknown model tiers."""
    assert parse_models_catalog_payload(None) == {}
    assert parse_models_catalog_payload({"data": "invalid"}) == {}

    free_cost, free_baseline = compute_turn_costs(
        served_model="meta-llama/llama-4-scout:free",
        tier="fast",
        input_tokens=800,
        cached_tokens=100,
        output_tokens=50,
    )
    assert free_cost == 0.0
    assert free_baseline > 0.0
    assert get_model_price("custom/demo-free").output_per_token == 0.0

    assert get_model_price("unknown/fast-v1", fallback_tier="fast") == get_model_price(
        DEFAULT_FAST_MODELS[0]
    )
    assert get_model_price(
        "unknown/reasoning-v1", fallback_tier="reasoning"
    ) == get_model_price(DEFAULT_REASONING_MODELS[0])

    sonnet_cost = compute_token_cost_usd(
        "anthropic/claude-sonnet-5.5",
        input_tokens=1000,
        cached_tokens=300,
        cache_write_tokens=200,
        output_tokens=100,
    )
    assert sonnet_cost == pytest.approx(
        500 * 0.000002 + 300 * 0.0000001 + 200 * 0.0000025 + 100 * 0.00001
    )

    gemini_pro_cost = compute_token_cost_usd(
        "google/gemini-2.5-pro",
        input_tokens=1000,
        cached_tokens=1200,
        cache_write_tokens=400,
        output_tokens=50,
    )
    assert gemini_pro_cost == pytest.approx(1000 * 0.000000125 + 50 * 0.00001)

    rep_fast, rep_base = compute_turn_costs(
        served_model="google/gemini-3.1-flash-lite",
        tier="fast",
        input_tokens=1000,
        output_tokens=100,
        gateway_reported_cost=0.00031,
    )
    assert rep_fast == 0.00031
    assert rep_base > rep_fast

    nan_cost, _ = compute_turn_costs(
        served_model="google/gemini-3.1-flash-lite",
        tier="fast",
        input_tokens=400,
        output_tokens=40,
        gateway_reported_cost="NaN",
    )
    assert nan_cost > 0.0


def test_adv_router_all_keywords_deduplication_and_oidc_credential_precedence(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Cover every router keyword, env deduplication/blank fallback, and VERCEL_OIDC_TOKEN resolution."""
    assert select_route is route_turn
    for kw in (
        "REALLOC",
        "Budget",
        "shift",
        "STRATEGY",
        "Plan",
        "workflow",
        "SCHEDULE",
        "Guardrail",
    ):
        decision = route_turn(f"Please inspect {kw} settings")
        assert decision.tier == "reasoning"
        assert decision.routed_by == "keyword"

    monkeypatch.setenv("FAST_MODELS", " , custom/a , custom/b , custom/a , ")
    deduped = route_turn("Ping")
    assert deduped.primary_model == "custom/a"
    assert deduped.fallback_models == ("custom/b",)

    monkeypatch.setenv("FAST_MODELS", " ,   , ")
    assert route_turn("Ping").primary_model == DEFAULT_FAST_MODELS[0]

    monkeypatch.setenv("AI_GATEWAY_API_KEY", "   ")
    monkeypatch.setenv("VERCEL_OIDC_TOKEN", "  oidc_test_token_99  ")
    monkeypatch.setenv("GATEWAY_REPORTING_TAGS", "true")
    assert resolve_gateway_api_key() == "oidc_test_token_99"
    assert get_gateway_credential() == "oidc_test_token_99"

    llm = build_model("google/gemini-3.1-flash-lite", ["anthropic/claude-haiku-5.5"])
    req_payload = llm._get_request_payload([HumanMessage(content="Check")])
    assert "tags" not in req_payload["extra_body"]["providerOptions"]["gateway"]

    monkeypatch.delenv("AI_GATEWAY_API_KEY", raising=False)
    monkeypatch.delenv("VERCEL_OIDC_TOKEN", raising=False)
    assert resolve_gateway_api_key() is None
    assert get_gateway_credential() is None


async def test_adv_agent_unknown_tool_multipart_chunks_empty_id_and_live_branch(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Cover _extract_chunk_text, GatewayChatOpenAI edge paths, unknown tools, and empty tool IDs."""
    assert _extract_chunk_text(["Alpha ", {"type": "text", "text": "Beta"}, {"type": "tool_use"}]) == "Alpha Beta"
    assert _extract_chunk_text(None) == ""
    assert _extract_chunk_text(42) == ""

    monkeypatch.setenv("AI_GATEWAY_API_KEY", "test-key")
    gw_llm = build_model("google/gemini-3.1-flash-lite", [])
    gw_chunk = gw_llm._convert_chunk_to_generation_chunk(
        {
            "id": "c_gw_cost",
            "model": "google/gemini-3.1-flash-lite",
            "choices": [],
            "provider_metadata": {"gateway": {"cost": 0.00019}},
        },
        AIMessageChunk,
        {},
    )
    assert gw_chunk is not None and gw_chunk.generation_info["gateway_cost"] == 0.00019
    monkeypatch.setattr(
        GatewayChatOpenAI.__mro__[1],
        "_convert_chunk_to_generation_chunk",
        lambda self, *a, **kw: None,
    )
    assert gw_llm._convert_chunk_to_generation_chunk({}, AIMessageChunk, None) is None

    class _DumpableResponse:
        def model_dump(self) -> dict[str, Any]:
            return {
                "id": "c_dump",
                "model": "google/gemini-2.5-flash",
                "choices": [
                    {
                        "index": 0,
                        "message": {"role": "assistant", "content": "Ok"},
                        "finish_reason": "stop",
                    }
                ],
                "provider_metadata": {"gateway": {"cost": 0.00011}},
            }

    monkeypatch.setattr(
        GatewayChatOpenAI.__mro__[1],
        "_create_chat_result",
        lambda self, response, generation_info=None: ChatResult(
            generations=[ChatGeneration(message=AIMessage(content="Ok"))]
        ),
    )
    dumped_res = gw_llm._create_chat_result(_DumpableResponse())
    assert dumped_res.generations[0].message.response_metadata["gateway_cost"] == 0.00011

    step_idx = [0]

    class _EdgeCaseModel(BaseChatModel):
        model_config = ConfigDict(arbitrary_types_allowed=True)

        @property
        def _llm_type(self) -> str:
            return "edge-case-chat"

        def bind_tools(self, tools: Any, **kwargs: Any) -> Runnable[Any, Any]:
            return self

        def _generate(self, messages: list[BaseMessage], **kwargs: Any) -> ChatResult:
            return ChatResult(generations=[ChatGeneration(message=AIMessage(content="ok"))])

        async def astream(
            self,
            input: Any,
            config: Any = None,
            **kwargs: Any,
        ) -> AsyncIterator[Any]:
            idx = step_idx[0]
            step_idx[0] += 1
            if idx == 0:
                yield AIMessageChunk(
                    content=["Checking ", {"type": "text", "text": "unknown tool."}],
                    tool_call_chunks=[
                        {
                            "name": "nonexistent_tool",
                            "args": "{}",
                            "id": "",
                            "index": 0,
                            "type": "tool_call_chunk",
                        }
                    ],
                    usage_metadata={
                        "input_tokens": 90,
                        "output_tokens": 15,
                        "total_tokens": 105,
                        "input_token_details": {"cache_read": 10, "cache_creation": 20},
                    },
                    response_metadata={"model_name": "   "},
                )
            else:
                yield AIMessage(
                    content="Recovered after unknown tool.",
                    usage_metadata={
                        "input_tokens": 110,
                        "output_tokens": 12,
                        "total_tokens": 122,
                    },
                )

    import app.agent as agent_mod

    monkeypatch.setenv("PRICING_OFFLINE", "1")
    monkeypatch.setattr(agent_mod, "build_model", lambda primary, fallbacks: _EdgeCaseModel())

    route = route_turn("Run check", tier_hint="fast")
    graph = build_agent_graph(route=route, model_factory=None)
    raw_frames = [
        f
        async for f in stream_langgraph_to_sse(
            graph,
            {"messages": [HumanMessage(content="Run check")], "model_calls": 0, "pending_telemetry": None},
        )
    ]
    frames, saw_done = _parse_sse_frames("".join(raw_frames))
    assert saw_done is True
    tool_in = next(f for f in frames if f["type"] == "tool-input-available")
    assert tool_in["toolCallId"].startswith("call_")
    tool_err = next(f for f in frames if f["type"] == "tool-output-error")
    assert tool_err["toolCallId"] == tool_in["toolCallId"]
    assert "Unknown tool requested: nonexistent_tool" in tool_err["errorText"]

    capped_frames = [
        f
        async for f in stream_langgraph_to_sse(
            graph,
            {
                "messages": [HumanMessage(content="Already at cap")],
                "model_calls": MAX_MODEL_CALLS,
                "pending_telemetry": None,
            },
        )
    ]
    parsed_cap, cap_done = _parse_sse_frames("".join(capped_frames))
    assert cap_done is True
    assert any(
        f["type"] == "error" and "maximum of 6 model calls" in f["errorText"]
        for f in parsed_cap
    )


async def test_adv_ui_messages_and_ui_stream_corner_cases() -> None:
    """Cover cycle-safe surrogate detection, system/content-list messages, error sanitization, and timeout mid-text."""
    cyc_dict: dict[str, Any] = {}
    cyc_dict["self"] = cyc_dict
    cyc_list: list[Any] = []
    cyc_list.append(cyc_list)
    assert contains_lone_surrogate({"d": cyc_dict, "l": cyc_list, "s": {"clean"}}) is False
    assert contains_lone_surrogate({"s": {"bad_\ud800"}}) is True

    conv = convert_ui_messages(
        [
            {"role": "system", "content": "Operator context note"},
            {
                "role": "user",
                "content": ["Multi-part ", {"type": "text", "text": "prompt"}],
            },
            {
                "role": "assistant",
                "parts": [
                    {"type": ""},
                    {
                        "type": "dynamic-tool",
                        "toolName": "   ",
                        "state": "output-available",
                        "output": "ignored",
                    },
                    {
                        "type": "tool-input-available",
                        "state": "output-available",
                        "output": "ignored_stream_chunk_type",
                    },
                    {
                        "type": "tool-audit_campaign_hygiene",
                        "state": "output-available",
                        "input": {"channel": "google_ads"},
                        "output": '{"brokenCount":4}',
                    },
                    {"type": "text", "text": "Summary without step-start."},
                ],
            },
            {
                "role": "assistant",
                "parts": [
                    {
                        "type": "tool-compile_workflow",
                        "state": "output-available",
                        "output": {"workflowId": "wf_1"},
                    }
                ],
            },
            {"role": "user", "parts": [{"type": "text", "text": "Next question"}]},
        ]
    )
    assert isinstance(conv.langchain_messages[0], SystemMessage)
    assert isinstance(conv.langchain_messages[1], HumanMessage)
    assert conv.langchain_messages[1].content == "Multi-part prompt"
    assert conv.langchain_messages[2].tool_calls[0]["id"] == "call_2_3"
    assert isinstance(conv.langchain_messages[3], ToolMessage)
    assert conv.langchain_messages[3].content == '{"brokenCount":4}'
    assert isinstance(conv.langchain_messages[4], AIMessage)
    assert conv.langchain_messages[4].content == "Summary without step-start."

    for invalid_msgs in (
        "not-a-sequence",
        [],
        ["not-an-object"],
        [{"role": "user", "content": "bad_\ud800"}],
        [{"role": "assistant", "content": "No trailing user"}],
        [{"role": "developer", "content": "Unsupported role"}, {"role": "user", "content": "Hi"}],
        [123, {"role": "user", "content": "Hi"}],
        [{"role": "user", "parts": [123]}],
        [{"role": "user", "parts": [{"type": "text", "text": 99}]}],
        [{"role": "user", "content": [{"type": "text", "text": 99}]}],
        [{"role": "user", "content": 12345}],
        [{"role": "user", "parts": []}],
        [{"role": "assistant", "parts": [123]}, {"role": "user", "content": "Hi"}],
        [
            {"role": "assistant", "parts": [{"type": "text", "text": 123}]},
            {"role": "user", "content": "Hi"},
        ],
    ):
        with pytest.raises(ValueError):
            convert_ui_messages(invalid_msgs)  # type: ignore[arg-type]

    # 4. sanitize_error_text: empty string, lone surrogate, token redaction, and 300-char cap.
    vck_sample = "vc" + "k_token98765"
    gh_sample = "gh" + "p_token98765"
    assert sanitize_error_text("") == "Agent execution failed."
    redacted = sanitize_error_text(
        f"Err \ud800 at /opt/relay/service.py keys {vck_sample} and {gh_sample} " + ("x" * 350)
    )
    assert len(redacted) == 300
    assert "\ud800" not in redacted
    assert vck_sample not in redacted
    assert gh_sample not in redacted
    assert "<redacted-path>" in redacted
    assert "<redacted-credential>" in redacted

    # 5. stream_langgraph_to_sse: non-dict events, empty delta suppression, step_finish closing open text,
    # error with open text, unclosed stream finish, and timeout labels.
    class _CustomEventGraph:
        def __init__(self, events: list[Any], *, hang_after: bool = False) -> None:
            self._events = events
            self._hang_after = hang_after

        async def astream(self, *args: Any, **kwargs: Any) -> AsyncIterator[Any]:
            for ev in self._events:
                yield ev
            if self._hang_after:
                await asyncio.sleep(5.0)

    evs_a = [
        "ignored-non-dict",
        {"kind": "step_start"},
        {"kind": "text_delta", "delta": ""},
        {"kind": "text_delta", "delta": "Closed-by-step-finish"},
        {"kind": "step_finish"},
        {"kind": "text_delta", "delta": "Auto-opened"},
    ]
    frames_a, done_a = _parse_sse_frames(
        "".join([f async for f in stream_langgraph_to_sse(_CustomEventGraph(evs_a), {})])
    )
    assert done_a is True
    assert [f["type"] for f in frames_a] == [
        "start",
        "start-step",
        "text-start",
        "text-delta",
        "text-end",
        "finish-step",
        "start-step",
        "text-start",
        "text-delta",
        "text-end",
        "finish-step",
        "finish",
    ]

    evs_b = [
        {"kind": "text_delta", "delta": "Partial"},
        {"kind": "error", "errorText": "Hit cap"},
    ]
    frames_b, _ = _parse_sse_frames(
        "".join([f async for f in stream_langgraph_to_sse(_CustomEventGraph(evs_b), {})])
    )
    assert [f["type"] for f in frames_b] == [
        "start",
        "start-step",
        "text-start",
        "text-delta",
        "text-end",
        "finish-step",
        "error",
        "finish",
    ]

    frames_c, _ = _parse_sse_frames(
        "".join(
            [
                f
                async for f in stream_langgraph_to_sse(
                    _CustomEventGraph([{"kind": "text_delta", "delta": "Slow"}], hang_after=True),
                    {},
                    timeout_seconds=0.03,
                )
            ]
        )
    )
    assert [f["type"] for f in frames_c] == [
        "start",
        "start-step",
        "text-start",
        "text-delta",
        "text-end",
        "finish-step",
        "error",
        "finish",
    ]
    assert "0.03-second time limit" in frames_c[6]["errorText"]

    class _ImmediateTimeoutGraph:
        async def astream(self, *args: Any, **kwargs: Any) -> AsyncIterator[Any]:
            if False:
                yield {}
            raise TimeoutError("simulated timeout")

    frames_int_to, _ = _parse_sse_frames(
        "".join(
            [
                f
                async for f in stream_langgraph_to_sse(
                    _ImmediateTimeoutGraph(),
                    {},
                    timeout_seconds=55.0,
                )
            ]
        )
    )
    assert "55-second time limit" in frames_int_to[1]["errorText"]


async def test_adv_main_rate_limiter_lru_eviction_sanitizers_and_exception_handlers() -> None:
    """Cover SlidingWindowRateLimiter expired-reap + LRU eviction, JSON sanitizers, and 422 handlers."""
    limiter = SlidingWindowRateLimiter(max_requests=2, window_seconds=60.0, max_tracked_ips=3)
    assert limiter.check("192.0.2.1", now=10.0)[0] is True
    assert limiter.check("192.0.2.2", now=20.0)[0] is True
    assert limiter.check("192.0.2.3", now=30.0)[0] is True

    assert limiter.check("192.0.2.2", now=35.0)[0] is True
    assert limiter.check("192.0.2.4", now=40.0)[0] is True
    assert "192.0.2.1" not in limiter._buckets
    assert "192.0.2.2" in limiter._buckets

    assert limiter.check("192.0.2.5", now=90.0)[0] is True
    assert "192.0.2.3" not in limiter._buckets
    assert len(limiter._buckets) <= RATE_LIMIT_MAX_TRACKED_IPS

    nested: Any = "leaf\ud800"
    for _ in range(70):
        nested = [nested]
    sanitized = _sanitize_json_value(
        {"bytes": b"ok\xff", "err": ValueError("bad\ud800"), "deep": nested, "nan": float("nan")}
    )
    assert json.dumps(sanitized, allow_nan=False)

    chat_req = ChatRequest(messages=[{"role": "user", "content": "Hello"}])
    chat_req._converted = None
    assert chat_req.converted_conversation.latest_user_text == "Hello"

    scope = {"type": "http", "method": "POST", "path": "/api/agent/chat", "headers": []}
    dummy_req = Request(scope)

    class _DummyModel(BaseModel):
        x: int

    try:
        _DummyModel.model_validate({"x": "not-int"})
    except ValidationError as val_err:
        resp_ve = await handle_pydantic_validation_error(dummy_req, val_err)
        assert resp_ve.status_code == 422

    class _RecursiveRVE(RequestValidationError):
        def errors(self) -> Any:
            raise RecursionError("depth overflow")

    resp_rve = await handle_request_validation_error(dummy_req, _RecursiveRVE([]))
    assert resp_rve.status_code == 422
    assert b"nesting depth" in resp_rve.body


async def test_adv_sandbox_runner_and_sql_templates_remaining_branches(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Cover ContextVar lazy init, sandbox invalid JSON schemas, str stdout, and SQL WHERE filters."""
    fresh_ctx = contextvars.copy_context()
    assert fresh_ctx.run(get_request_sandbox_count) == 0
    assert _normalize_cell(-0.0) == 0.0 and math.copysign(1.0, _normalize_cell(-0.0)) == 1.0

    monkeypatch.setenv("SANDBOX_DISABLED", "false")
    monkeypatch.setattr(
        "app.sandbox_runner.get_credentials",
        lambda: (_ for _ in ()).throw(RuntimeError("OIDC read failure")),
    )
    assert is_sandbox_available() is False
    assert is_sandbox_disabled() is False
    monkeypatch.setenv("SANDBOX_DISABLED", "YES")
    assert is_sandbox_disabled() is True

    with pytest.raises(ValueError, match="Unexpected rows.csv header"):
        run_sqlite_job("", "SELECT 1")
    with pytest.raises(ValueError, match="Unexpected rows.csv header"):
        run_sqlite_job("col_a,col_b\n1,2\n", "SELECT 1")

    monkeypatch.setenv("SANDBOX_DISABLED", "0")
    for bad_stdout in (
        "[1, 2, 3]",
        json.dumps({"table": "not-list", "rowsScanned": 10}),
        json.dumps({"table": [], "rowsScanned": True}),
        json.dumps({"table": [], "rowsScanned": "10"}),
    ):
        class _SchemaBox:
            def __init__(self, out: str) -> None:
                self._out = out

                class _Fs:
                    async def write_text(self, p: str, c: str) -> None:
                        return None

                self.fs = _Fs()

            async def __aenter__(self) -> _SchemaBox:
                return self

            async def __aexit__(self, *args: Any) -> bool:
                return False

            async def run_command(self, *args: Any, **kwargs: Any) -> Any:
                return type("CmdRes", (), {"stdout": self._out})()

        monkeypatch.setattr(
            sandbox,
            "create_sandbox",
            lambda out=bad_stdout, **kw: _SchemaBox(out),
        )
        token = _request_sandbox_budget.set(None)
        try:
            res = await run_sandbox_query("channel_roas_summary")
            assert res.mode == "in-process"
            assert get_request_sandbox_count() == 1
        finally:
            restore_request_sandbox_budget(token)

    assert normalize_template_id(None) == "channel_roas_summary"
    assert normalize_template_id("   ") == "channel_roas_summary"
    assert normalize_template_id("daily-pacing") == "daily_pacing_anomalies"
    assert normalize_channel_filter("*") is None
    assert normalize_channel_filter("   ") is None
    with pytest.raises(ValueError):
        normalize_template_id(123)  # type: ignore[arg-type]
    with pytest.raises(ValueError):
        normalize_channel_filter(123)  # type: ignore[arg-type]
    with pytest.raises(ValueError):
        compile_sql_template("channel_roas_summary", params=["bad"])  # type: ignore[arg-type]
    with pytest.raises(ValueError):
        compile_sql_template("channel_roas_summary", {"start_date": 20261101})

    monkeypatch.setenv("SANDBOX_DISABLED", "1")
    pacing_date_range = await run_sandbox_query(
        "daily_pacing_anomalies",
        {
            "channel": "google_ads",
            "campaign_id": "cmp_google_01",
            "start_date": "2026-10-01",
            "end_date": "2026-10-15",
            "limit": 5,
        },
    )
    assert pacing_date_range.rowsReturned == 5
    assert all(r["channel"] == "Google Ads" for r in pacing_date_range.table)

    pacing_days_window = await run_sandbox_query(
        "daily_pacing_anomalies",
        {
            "channel": "linkedin_ads",
            "days": 10,
            "limit": 5,
        },
    )
    assert pacing_days_window.rowsReturned == 5
    assert all(r["channel"] == "LinkedIn Ads" for r in pacing_days_window.table)

    asc_campaigns = await run_sandbox_query(
        "campaign_roas_ranking",
        {"sort_order": "asc", "limit": 3},
    )
    assert asc_campaigns.table[0]["campaign_id"] == "cmp_linkedin_01"


async def test_adv_workflow_validators_ast_validity_zero_budget_gate_and_alias() -> None:
    """Cover workflow normalizers, Temporal Python AST parsing, twinMutations alias, and $0 scoped gate."""
    assert normalize_workflow_template(None) == "daily-pacing-guardrail"
    assert normalize_workflow_template("   ") == "daily-pacing-guardrail"
    assert normalize_workflow_template("hygiene") == "creative-404-guard"
    assert normalize_workflow_channels([]) == ["google_ads", "linkedin_ads", "meta_ads"]
    assert normalize_workflow_channels(["Meta Ads", "google", "meta_ads"]) == [
        "google_ads",
        "meta_ads",
    ]
    assert normalize_threshold(None) == 15
    assert normalize_threshold(1) == 1 and normalize_threshold(100) == 100
    assert normalize_schedule(None) == "0 7 * * *"
    assert normalize_schedule("   ") == "0 7 * * *"
    assert normalize_schedule("0   7  * *   1-5") == "0 7 * * 1-5"

    for bad_fn in (
        lambda: normalize_workflow_template(123),
        lambda: normalize_workflow_channels("google_ads"),
        lambda: normalize_workflow_channels([123]),
        lambda: normalize_workflow_channels(["unknown_ads"]),
        lambda: normalize_threshold(True),
        lambda: normalize_threshold(101),
        lambda: normalize_schedule(123),
        lambda: normalize_schedule("0 7 * *"),
        lambda: normalize_schedule("0 7 * * *; bad"),
        lambda: normalize_workflow_run_config("not-a-dict"),  # type: ignore[arg-type]
    ):
        with pytest.raises(ValueError):
            bad_fn()

    for tpl in (
        "creative-404-guard",
        "cross-channel-roas",
        "paid-social-reallocation",
        "daily-pacing-guardrail",
    ):
        compiled = compile_workflow(
            template=tpl,
            channels=["linkedin_ads", "google_ads"],
            threshold=25,
            schedule="15 6 * * 1-5",
        )
        parsed_ast = ast.parse(compiled["temporalCode"])
        assert any(
            isinstance(node, ast.ClassDef) and node.name == "RelayCampaignGuardrailWorkflow"
            for node in parsed_ast.body
        )

    client = TestClient(app)
    resp = client.post(
        "/api/agent/workflows/run",
        json={
            "workflow": {
                "template": "daily-pacing-guardrail",
                "channels": ["meta_ads"],
                "threshold": 10,
            },
            "twinMutations": [
                {"type": "pause_broken_creatives"},
                {"type": "fix_utm_taxonomy"},
                {
                    "type": "reallocate_budget",
                    "from_campaign": "cmp_meta_01",
                    "to_campaign": "cmp_google_01",
                    "amount_per_day": 467.0,
                },
                {
                    "type": "reallocate_budget",
                    "from_campaign": "cmp_meta_02",
                    "to_campaign": "cmp_google_01",
                    "amount_per_day": 350.0,
                },
                {
                    "type": "reallocate_budget",
                    "from_campaign": "cmp_meta_03",
                    "to_campaign": "cmp_google_01",
                    "amount_per_day": 250.0,
                },
            ],
        },
    )
    assert resp.status_code == 200
    events, done = _parse_sse_frames(resp.text)
    assert done is True
    assert events[0]["summary"]["dailyBudget"] == 0.0
    assert events[4]["summary"]["spendAtRiskPct"] == 0.0
    assert events[4]["summary"]["gateTriggered"] is False
    assert events[4]["summary"]["gateOutcome"] == "clear"


async def test_adv_tools_and_twin_synthetic_edge_cases_and_generator_cli(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Cover tool channel/campaign-name resolution, balanced/zero-budget twin states, and generator CLI."""
    tools_base = {t.name: t for t in build_agent_tools()}
    hyg_all = await tools_base["audit_campaign_hygiene"].ainvoke({"channel": "*"})
    assert hyg_all["brokenCount"] == 14
    hyg_blank = await tools_base["audit_campaign_hygiene"].ainvoke({"channel": "   "})
    assert hyg_blank["utmCount"] == 9
    hyg_google = await tools_base["audit_campaign_hygiene"].ainvoke({"channel": "Google Ads"})
    assert len(hyg_google["channels"]) == 1

    by_name = await tools_base["propose_budget_reallocation"].ainvoke(
        {
            "from_campaign": "linkedin account targeting — enterprise tier",
            "to_campaign": "cmp_google_01",
            "amount_per_day": 250.0,
        }
    )
    assert by_name["fromCampaign"] == "cmp_linkedin_01"
    assert by_name["toCampaign"] == "cmp_google_01"
    assert by_name["amountPerDay"] == 250.0

    by_blank_refs = await tools_base["propose_budget_reallocation"].ainvoke(
        {"from_campaign": "   ", "to_campaign": "   "}
    )
    assert by_blank_refs["fromCampaign"] == "cmp_linkedin_01"

    with pytest.raises(ValueError, match="Unknown from_campaign"):
        await tools_base["propose_budget_reallocation"].ainvoke(
            {"from_campaign": "Nonexistent Campaign Name"}
        )

    drained_li = [
        {
            "type": "reallocate_budget",
            "from_campaign": "cmp_linkedin_01",
            "to_campaign": "cmp_google_01",
            "amount_per_day": 1400.0,
        }
    ]
    next_prop = preview_budget_reallocation(drained_li)
    assert next_prop.fromCampaign != "cmp_linkedin_01"
    assert next_prop.blendedRoasAfter > next_prop.blendedRoasBefore

    with pytest.raises(ValueError, match="no available daily budget"):
        preview_budget_reallocation(drained_li, from_campaign="cmp_linkedin_01")
    with pytest.raises(ValueError, match="Unknown to_campaign"):
        preview_budget_reallocation([], from_campaign="cmp_linkedin_01", to_campaign="cmp_missing")

    with pytest.raises(ValueError):
        _quantize_budget("not-a-number")  # type: ignore[arg-type]
    assert _find_non_finite_in_value({(1, 2): 1.0, "s": frozenset({float("inf")})}) is not None
    assert compute_blended_roas([]) == 0.0

    bad_csv_dir = tmp_path / "bad_csv"
    bad_csv_dir.mkdir()
    (bad_csv_dir / "rows.csv").write_text("bad,header\n1,2\n", encoding="utf-8")
    clear_twin_caches()
    with pytest.raises(ValueError, match="Unexpected rows.csv header"):
        get_rows_csv_text(bad_csv_dir)

    synth_dir = tmp_path / "synth_balanced"
    synth_dir.mkdir()
    (synth_dir / "rows.csv").write_text(
        "date,channel,campaign_id,ad_group_id,spend,clicks,conversions,pipeline_value\n"
        "2026-11-16,Google Ads,cmp_a,ag_a_01,100.00,20,2,400.00\n",
        encoding="utf-8",
    )
    (synth_dir / "twin.json").write_text(
        json.dumps(
            {
                "seed": 1,
                "generatedForDate": "2026-11-17",
                "campaigns": [
                    {
                        "campaignId": "cmp_a",
                        "name": "Balanced A",
                        "channel": "Google Ads",
                        "channelId": "google_ads",
                        "matchType": "exact",
                        "adGroupCount": 2,
                        "dailyBudget": 200.0,
                        "totalSpend": 100.0,
                        "totalClicks": 20,
                        "totalConversions": 2,
                        "totalPipelineValue": 400.0,
                        "roas": 4.0,
                        "brokenCreatives": 0,
                        "utmViolations": 2,
                    },
                    {
                        "campaignId": "cmp_b",
                        "name": "Balanced B",
                        "channel": "LinkedIn Ads",
                        "channelId": "linkedin_ads",
                        "matchType": "sponsored",
                        "adGroupCount": 2,
                        "dailyBudget": 0.0,
                        "totalSpend": 0.0,
                        "totalClicks": 0,
                        "totalConversions": 0,
                        "totalPipelineValue": 0.0,
                        "roas": 4.0,
                        "brokenCreatives": 1,
                        "utmViolations": 0,
                    },
                ],
                "adGroups": [],
                "hygieneIssues": [
                    {
                        "issueId": "hyg_custom_1",
                        "issueType": "utm_violation",
                        "status": "active",
                        "channel": "Google Ads",
                        "channelId": "google_ads",
                        "campaignId": "cmp_a",
                        "campaignName": "Balanced A",
                        "adGroupId": "ag_unlisted_01",
                        "value": "utm_source=Bad",
                        "recommendedFix": "Fix UTM",
                        "dailySpendAtRisk": 75.0,
                    },
                    {
                        "issueId": "hyg_custom_2",
                        "issueType": "utm_violation",
                        "status": "active",
                        "channel": "Google Ads",
                        "channelId": "google_ads",
                        "campaignId": "cmp_a",
                        "campaignName": "Balanced A",
                        "adGroupId": "ag_unlisted_02",
                        "value": "utm_source=Bad2",
                        "canonicalValue": "utm_source=google&utm_medium=cpc&utm_campaign=cmp_a&utm_content=custom",
                        "recommendedFix": "Fix UTM",
                        "dailySpendAtRisk": 25.0,
                    },
                    {
                        "issueId": "hyg_zero_b",
                        "issueType": "broken_404",
                        "status": "active",
                        "channel": "LinkedIn Ads",
                        "channelId": "linkedin_ads",
                        "campaignId": "cmp_b",
                        "campaignName": "Balanced B",
                        "adGroupId": "ag_b_01",
                        "value": "https://fieldstone.example/404",
                        "recommendedFix": "Pause",
                        "dailySpendAtRisk": 10.0,
                    },
                ],
            }
        ),
        encoding="utf-8",
    )
    clear_twin_caches()
    synth_shifted = compute_twin_state(
        [
            {
                "type": "reallocate_budget",
                "from_campaign": "cmp_a",
                "to_campaign": "cmp_b",
                "amount_per_day": 100.0,
            }
        ],
        data_dir=synth_dir,
    )
    issues_by_id = {i.issueId: i for i in synth_shifted.hygieneIssues}
    assert issues_by_id["hyg_custom_1"].dailySpendAtRisk == 37.5
    assert issues_by_id["hyg_zero_b"].dailySpendAtRisk == 0.0

    synth_fixed = compute_twin_state([{"type": "fix_utm_taxonomy"}], data_dir=synth_dir)
    fixed_by_id = {i.issueId: i for i in synth_fixed.hygieneIssues}
    assert "ag_unlisted_01" in fixed_by_id["hyg_custom_1"].value
    assert fixed_by_id["hyg_custom_2"].value.endswith("utm_content=custom")

    balanced_prev = preview_budget_reallocation([], data_dir=synth_dir)
    assert balanced_prev.blendedRoasBefore == 4.0
    assert balanced_prev.blendedRoasAfter == 4.0

    single_dir = tmp_path / "synth_single"
    single_dir.mkdir()
    (single_dir / "rows.csv").write_text(
        "date,channel,campaign_id,ad_group_id,spend,clicks,conversions,pipeline_value\n"
        "2026-11-16,Google Ads,cmp_only,ag_01,10.00,2,1,40.00\n",
        encoding="utf-8",
    )
    for sub_name, budget_val, err_match in (
        ("one_funded", 100.0, "No distinct destination campaign"),
        ("zero_funded", 0.0, "No funded campaign"),
    ):
        d = tmp_path / sub_name
        d.mkdir()
        (d / "rows.csv").write_text(
            (single_dir / "rows.csv").read_text(encoding="utf-8"), encoding="utf-8"
        )
        (d / "twin.json").write_text(
            json.dumps(
                {
                    "campaigns": [
                        {
                            "campaignId": "cmp_only",
                            "name": "Only",
                            "channel": "Google Ads",
                            "channelId": "google_ads",
                            "matchType": "exact",
                            "adGroupCount": 1,
                            "dailyBudget": budget_val,
                            "totalSpend": 10.0,
                            "totalClicks": 2,
                            "totalConversions": 1,
                            "totalPipelineValue": 40.0,
                            "roas": 4.0,
                            "brokenCreatives": 0,
                            "utmViolations": 0,
                        }
                    ],
                    "hygieneIssues": [],
                }
            ),
            encoding="utf-8",
        )
        clear_twin_caches()
        with pytest.raises(ValueError, match=err_match):
            preview_budget_reallocation([], data_dir=d)

    gen = _load_generator_module("gen_twin_branches")
    orig_specs = list(gen.CAMPAIGN_SPECS)

    bad_spec = {**orig_specs[0], "broken404": {1: "https://fieldstone.example/x"}, "utmViolations": {1: "utm_source=x"}}
    monkeypatch.setattr(gen, "CAMPAIGN_SPECS", [bad_spec])
    with pytest.raises(ValueError, match="Overlapping hygiene issue indices"):
        gen.build_twin_artifacts(seed=20261117)

    zero_cvr_spec = {**orig_specs[0], "cvr": 0.0, "adGroupCount": 2, "dailyBudget": 50.0}
    monkeypatch.setattr(gen, "CAMPAIGN_SPECS", [zero_cvr_spec])
    twin_zero_json, _ = gen.build_twin_artifacts(seed=20261117)
    parsed_zero = json.loads(twin_zero_json)
    assert parsed_zero["campaigns"][0]["totalConversions"] == 1

    monkeypatch.setattr(gen, "CAMPAIGN_SPECS", orig_specs)
    cli_out = tmp_path / "cli_generated"
    monkeypatch.setattr(
        sys,
        "argv",
        ["generate_twin.py", "--output-dir", str(cli_out), "--seed", "20261117"],
    )
    gen.main()
    assert (cli_out / "twin.json").read_bytes() == (
        REPO_ROOT / "backend" / "data" / "twin.json"
    ).read_bytes()
    assert (cli_out / "rows.csv").read_bytes() == (
        REPO_ROOT / "backend" / "data" / "rows.csv"
    ).read_bytes()


# ===========================================================================
# 3. Concurrency Synchronization & Residual Branch Coverage Tests
# ===========================================================================


async def test_adv_iter2_pricing_concurrent_single_loop_and_multithread_ttl_refresh(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Concurrent callers on one or multiple event loops must wait for live pricing without race or deadlock."""
    import concurrent.futures
    import threading
    import app.pricing as pricing_mod

    reset_pricing_cache()
    monkeypatch.delenv("PRICING_OFFLINE", raising=False)

    clock = [1000.0]
    fetch_count = [0]

    class _YieldingCatalogClient:
        def __init__(self, *args: Any, **kwargs: Any) -> None:
            pass

        async def __aenter__(self) -> _YieldingCatalogClient:
            return self

        async def __aexit__(self, *args: Any) -> bool:
            return False

        async def get(self, url: str) -> httpx.Response:
            fetch_count[0] += 1
            seq = fetch_count[0]
            await asyncio.sleep(0)
            await asyncio.sleep(0)
            rate = "0.00000012" if seq == 1 else "0.00000064"
            return httpx.Response(
                200,
                json={
                    "data": [
                        {
                            "id": "google/gemini-3.1-flash-lite",
                            "pricing": {"input": rate, "output": "0.0000011"},
                        }
                    ]
                },
            )

    monkeypatch.setattr(httpx, "AsyncClient", _YieldingCatalogClient)
    monkeypatch.setattr(pricing_mod.time, "monotonic", lambda: clock[0])

    cold_sources = await asyncio.gather(*(ensure_model_prices_loaded() for _ in range(10)))
    assert cold_sources == ["live"] * 10
    assert fetch_count[0] == 1
    assert get_model_price("google/gemini-3.1-flash-lite").input_per_token == 0.00000012

    clock[0] += 3601.0

    async def _refresh_reader() -> tuple[str, float]:
        src = await ensure_model_prices_loaded()
        return src, get_model_price("google/gemini-3.1-flash-lite").input_per_token

    refreshed = await asyncio.gather(*(_refresh_reader() for _ in range(10)))
    assert fetch_count[0] == 2
    assert all(src == "live" and rate == 0.00000064 for src, rate in refreshed)

    reset_pricing_cache()
    monkeypatch.undo()
    monkeypatch.delenv("PRICING_OFFLINE", raising=False)

    barrier = threading.Barrier(4)

    class _ThreadedCatalogClient:
        def __init__(self, *args: Any, **kwargs: Any) -> None:
            pass

        async def __aenter__(self) -> _ThreadedCatalogClient:
            return self

        async def __aexit__(self, *args: Any) -> bool:
            return False

        async def get(self, url: str) -> httpx.Response:
            await asyncio.sleep(0.03)
            return httpx.Response(
                200,
                json={
                    "data": [
                        {
                            "id": "google/gemini-3.1-flash-lite",
                            "pricing": {"input": "0.00000022", "output": "0.0000011"},
                        }
                    ]
                },
            )

    monkeypatch.setattr(httpx, "AsyncClient", _ThreadedCatalogClient)

    def _thread_caller() -> list[str]:
        barrier.wait(timeout=2.0)

        async def _inner() -> list[str]:
            return list(
                await asyncio.wait_for(
                    asyncio.gather(*(ensure_model_prices_loaded() for _ in range(4))),
                    timeout=2.0,
                )
            )

        return asyncio.run(_inner())

    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        futs = [pool.submit(_thread_caller) for _ in range(4)]
        thread_results = [fut.result(timeout=4.0) for fut in futs]

    assert thread_results == [["live"] * 4 for _ in range(4)]
    reset_pricing_cache()


async def test_adv_iter2_rate_limiter_multithread_and_hostile_xff_safety() -> None:
    """SlidingWindowRateLimiter must remain thread-safe under concurrent LRU eviction and XFF bursts."""
    import concurrent.futures
    import random

    limiter = SlidingWindowRateLimiter(
        max_requests=20,
        window_seconds=60.0,
        max_tracked_ips=16,
    )
    prev_si = sys.getswitchinterval()
    sys.setswitchinterval(0.000005)
    try:
        def _worker(tid: int) -> int:
            rng = random.Random(202600 + tid)
            now = 100.0
            allowed_count = 0
            for _ in range(800):
                now += rng.uniform(0.0, 0.3)
                ip = f"198.51.100.{rng.randint(1, 64)}"
                ok, retry_after = limiter.check(ip, now=now)
                if ok:
                    allowed_count += 1
                else:
                    assert retry_after >= 1
            return allowed_count

        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            futs = [pool.submit(_worker, i) for i in range(8)]
            counts = [f.result(timeout=5.0) for f in futs]
    finally:
        sys.setswitchinterval(prev_si)

    assert sum(counts) > 0
    assert len(limiter._buckets) <= 16

    reset_rate_limiter()
    transport = httpx.ASGITransport(app=app)
    hostile_xff_variants = (
        {"X-Forwarded-For": " , , 203.0.113.88 , 10.0.0.1"},
        {"X-Forwarded-For": "203.0.113.88"},
        {"X-Forwarded-For": "\t , 203.0.113.88 , , "},
    )
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        responses = await asyncio.gather(
            *[
                client.post(
                    "/api/agent/chat",
                    headers=hostile_xff_variants[idx % len(hostile_xff_variants)],
                    json={"messages": [{"role": "user", "content": f"Status {idx}"}]},
                )
                for idx in range(25)
            ]
        )
    assert sum(1 for r in responses if r.status_code == 200) == 20
    assert sum(1 for r in responses if r.status_code == 429) == 5
    reset_rate_limiter()


async def test_adv_iter2_pricing_malformed_rates_and_missing_cache_read_fallback(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Cover non-numeric _parse_rate inputs and live catalog models omitting input_cache_read."""
    import app.pricing as pricing_mod

    reset_pricing_cache()
    catalog = parse_models_catalog_payload(
        {
            "data": [
                {"id": "bad/str-rate", "pricing": {"input": "not-a-float", "output": "0.001"}},
                {"id": "bad/obj-rate", "pricing": {"input": {}, "output": "0.001"}},
                {
                    "id": "custom/no-cache-discount",
                    "pricing": {"input": "0.000001", "output": "0.000004"},
                },
            ]
        }
    )
    assert list(catalog.keys()) == ["custom/no-cache-discount"]
    monkeypatch.setattr(pricing_mod, "_live_prices", catalog)

    cost = compute_token_cost_usd(
        "custom/no-cache-discount",
        input_tokens=1000,
        cached_tokens=400,
        output_tokens=100,
    )
    assert cost == pytest.approx(1000 * 0.000001 + 100 * 0.000004)

    turn_cost, baseline_cost = compute_turn_costs(
        served_model="google/gemini-3.1-flash-lite",
        tier="fast",
        input_tokens=500,
        output_tokens=50,
        gateway_reported_cost="not-numeric",
    )
    assert turn_cost > 0.0 and baseline_cost > turn_cost
    reset_pricing_cache()
    assert get_pricing_source() == PINNED_PRICING_SOURCE


async def test_adv_iter2_agent_type_error_tool_and_empty_stream_fallback(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Cover TypeError with empty message in tools_node, zero-chunk streams, and non-AIMessage chunk conversion."""
    from langchain_core.messages import HumanMessageChunk
    import app.agent as agent_mod

    class _ZeroChunkModel(BaseChatModel):
        model_config = ConfigDict(arbitrary_types_allowed=True)

        @property
        def _llm_type(self) -> str:
            return "zero-chunk"

        def bind_tools(self, tools: Any, **kwargs: Any) -> Runnable[Any, Any]:
            return self

        def _generate(self, messages: list[BaseMessage], **kwargs: Any) -> ChatResult:
            return ChatResult(generations=[ChatGeneration(message=AIMessage(content=""))])

        async def astream(self, input: Any, config: Any = None, **kwargs: Any) -> AsyncIterator[Any]:
            if False:
                yield None

    route = route_turn("Status", tier_hint="fast")
    zero_graph = build_agent_graph(
        route=route,
        model_factory=lambda primary, fallbacks: _ZeroChunkModel(),
    )
    zero_raw = "".join(
        [
            f
            async for f in stream_langgraph_to_sse(
                zero_graph,
                {"messages": [HumanMessage(content="Status")], "model_calls": 0, "pending_telemetry": None},
            )
        ]
    )
    assert '"type":"data-telemetry"' in zero_raw
    assert zero_raw.endswith("data: [DONE]\n\n")

    step_box = [0]

    class _HumanChunkAndTypeErrorModel(BaseChatModel):
        model_config = ConfigDict(arbitrary_types_allowed=True)

        @property
        def _llm_type(self) -> str:
            return "human-chunk-typeerror"

        def bind_tools(self, tools: Any, **kwargs: Any) -> Runnable[Any, Any]:
            return self

        def _generate(self, messages: list[BaseMessage], **kwargs: Any) -> ChatResult:
            return ChatResult(generations=[ChatGeneration(message=AIMessage(content="ok"))])

        async def astream(self, input: Any, config: Any = None, **kwargs: Any) -> AsyncIterator[Any]:
            idx = step_box[0]
            step_box[0] += 1
            if idx == 0:
                yield AIMessage(
                    content="",
                    tool_calls=[
                        {"name": "audit_campaign_hygiene", "args": {}, "id": "call_te_1", "type": "tool_call"}
                    ],
                )
            else:
                yield HumanMessageChunk(content="Ignored non-AI chunk.")
                yield AIMessageChunk(content="Converted chunk reply.")

    class _RaisingTool:
        name = "audit_campaign_hygiene"

        async def ainvoke(self, input_data: dict[str, Any]) -> Any:
            raise TypeError("")

    monkeypatch.setattr(agent_mod, "build_agent_tools", lambda *a, **kw: [_RaisingTool()])
    monkeypatch.setattr(
        agent_mod,
        "message_chunk_to_message",
        lambda chunk: HumanMessage(content=str(chunk.content)),
    )
    te_graph = build_agent_graph(
        route=route,
        model_factory=lambda primary, fallbacks: _HumanChunkAndTypeErrorModel(),
    )
    te_frames = [
        json.loads(f[6:].strip())
        async for f in stream_langgraph_to_sse(
            te_graph,
            {"messages": [HumanMessage(content="Check")], "model_calls": 0, "pending_telemetry": None},
        )
        if f.startswith("data: {")
    ]
    err_part = next(f for f in te_frames if f["type"] == "tool-output-error")
    assert err_part["errorText"] == "Tool audit_campaign_hygiene failed"
    assert any(
        f["type"] == "text-delta" and f["delta"] == "Converted chunk reply."
        for f in te_frames
    )


async def test_adv_iter2_main_pydantic_validation_recursion_guard(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Cover RecursionError fallback in handle_pydantic_validation_error."""
    import app.main as main_mod

    real_ve = ValidationError.from_exception_data("TwinStateRequest", [])
    monkeypatch.setattr(
        main_mod,
        "jsonable_encoder",
        lambda *a, **kw: (_ for _ in ()).throw(RecursionError("synthetic recursion overflow")),
    )
    scope = {"type": "http", "method": "POST", "path": "/api/agent/twin/state", "headers": []}
    resp = await handle_pydantic_validation_error(Request(scope), real_ve)
    assert resp.status_code == 422
    assert b"Input nesting depth exceeded validation limit" in resp.body


async def test_adv_iter2_cross_feature_workflow_csv_and_50_mutation_conservation(
    tmp_path: Path,
) -> None:
    """Cross-verify 2-channel workflow estTokensAvoided after mutations, CRLF/CR CSV parity, and 50-step Fraction conservation."""
    from decimal import Decimal
    from fractions import Fraction
    import random
    from app.sql_templates import TEMPLATE_IDS
    from app.twin import get_row_count, load_base_twin

    muts = [
        {"type": "pause_broken_creatives"},
        {
            "type": "reallocate_budget",
            "from_campaign": "cmp_linkedin_01",
            "to_campaign": "cmp_google_01",
            "amount_per_day": 1400.0,
        },
    ]
    frames = [
        json.loads(raw[6:].strip())
        async for raw in stream_workflow_dry_run(
            workflow={"template": "cross-channel-roas", "channels": ["Meta Ads", "google"], "threshold": 15},
            mutations=muts,
        )
        if raw.startswith("data: {")
    ]
    assert len(frames) == 6
    step3 = frames[3]["summary"]
    assert step3["rowsReturned"] == 2
    assert step3["estTokensAvoided"] == compute_estimated_tokens_avoided(
        get_rows_csv_text(), step3["table"]
    )
    assert round(
        frames[1]["summary"]["spendAtRiskPerDay"] + frames[2]["summary"]["spendAtRiskPerDay"], 2
    ) == frames[5]["summary"]["spendAtRiskPerDay"]

    csv_dir = tmp_path / "crlf_quotes"
    csv_dir.mkdir()
    buf = io.StringIO()
    writer = csv.writer(buf, lineterminator="\r\n", quoting=csv.QUOTE_ALL)
    writer.writerow(
        ["date", "channel", "campaign_id", "ad_group_id", "spend", "clicks", "conversions", "pipeline_value"]
    )
    writer.writerow(["2026-11-16", "Google Ads", 'cmp_"q",1\r\n2', "ag_cr\r_lf\n", "150.00", "30", "3", "750.00"])
    writer.writerow(["2026-11-17", "Meta Ads", "cmp_\u2028_m", 'ag_""x""', "50.00", "10", "0", "0.00"])
    raw_bytes = buf.getvalue().encode("utf-8")
    (csv_dir / "rows.csv").write_bytes(raw_bytes)
    clear_twin_caches()

    csv_text = get_rows_csv_text(csv_dir)
    assert csv_text.encode("utf-8") == raw_bytes
    assert get_row_count(csv_dir) == 2
    for tpl_id in TEMPLATE_IDS:
        compiled = compile_sql_template(tpl_id)
        in_proc = run_sqlite_job(csv_text, compiled.sql, compiled.params)
        job_file = csv_dir / f"job_{tpl_id}.py"
        job_file.write_text(build_job_script(compiled.sql, compiled.params), encoding="utf-8")
        proc = subprocess.run(
            [sys.executable, "-I", "-B", job_file.name],
            cwd=csv_dir,
            capture_output=True,
            text=True,
            check=True,
        )
        assert in_proc == json.loads(proc.stdout)
    clear_twin_caches()

    base = load_base_twin()
    expected = {c.campaignId: Fraction(Decimal(str(c.dailyBudget))) for c in base.campaigns}
    total_frac = sum(expected.values())
    camp_ids = [c.campaignId for c in base.campaigns]
    rng = random.Random(2026111899)
    quantum = Fraction(1, 1_000_000)
    chain: list[dict[str, Any]] = []
    for _ in range(50):
        funded = [cid for cid, bal in expected.items() if bal >= quantum]
        src = rng.choice(funded)
        dst = rng.choice([cid for cid in camp_ids if cid != src])
        avail_micro = int(expected[src] / quantum)
        shift_micro = 1 if rng.random() < 0.3 else rng.randint(1, avail_micro)
        chain.append(
            {
                "type": "reallocate_budget",
                "from_campaign": src,
                "to_campaign": dst,
                "amount_per_day": round(shift_micro / 1_000_000, 6),
            }
        )
        delta = Fraction(shift_micro, 1_000_000)
        expected[src] -= delta
        expected[dst] += delta

    derived = compute_twin_state(chain)
    assert derived.totals.appliedMutations == 50
    assert Fraction(Decimal(str(derived.totals.dailyBudget))) == total_frac
    for camp in derived.campaigns:
        assert Fraction(Decimal(str(camp.dailyBudget))) == expected[camp.campaignId]

    prev = preview_budget_reallocation(chain[:49])
    post = compute_twin_state(
        chain[:49]
        + [
            {
                "type": "reallocate_budget",
                "from_campaign": prev.fromCampaign,
                "to_campaign": prev.toCampaign,
                "amount_per_day": prev.amountPerDay,
            }
        ]
    )
    assert post.totals.blendedRoas == prev.blendedRoasAfter

