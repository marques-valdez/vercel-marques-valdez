"""Two-tier deterministic AI Gateway model router for Relay Studio (zero extra model calls)."""

from __future__ import annotations

from dataclasses import dataclass
import os
import re
from typing import Final, Literal

TierName = Literal["fast", "reasoning"]
RoutedBy = Literal["card", "keyword"]

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


@dataclass(frozen=True, slots=True)
class RouteDecision:
    """Resolved model tier, routing source, ordered model list, and savings baseline."""

    tier: TierName
    routed_by: RoutedBy
    primary_model: str
    fallback_models: tuple[str, ...]
    baseline_model: str


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


def route_turn(
    user_text: str,
    tier_hint: TierName | None = None,
) -> RouteDecision:
    """Select fast or reasoning tier from card hint or keyword match."""
    if tier_hint in ("fast", "reasoning"):
        tier: TierName = tier_hint
        routed_by: RoutedBy = "card"
    else:
        tier = "reasoning" if REASONING_KEYWORD_RE.search(user_text or "") else "fast"
        routed_by = "keyword"

    models = get_tier_models(tier)
    return RouteDecision(
        tier=tier,
        routed_by=routed_by,
        primary_model=models[0],
        fallback_models=models[1:],
        baseline_model=get_reasoning_baseline_model(),
    )


select_route = route_turn
