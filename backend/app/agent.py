"""Stateless per-request LangGraph agent and AI Gateway ChatOpenAI client."""

from __future__ import annotations

import json
import os
from pathlib import Path
import time
from typing import Annotated, Any, Callable, Final, Literal, Mapping, Sequence, TypedDict
from uuid import uuid4

from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import (
    AIMessage,
    AIMessageChunk,
    BaseMessage,
    SystemMessage,
    ToolMessage,
)
from langchain_core.messages.utils import message_chunk_to_message
from langchain_core.outputs import ChatGenerationChunk, ChatResult
from langchain_core.tools import ToolException
from langchain_openai import ChatOpenAI
from langgraph.config import get_stream_writer
from langgraph.graph import END, START, StateGraph
from langgraph.graph.message import add_messages
from pydantic import ValidationError

from app.pricing import compute_turn_costs, ensure_model_prices_loaded
from app.router import RouteDecision
from app.tools import build_agent_tools
from app.twin import DerivedTwinState, Mutation, compute_twin_state

AI_GATEWAY_BASE_URL: Final[str] = "https://ai-gateway.vercel.sh/v1"
MAX_MODEL_CALLS: Final[int] = 6
MAX_OUTPUT_TOKENS: Final[int] = 1200

FailoverMode = Literal["none", "gateway", "simulated"]
ModelFactory = Callable[[str, Sequence[str]], BaseChatModel]


class SyntheticPrimaryOutageError(RuntimeError):
    """Synthetic HTTP 503 raised locally when injectFailure is enabled."""

    status_code: int = 503


class AgentState(TypedDict):
    """Per-turn LangGraph state rebuilt statelessly from UIMessage history."""

    messages: Annotated[list[BaseMessage], add_messages]
    model_calls: int
    pending_telemetry: dict[str, Any] | None


class GatewayChatOpenAI(ChatOpenAI):
    """ChatOpenAI subclass preserving AI Gateway model_name, cost, and routing metadata."""

    def _convert_chunk_to_generation_chunk(
        self,
        chunk: dict[str, Any],
        default_chunk_class: type,
        base_generation_info: dict[str, Any] | None,
    ) -> ChatGenerationChunk | None:
        gen_chunk = super()._convert_chunk_to_generation_chunk(
            chunk, default_chunk_class, base_generation_info
        )
        if gen_chunk is None:
            return None

        extra_info: dict[str, Any] = dict(gen_chunk.generation_info or {})
        model_name = chunk.get("model")
        if isinstance(model_name, str) and model_name.strip():
            extra_info["model_name"] = model_name.strip()

        usage = chunk.get("usage")
        if isinstance(usage, Mapping) and usage.get("cost") is not None:
            extra_info["gateway_cost"] = usage["cost"]

        prov_meta = chunk.get("provider_metadata") or chunk.get("providerMetadata")
        if isinstance(prov_meta, Mapping):
            extra_info["gateway_provider_metadata"] = dict(prov_meta)
            gw_meta = prov_meta.get("gateway")
            if isinstance(gw_meta, Mapping) and gw_meta.get("cost") is not None:
                extra_info["gateway_cost"] = gw_meta["cost"]

        if extra_info:
            gen_chunk.generation_info = extra_info
            gen_chunk.message.response_metadata.update(extra_info)
        return gen_chunk

    def _create_chat_result(
        self,
        response: dict[str, Any] | Any,
        generation_info: dict[str, Any] | None = None,
    ) -> ChatResult:
        result = super()._create_chat_result(response, generation_info)
        raw = response if isinstance(response, Mapping) else (
            response.model_dump() if hasattr(response, "model_dump") else {}
        )
        if isinstance(raw, Mapping) and result.generations:
            extra_meta: dict[str, Any] = {}
            if isinstance(raw.get("model"), str) and raw["model"].strip():
                extra_meta["model_name"] = raw["model"].strip()
            usage = raw.get("usage")
            if isinstance(usage, Mapping) and usage.get("cost") is not None:
                extra_meta["gateway_cost"] = usage["cost"]
            prov_meta = raw.get("provider_metadata") or raw.get("providerMetadata")
            if isinstance(prov_meta, Mapping):
                extra_meta["gateway_provider_metadata"] = dict(prov_meta)
                gw_meta = prov_meta.get("gateway")
                if isinstance(gw_meta, Mapping) and gw_meta.get("cost") is not None:
                    extra_meta["gateway_cost"] = gw_meta["cost"]
            if extra_meta:
                gen = result.generations[0]
                gen.generation_info = {**(gen.generation_info or {}), **extra_meta}
                gen.message.response_metadata.update(extra_meta)
        return result


