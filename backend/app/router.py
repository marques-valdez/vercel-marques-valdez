"""Two-tier hybrid AI Gateway model router (card hint -> Decisions API -> $0 LLM -> keyword).

Architecture role:
    Selects `fast` vs. `reasoning` tier for every Relay Studio turn:
    1. Playbook card clicks pass an explicit `tier_hint` -> `<1ms`, `$0`
       (`routed_by="card"`).
    2. Free-form prompts use `route_turn_async()` with a 1.5s budget:
       - Primary (`SEMANTIC_ROUTER_MODE="decisions"`, default): calls Vercel AI
         Gateway's OpenAI-compatible Decisions API (`POST /v1/decisions`,
         `baseten/joey-1`, `$0.01/1M` input tokens, `$0` output) to classify
         intent with a typed `choice` + confidence score (`routed_by="decision"`).
         Low-confidence results (`< 0.60`) fall back to deterministic keyword
         matching (`REASONING_KEYWORD_RE` -> `fast`).
       - Credit-exhausted fallback (`402`/`403`) or `SEMANTIC_ROUTER_MODE="free-llm"`:
         calls `$0` free-tier chat completions (`FAST_MODELS[0]`, `max_tokens=24`)
         for JSON tier classification (`routed_by="semantic"`).
    3. Any timeout, network failure, or offline/test mode falls back cleanly to
       `REASONING_KEYWORD_RE` (`routed_by="keyword"`), so a turn never fails
       because of the router.

Configuration invariant:
    Model IDs are read from `FAST_MODELS`, `REASONING_MODELS`, and
    `DECISION_ROUTER_MODEL` env vars so operators can swap models without code
    changes.
"""

from __future__ import annotations

from dataclasses import dataclass
import json
import os
import re
from typing import Any, Final, Literal, Mapping

import httpx

TierName = Literal["fast", "reasoning"]
RoutedBy = Literal["card", "decision", "semantic", "keyword"]
SemanticRouterMode = Literal["decisions", "free-llm", "keyword"]

AI_GATEWAY_DECISIONS_URL: Final[str] = "https://ai-gateway.vercel.sh/v1/decisions"
AI_GATEWAY_CHAT_URL: Final[str] = "https://ai-gateway.vercel.sh/v1/chat/completions"

DEFAULT_DECISION_ROUTER_MODEL: Final[str] = "baseten/joey-1"
DEFAULT_DECISION_FALLBACK_MODELS: Final[tuple[str, ...]] = ("liquid/d1",)
DEFAULT_SEMANTIC_ROUTER_TIMEOUT_SECONDS: Final[float] = 1.5
DECISION_MIN_CONFIDENCE: Final[float] = 0.60

DEFAULT_FAST_MODELS: Final[tuple[str, ...]] = (
    "nvidia/nemotron-3.5-lightning-free",
    "reflection/beam-free",
    "stealth/glyph-cluster",
)

DEFAULT_REASONING_MODELS: Final[tuple[str, ...]] = (
    "reflection/beam-free",
    "humansand/ampersand-v0.1",
    "recursive/flint-v1.0",
)

REASONING_KEYWORD_RE: Final[re.Pattern[str]] = re.compile(
    r"realloc|budget|shift|strategy|plan|workflow|schedule|guardrail",
    re.IGNORECASE,
)

_DECISION_QUESTION: Final[dict[str, Any]] = {
    "type": "choice",
    "name": "tier",
    "instructions": (
        "Classify whether this paid-media campaign operations request needs "
        "the fast tier or the reasoning tier."
    ),
    "choices": [
        {
            "value": "fast",
            "description": (
                "Read-only lookups, creative 404 or UTM hygiene audits, or "
                "channel and campaign ROAS summaries."
            ),
        },
        {
            "value": "reasoning",
            "description": (
                "Budget reallocations, spend shifts, strategic optimization "
                "plans, recurring workflow scheduling, or wasted-spend guardrails."
            ),
        },
    ],
}

_FREE_LLM_SYSTEM_PROMPT: Final[str] = (
    "You classify paid-media marketing requests into two model tiers. "
    'Respond ONLY with compact JSON: {"tier":"fast"} or {"tier":"reasoning"}. '
    'Use "fast" for read-only lookups, 404/UTM audits, or ROAS summaries. '
    'Use "reasoning" for budget shifts, reallocations, strategy plans, '
    "recurring workflows, or alert guardrails."
)