def resolve_gateway_api_key() -> str | None:
    """Resolve non-empty AI Gateway API key or Vercel OIDC token from environment."""
    for env_name in ("AI_GATEWAY_API_KEY", "VERCEL_OIDC_TOKEN"):
        raw = os.getenv(env_name)
        if raw and raw.strip():
            return raw.strip()
    return None


def build_model(primary: str, fallbacks: Sequence[str]) -> GatewayChatOpenAI:
    """Instantiate a per-request ChatOpenAI client omitting temperature."""
    gateway: dict[str, Any] = {
        "models": list(fallbacks),
        "caching": "auto",
    }
    if os.getenv("GATEWAY_REPORTING_TAGS") == "1":
        gateway["tags"] = ["app:relay-studio-demo"]

    # Never pass temperature: anthropic/claude-*-5.5 rejects temperature parameters.
    return GatewayChatOpenAI(
        model=primary,
        base_url=AI_GATEWAY_BASE_URL,
        api_key=resolve_gateway_api_key(),
        max_tokens=MAX_OUTPUT_TOKENS,
        stream_usage=True,
        use_responses_api=False,
        extra_body={"providerOptions": {"gateway": gateway}},
    )


def build_system_prompt(state: DerivedTwinState) -> str:
    """Build an R4-sanitized operational system prompt with current Digital Twin numbers."""
    channel_lines = ", ".join(
        f"{ch.channel} (${ch.dailyBudget:,.2f}/day, {ch.roas:.2f}x ROAS, "
        f"{ch.brokenCreatives} broken URLs, {ch.utmViolations} UTM issues)"
        for ch in state.channels
    )
    campaign_lines = "; ".join(
        f"{c.campaignId} ({c.name}, {c.channel}, ${c.dailyBudget:,.2f}/day, {c.roas:.2f}x ROAS)"
        for c in state.campaigns
    )
    return (
        "You are Relay, the paid media and campaign operations assistant for a Marketing Manager at Fieldstone "
        "inside Relay Studio. Speak in plain, practical paid-media language focused on budget pacing, creative links, "
        "UTM attribution, pipeline, and return on ad spend (ROAS). Use exact dollar amounts, counts, and ROAS figures "
        "from tool outputs and the active campaign summary below.\n\n"
        "Communication & workspace rules:\n"
        "- Never expose engineering or infrastructure terms in chat replies: do NOT mention 'Digital Twin', 'SQL', "
        "'SQLite', 'Sandbox', 'Temporal', 'DAG', 'SSE', 'slug', 'workflowId', or raw cron syntax like '0 7 * * *'. "
        "Translate schedules into plain English (for example, 'every morning at 7:00 AM UTC').\n"
        "- Never invent non-existent pages, library dashboards, or filesystem paths. Relay Studio has two pages only: "
        "the main campaign workspace (`/`) and shared playbook links (`/p/[slug]`).\n"
        "- Recurring checks created via `compile_workflow` appear right in the conversation card AND are saved in the "
        "`Workflows` flyout button in the top bar, where the marketing manager can select any check by name, view its "
        "visual step-by-step flow, click `Preview check now`, or share it with teammates.\n\n"
        "Tool routing rules:\n"
        "- For broken 404 landing pages, ad status, or UTM tracking checks, call audit_campaign_hygiene.\n"
        "- For cross-channel or campaign return on ad spend (ROAS), spend, clicks, conversions, or pipeline breakdowns, "
        "call analyze_in_sandbox.\n"
        "- For shifting wasted spend or proposing daily budget changes, call propose_budget_reallocation. "
        "Budget proposals stay in draft until the marketing manager clicks Approve in the card.\n"
        "- For recurring morning checks, pacing alerts, or Slack/Sheets briefs, call compile_workflow "
        "(pass a clear marketing `name` such as 'Weekday Paid Social Link & Pacing Check' when appropriate).\n"
        "- When a budget proposal is approved or declined, confirm the decision and summarize the updated "
        "daily budgets and blended ROAS.\n\n"
        f"Active paid media snapshot (applied changes: {state.totals.appliedMutations}):\n"
        f"- Portfolio totals: {state.totals.campaignCount} campaigns, {state.totals.adGroupCount} ad groups, "
        f"${state.totals.dailyBudget:,.2f}/day budget, {state.totals.blendedRoas:.2f}x blended ROAS, "
        f"{state.totals.brokenCreatives} broken 404 ads, {state.totals.utmViolations} UTM tracking issues "
        f"(${state.totals.spendAtRiskPerDay:,.2f}/day spend at risk).\n"
        f"- Channels: {channel_lines}.\n"
        f"- Campaigns: {campaign_lines}."
    )