@dataclass(frozen=True, slots=True)
class RouteDecision:
    """Resolved model tier, routing source, ordered model list, and savings baseline."""

    tier: TierName
    routed_by: RoutedBy
    primary_model: str
    fallback_models: tuple[str, ...]
    baseline_model: str
    routing_confidence: float | None = None
    router_model: str | None = None


def _parse_model_list(env_var: str, default: tuple[str, ...]) -> tuple[str, ...]:
    raw = os.getenv(env_var, "")
    parsed = tuple(
        dict.fromkeys(part.strip() for part in raw.split(",") if part.strip())
    )
    return parsed if parsed else default


def get_tier_models(tier: TierName) -> tuple[str, ...]:
    """Return primary + fallback model IDs for the requested tier."""
    if tier == "reasoning":
        return _parse_model_list("REASONING_MODELS", DEFAULT_REASONING_MODELS)
    return _parse_model_list("FAST_MODELS", DEFAULT_FAST_MODELS)


def get_reasoning_baseline_model() -> str:
    """Return the primary reasoning-tier model ID used as the sole cost baseline."""
    return get_tier_models("reasoning")[0]


def get_semantic_router_mode() -> SemanticRouterMode:
    """Return configured semantic router mode (decisions | free-llm | keyword)."""
    raw = (os.getenv("SEMANTIC_ROUTER_MODE") or "decisions").strip().lower()
    if raw in ("decisions", "free-llm", "keyword"):
        return raw  # type: ignore[return-value]
    return "decisions"


def get_decision_router_model() -> str:
    """Return configured decision model slug for POST /v1/decisions."""
    raw = (os.getenv("DECISION_ROUTER_MODEL") or "").strip()
    return raw if raw else DEFAULT_DECISION_ROUTER_MODEL


def get_semantic_router_timeout() -> float:
    """Return timeout budget (seconds) for semantic routing calls."""
    raw = (os.getenv("SEMANTIC_ROUTER_TIMEOUT_SECONDS") or "").strip()
    if not raw:
        return DEFAULT_SEMANTIC_ROUTER_TIMEOUT_SECONDS
    try:
        parsed = float(raw)
        return parsed if 0.2 <= parsed <= 10.0 else DEFAULT_SEMANTIC_ROUTER_TIMEOUT_SECONDS
    except ValueError:
        return DEFAULT_SEMANTIC_ROUTER_TIMEOUT_SECONDS


def _build_route_decision(
    tier: TierName,
    routed_by: RoutedBy,
    *,
    routing_confidence: float | None = None,
    router_model: str | None = None,
) -> RouteDecision:
    models = get_tier_models(tier)
    return RouteDecision(
        tier=tier,
        routed_by=routed_by,
        primary_model=models[0],
        fallback_models=models[1:],
        baseline_model=get_reasoning_baseline_model(),
        routing_confidence=routing_confidence,
        router_model=router_model,
    )


def route_turn(
    user_text: str,
    tier_hint: TierName | None = None,
) -> RouteDecision:
    """Synchronous deterministic router: card hint first, then keyword regex -> fast."""
    if tier_hint in ("fast", "reasoning"):
        return _build_route_decision(tier_hint, "card")

    tier: TierName = (
        "reasoning" if REASONING_KEYWORD_RE.search(user_text or "") else "fast"
    )
    return _build_route_decision(tier, "keyword")


def _parse_tier_from_llm_text(raw_text: str) -> TierName | None:
    cleaned = raw_text.strip()
    if not cleaned:
        return None
    try:
        parsed = json.loads(cleaned)
        if isinstance(parsed, Mapping):
            tier_val = str(parsed.get("tier") or "").strip().lower()
            if tier_val in ("fast", "reasoning"):
                return tier_val  # type: ignore[return-value]
    except json.JSONDecodeError:
        pass
    match = re.search(r"\b(reasoning|fast)\b", cleaned, re.IGNORECASE)
    if match:
        return match.group(1).lower()  # type: ignore[return-value]
    return None


async def _classify_via_decisions_api(
    client: httpx.AsyncClient,
    user_text: str,
    api_key: str,
    timeout: float,
) -> tuple[RouteDecision | None, bool]:
    """Call Vercel AI Gateway POST /v1/decisions.

    Returns (decision, should_fallback_to_free_llm).
    """
    decision_model = get_decision_router_model()
    fallbacks = [m for m in DEFAULT_DECISION_FALLBACK_MODELS if m != decision_model]
    payload: dict[str, Any] = {
        "model": decision_model,
        "input": user_text[:2000],
        "questions": [_DECISION_QUESTION],
    }
    if fallbacks:
        payload["providerOptions"] = {"gateway": {"models": fallbacks}}

    try:
        resp = await client.post(
            AI_GATEWAY_DECISIONS_URL,
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            },
            json=payload,
            timeout=timeout,
        )
    except Exception:
        return None, False

    if resp.status_code in (402, 403):
        return None, True
    if resp.status_code != 200:
        return None, False

    try:
        body = resp.json()
    except Exception:
        return None, False

    answers = body.get("answers")
    if not isinstance(answers, list) or not answers or not isinstance(answers[0], Mapping):
        return None, False

    first = answers[0]
    choice = str(first.get("choice") or "").strip().lower()
    if choice not in ("fast", "reasoning"):
        return None, False

    raw_conf = first.get("confidence")
    confidence: float | None = None
    if isinstance(raw_conf, (int, float)) and not isinstance(raw_conf, bool):
        confidence = max(0.0, min(1.0, round(float(raw_conf), 4)))

    # Low-confidence classifications fall back to deterministic keyword -> fast.
    if confidence is not None and confidence < DECISION_MIN_CONFIDENCE:
        return None, False

    served_model = str(body.get("model") or decision_model).strip() or decision_model
    return (
        _build_route_decision(
            choice,  # type: ignore[arg-type]
            "decision",
            routing_confidence=confidence,
            router_model=served_model,
        ),
        False,
    )


async def _classify_via_free_llm(
    client: httpx.AsyncClient,
    user_text: str,
    api_key: str,
    timeout: float,
) -> RouteDecision | None:
    """Call $0 free-tier fast model for JSON tier classification."""
    classifier_model = get_tier_models("fast")[0]
    payload: dict[str, Any] = {
        "model": classifier_model,
        "max_tokens": 24,
        "messages": [
            {"role": "system", "content": _FREE_LLM_SYSTEM_PROMPT},
            {"role": "user", "content": user_text[:2000]},
        ],
    }

    try:
        resp = await client.post(
            AI_GATEWAY_CHAT_URL,
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            },
            json=payload,
            timeout=timeout,
        )
    except Exception:
        return None

    if resp.status_code != 200:
        return None

    try:
        body = resp.json()
        choices = body.get("choices") or []
        content = choices[0]["message"]["content"] if choices else ""
    except Exception:
        return None

    tier = _parse_tier_from_llm_text(str(content or ""))
    if tier is None:
        return None

    served_model = str(body.get("model") or classifier_model).strip() or classifier_model
    return _build_route_decision(tier, "semantic", router_model=served_model)


async def route_turn_async(
    user_text: str,
    tier_hint: TierName | None = None,
    *,
    api_key: str | None = None,
    http_client: httpx.AsyncClient | None = None,
) -> RouteDecision:
    """Hybrid async router: card hint -> Decisions API -> $0 free LLM -> keyword fallback."""
    if tier_hint in ("fast", "reasoning"):
        return _build_route_decision(tier_hint, "card")

    mode = get_semantic_router_mode()
    cleaned_text = (user_text or "").strip()
    if mode == "keyword" or not api_key or not cleaned_text:
        return route_turn(cleaned_text)

    timeout = get_semantic_router_timeout()
    owns_client = http_client is None
    client = http_client or httpx.AsyncClient()
    try:
        if mode == "decisions":
            decision, fallback_to_free = await _classify_via_decisions_api(
                client, cleaned_text, api_key, timeout
            )
            if decision is not None:
                return decision
            if fallback_to_free:
                free_decision = await _classify_via_free_llm(
                    client, cleaned_text, api_key, timeout
                )
                if free_decision is not None:
                    return free_decision
        elif mode == "free-llm":
            free_decision = await _classify_via_free_llm(
                client, cleaned_text, api_key, timeout
            )
            if free_decision is not None:
                return free_decision
    finally:
        if owns_client:
            await client.aclose()

    return route_turn(cleaned_text)


select_route = route_turn