def _extract_chunk_text(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for item in content:
            if isinstance(item, str):
                parts.append(item)
            elif isinstance(item, Mapping) and item.get("type") == "text":
                txt = item.get("text")
                if isinstance(txt, str):
                    parts.append(txt)
        return "".join(parts)
    return ""


def _gateway_attempted_failover(
    primary_model: str,
    served_model: str,
    response_metadata: Mapping[str, Any],
) -> bool:
    if served_model != primary_model:
        return True
    for meta_key in ("gateway_provider_metadata", "gateway"):
        meta = response_metadata.get(meta_key)
        if not isinstance(meta, Mapping):
            continue
        gw = meta.get("gateway") if "gateway" in meta and isinstance(meta.get("gateway"), Mapping) else meta
        if isinstance(gw, Mapping):
            direct_attempts = gw.get("modelAttempts") or gw.get("attempts")
            if isinstance(direct_attempts, list) and len(direct_attempts) > 1:
                return True
            routing = gw.get("routing")
            if isinstance(routing, Mapping):
                attempts = routing.get("modelAttempts") or routing.get("attempts")
                if isinstance(attempts, list) and len(attempts) > 1:
                    return True
    return False


def build_agent_graph(
    *,
    route: RouteDecision,
    mutations: Sequence[Mutation | Mapping[str, Any]] = (),
    twin_state: DerivedTwinState | None = None,
    inject_failure: bool = False,
    data_dir: Path | None = None,
    model_factory: ModelFactory | None = None,
) -> Any:
    """Compile a stateless per-request LangGraph tool-calling agent (checkpointer=None)."""
    derived_state = (
        twin_state
        if twin_state is not None
        else compute_twin_state(mutations, data_dir=data_dir)
    )
    system_prompt = build_system_prompt(derived_state)
    tools = build_agent_tools(mutations, data_dir=data_dir)
    tool_map = {t.name: t for t in tools}
    factory: ModelFactory = model_factory if model_factory is not None else build_model
    is_live_gateway = model_factory is None

    async def model_node(state: AgentState) -> dict[str, Any]:
        if state["model_calls"] >= MAX_MODEL_CALLS:
            raise RuntimeError(f"Turn reached the maximum of {MAX_MODEL_CALLS} model calls.")

        if is_live_gateway:
            await ensure_model_prices_loaded()

        writer = get_stream_writer()
        writer({"kind": "step_start"})

        t0 = time.perf_counter()
        if inject_failure:
            try:
                raise SyntheticPrimaryOutageError(
                    f"Simulated 503 outage for primary model {route.primary_model}"
                )
            except SyntheticPrimaryOutageError:
                if not route.fallback_models:
                    raise
                active_primary = route.fallback_models[0]
                active_fallbacks = route.fallback_models[1:]
                failover_mode: FailoverMode = "simulated"
        else:
            active_primary = route.primary_model
            active_fallbacks = route.fallback_models
            failover_mode = "none"

        llm = factory(active_primary, active_fallbacks)
        bound_llm = llm.bind_tools(tools)
        prompt_messages: list[BaseMessage] = [
            SystemMessage(content=system_prompt),
            *state["messages"],
        ]

        accumulated_chunk: AIMessageChunk | None = None
        final_ai_msg: AIMessage | None = None
        last_meta: dict[str, Any] = {}
        last_usage: Mapping[str, Any] | None = None

        async for chunk in bound_llm.astream(prompt_messages):
            delta_text = _extract_chunk_text(getattr(chunk, "content", ""))
            if delta_text:
                writer({"kind": "text_delta", "delta": delta_text})

            chunk_meta = getattr(chunk, "response_metadata", None)
            if isinstance(chunk_meta, Mapping) and chunk_meta:
                last_meta.update(chunk_meta)
            chunk_usage = getattr(chunk, "usage_metadata", None)
            if isinstance(chunk_usage, Mapping) and chunk_usage:
                last_usage = chunk_usage

            if isinstance(chunk, AIMessageChunk):
                accumulated_chunk = (
                    chunk if accumulated_chunk is None else accumulated_chunk + chunk
                )
            elif isinstance(chunk, AIMessage):
                final_ai_msg = chunk

        latency_ms = max(1, round((time.perf_counter() - t0) * 1000))

        if final_ai_msg is None:
            if accumulated_chunk is not None:
                converted = message_chunk_to_message(accumulated_chunk)
                final_ai_msg = (
                    converted
                    if isinstance(converted, AIMessage)
                    else AIMessage(content=str(converted.content))
                )
            else:
                final_ai_msg = AIMessage(content="")

        merged_meta: dict[str, Any] = {
            **dict(getattr(final_ai_msg, "response_metadata", None) or {}),
            **last_meta,
        }
        usage_meta: Mapping[str, Any] = (
            getattr(final_ai_msg, "usage_metadata", None) or last_usage or {}
        )

        raw_served = merged_meta.get("model_name") or merged_meta.get("model")
        served_model = (
            raw_served.strip()
            if isinstance(raw_served, str) and raw_served.strip()
            else active_primary
        )

        if not inject_failure and _gateway_attempted_failover(
            route.primary_model, served_model, merged_meta
        ):
            failover_mode = "gateway"

        in_tokens = max(0, int(usage_meta.get("input_tokens") or 0))
        out_tokens = max(0, int(usage_meta.get("output_tokens") or 0))
        in_details = usage_meta.get("input_token_details")
        cached_tokens = 0
        cache_write_tokens = 0
        if isinstance(in_details, Mapping):
            cached_tokens = max(0, int(in_details.get("cache_read") or 0))
            cache_write_tokens = max(0, int(in_details.get("cache_creation") or 0))

        cost_usd, baseline_cost_usd = compute_turn_costs(
            served_model=served_model,
            tier=route.tier,
            input_tokens=in_tokens,
            cached_tokens=cached_tokens,
            cache_write_tokens=cache_write_tokens,
            output_tokens=out_tokens,
            gateway_reported_cost=merged_meta.get("gateway_cost"),
        )

        telemetry: dict[str, Any] = {
            "tier": route.tier,
            "routedBy": route.routed_by,
            "primaryModel": route.primary_model,
            "servedModel": served_model,
            "failover": failover_mode,
            "inputTokens": in_tokens,
            "cachedTokens": cached_tokens,
            "outputTokens": out_tokens,
            "costUsd": cost_usd,
            "baselineCostUsd": baseline_cost_usd,
            "latencyMs": latency_ms,
        }

        normalized_calls: list[dict[str, Any]] = []
        raw_tool_calls = getattr(final_ai_msg, "tool_calls", None) or []
        for tc in raw_tool_calls:
            tc_id = str(tc.get("id") or "").strip()
            if not tc_id:
                tc_id = f"call_{uuid4().hex[:10]}"
            tc_name = str(tc.get("name") or "").strip()
            tc_args = dict(tc["args"]) if isinstance(tc.get("args"), Mapping) else {}
            normalized_calls.append({"name": tc_name, "args": tc_args, "id": tc_id, "type": "tool_call"})

        if normalized_calls:
            final_ai_msg = AIMessage(
                content=final_ai_msg.content,
                tool_calls=normalized_calls,
                response_metadata=merged_meta,
            )
            for tc in normalized_calls:
                writer(
                    {
                        "kind": "tool_input",
                        "toolCallId": tc["id"],
                        "toolName": tc["name"],
                        "input": tc["args"],
                    }
                )
            return {
                "messages": [final_ai_msg],
                "model_calls": state["model_calls"] + 1,
                "pending_telemetry": telemetry,
            }

        writer({"kind": "telemetry", "data": telemetry})
        writer({"kind": "step_finish"})
        return {
            "messages": [final_ai_msg],
            "model_calls": state["model_calls"] + 1,
            "pending_telemetry": None,
        }

    async def tools_node(state: AgentState) -> dict[str, Any]:
        writer = get_stream_writer()
        last_msg = state["messages"][-1]
        tool_calls = getattr(last_msg, "tool_calls", None) or []
        tool_messages: list[ToolMessage] = []

        for tc in tool_calls:
            call_id = str(tc["id"])
            tool_name = str(tc["name"])
            tool_args = tc.get("args") if isinstance(tc.get("args"), Mapping) else {}
            target_tool = tool_map.get(tool_name)
            if target_tool is None:
                err_msg = f"Unknown tool requested: {tool_name}"
                writer(
                    {
                        "kind": "tool_error",
                        "toolCallId": call_id,
                        "errorText": err_msg,
                    }
                )
                tool_messages.append(
                    ToolMessage(
                        content=json.dumps({"error": err_msg}),
                        tool_call_id=call_id,
                        name=tool_name,
                        status="error",
                    )
                )
                continue

            try:
                if tool_name == "analyze_in_sandbox":
                    writer(
                        {
                            "kind": "sandbox_status",
                            "data": {
                                "toolCallId": call_id,
                                "stage": "provisioning",
                                "label": "Provisioning ephemeral microVM",
                            },
                        }
                    )
                    writer(
                        {
                            "kind": "sandbox_status",
                            "data": {
                                "toolCallId": call_id,
                                "stage": "executing_sql",
                                "label": "Running parameterized sqlite3 over CSV snapshot",
                            },
                        }
                    )
                result = await target_tool.ainvoke(dict(tool_args))
                writer(
                    {
                        "kind": "tool_output",
                        "toolCallId": call_id,
                        "output": result,
                    }
                )
                if tool_name == "analyze_in_sandbox":
                    writer(
                        {
                            "kind": "sandbox_status",
                            "data": {
                                "toolCallId": call_id,
                                "stage": "completed",
                                "label": "MicroVM complete · compact JSON returned",
                            },
                        }
                    )
                tool_messages.append(
                    ToolMessage(
                        content=json.dumps(result, separators=(",", ":"), allow_nan=False),
                        tool_call_id=call_id,
                        name=tool_name,
                    )
                )
            except (ValidationError, ValueError, KeyError, TypeError, ToolException, RuntimeError) as exc:
                err_text = str(exc) or f"Tool {tool_name} failed"
                writer(
                    {
                        "kind": "tool_error",
                        "toolCallId": call_id,
                        "errorText": err_text,
                    }
                )
                tool_messages.append(
                    ToolMessage(
                        content=json.dumps({"error": err_text}),
                        tool_call_id=call_id,
                        name=tool_name,
                        status="error",
                    )
                )

        if state.get("pending_telemetry") is not None:
            writer({"kind": "telemetry", "data": state["pending_telemetry"]})
        writer({"kind": "step_finish"})
        return {
            "messages": tool_messages,
            "pending_telemetry": None,
        }

    async def limit_reached_node(state: AgentState) -> dict[str, Any]:
        writer = get_stream_writer()
        writer(
            {
                "kind": "error",
                "errorText": f"Turn reached the maximum of {MAX_MODEL_CALLS} model calls.",
            }
        )
        return {"pending_telemetry": None}

    def route_after_model(state: AgentState) -> Literal["tools", "__end__"]:
        last_msg = state["messages"][-1]
        if getattr(last_msg, "tool_calls", None):
            return "tools"
        return END

    def route_after_tools(state: AgentState) -> Literal["model", "limit_reached"]:
        if state["model_calls"] >= MAX_MODEL_CALLS:
            return "limit_reached"
        return "model"

    workflow = StateGraph(AgentState)
    workflow.add_node("model", model_node)
    workflow.add_node("tools", tools_node)
    workflow.add_node("limit_reached", limit_reached_node)
    workflow.add_edge(START, "model")
    workflow.add_conditional_edges("model", route_after_model)
    workflow.add_conditional_edges("tools", route_after_tools)
    workflow.add_edge("limit_reached", END)
    return workflow.compile(checkpointer=None)
