"""AI Gateway live model pricing loader with pinned 2026-11-17 fallback table.

Why both live and pinned pricing exist:
    AI Gateway exposes live per-token pricing at `https://ai-gateway.vercel.sh/v1/models`.
    We fetch and cache that catalog at runtime (`pricingSource="live"`) so cost
    and savings telemetry stay current, while retaining a pinned fallback table
    (`PINNED_PRICES_2026_11_17`) so local/offline runs and unit tests remain
    deterministic without failing if the catalog endpoint is unreachable.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
import math
import os
import threading
import time
from typing import Any, Final, Literal, Mapping
import weakref

import httpx

from app.router import DEFAULT_FAST_MODELS, DEFAULT_REASONING_MODELS, get_reasoning_baseline_model

MODELS_ENDPOINT: Final[str] = "https://ai-gateway.vercel.sh/v1/models"
PINNED_PRICING_SOURCE: Final[Literal["pinned-2026-11-17"]] = "pinned-2026-11-17"
LIVE_PRICING_SOURCE: Final[Literal["live"]] = "live"
PricingSource = Literal["live", "pinned-2026-11-17"]


@dataclass(frozen=True, slots=True)
class ModelPrice:
    """Per-token USD rates for input, output, and optional prompt cache operations."""

    input_per_token: float
    output_per_token: float
    cache_read_per_token: float | None = None
    cache_write_per_token: float | None = None


PINNED_PRICES_2026_11_17: Final[dict[str, ModelPrice]] = {
    "nvidia/nemotron-3.5-lightning-free": ModelPrice(
        input_per_token=0.0,
        output_per_token=0.0,
        cache_read_per_token=0.0,
    ),
    "reflection/beam-free": ModelPrice(
        input_per_token=0.0,
        output_per_token=0.0,
        cache_read_per_token=0.0,
    ),
    "stealth/glyph-cluster": ModelPrice(
        input_per_token=0.0,
        output_per_token=0.0,
        cache_read_per_token=0.0,
    ),
    "humansand/ampersand-v0.1": ModelPrice(
        input_per_token=0.0,
        output_per_token=0.0,
        cache_read_per_token=0.0,
    ),
    "recursive/flint-v1.0": ModelPrice(
        input_per_token=0.0,
        output_per_token=0.0,
        cache_read_per_token=0.0,
    ),
    "google/gemini-4-hydrogen": ModelPrice(
        input_per_token=0.0000015,
        output_per_token=0.0000075,
        cache_read_per_token=0.000000075,
    ),
    "google/gemini-4-argon": ModelPrice(
        input_per_token=0.000002,
        output_per_token=0.00001,
        cache_read_per_token=0.0000001,
    ),
    "google/gemini-3.1-flash-lite": ModelPrice(
        input_per_token=0.00000025,
        output_per_token=0.0000015,
        cache_read_per_token=0.00000003,
    ),
    "anthropic/claude-haiku-5.5": ModelPrice(
        input_per_token=0.0000001,
        output_per_token=0.0000005,
        cache_read_per_token=0.00000001,
        cache_write_per_token=0.000000125,
    ),
    "google/gemini-2.5-flash": ModelPrice(
        input_per_token=0.0000003,
        output_per_token=0.0000025,
        cache_read_per_token=0.00000003,
    ),
    "anthropic/claude-sonnet-5.5": ModelPrice(
        input_per_token=0.000002,
        output_per_token=0.00001,
        cache_read_per_token=0.0000001,
        cache_write_per_token=0.0000025,
    ),
    "google/gemini-3.1-pro-preview": ModelPrice(
        input_per_token=0.000002,
        output_per_token=0.000012,
        cache_read_per_token=0.0000002,
    ),
    "google/gemini-2.5-pro": ModelPrice(
        input_per_token=0.00000125,
        output_per_token=0.00001,
        cache_read_per_token=0.000000125,
    ),
}

PRICING_CACHE_TTL_SECONDS: Final[float] = 3600.0
_live_prices: dict[str, ModelPrice] | None = None
_fetched_at: float | None = None
_state_lock = threading.Lock()
_loop_locks: weakref.WeakValueDictionary[int, asyncio.Lock] = (
    weakref.WeakValueDictionary()
)


def _parse_rate(raw: Any) -> float | None:
    if raw is None or isinstance(raw, bool):
        return None
    try:
        val = float(raw)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(val) or val < 0.0:
        return None
    return val


def parse_models_catalog_payload(payload: Any) -> dict[str, ModelPrice]:
    """Parse AI Gateway /v1/models JSON into a ModelPrice lookup dictionary."""
    if not isinstance(payload, Mapping):
        return {}
    items = payload.get("data")
    if not isinstance(items, list):
        return {}

    parsed: dict[str, ModelPrice] = {}
    for entry in items:
        if not isinstance(entry, Mapping):
            continue
        model_id = entry.get("id")
        pricing = entry.get("pricing")
        if not isinstance(model_id, str) or not model_id.strip() or not isinstance(pricing, Mapping):
            continue
        in_rate = _parse_rate(pricing.get("input"))
        out_rate = _parse_rate(pricing.get("output"))
        if in_rate is None or out_rate is None:
            continue
        cache_read = _parse_rate(pricing.get("input_cache_read"))
        cache_write = _parse_rate(pricing.get("input_cache_write"))
        parsed[model_id.strip()] = ModelPrice(
            input_per_token=in_rate,
            output_per_token=out_rate,
            cache_read_per_token=cache_read,
            cache_write_per_token=cache_write,
        )
    return parsed


def get_pricing_source() -> PricingSource:
    """Return active pricing source synchronously without blocking health checks."""
    with _state_lock:
        return LIVE_PRICING_SOURCE if _live_prices is not None else PINNED_PRICING_SOURCE


def reset_pricing_cache() -> None:
    """Reset module-memory pricing state (used in isolated unit tests)."""
    global _live_prices, _fetched_at
    with _state_lock:
        _live_prices = None
        _fetched_at = None
        _loop_locks.clear()


async def ensure_model_prices_loaded() -> PricingSource:
    """Fetch AI Gateway /v1/models with TTL caching, falling back to pinned 2026-11-17 rates."""
    global _live_prices, _fetched_at
    if os.getenv("PRICING_OFFLINE", "").strip().lower() in {"1", "true", "yes"}:
        return get_pricing_source()

    now = time.monotonic()
    with _state_lock:
        if _fetched_at is not None and (now - _fetched_at) < PRICING_CACHE_TTL_SECONDS:
            return LIVE_PRICING_SOURCE if _live_prices is not None else PINNED_PRICING_SOURCE
        loop = asyncio.get_running_loop()
        loop_id = id(loop)
        loop_lock = _loop_locks.get(loop_id)
        if loop_lock is None:
            loop_lock = asyncio.Lock()
            _loop_locks[loop_id] = loop_lock

    async with loop_lock:
        now = time.monotonic()
        with _state_lock:
            if _fetched_at is not None and (now - _fetched_at) < PRICING_CACHE_TTL_SECONDS:
                return LIVE_PRICING_SOURCE if _live_prices is not None else PINNED_PRICING_SOURCE

        loaded: dict[str, ModelPrice] | None = None
        fetch_completed = False
        try:
            async with httpx.AsyncClient(
                timeout=httpx.Timeout(1.5, connect=0.8)
            ) as client:
                resp = await client.get(MODELS_ENDPOINT)
                if resp.status_code == 200:
                    loaded = parse_models_catalog_payload(resp.json()) or None
            fetch_completed = True
        except Exception:
            fetch_completed = True
        finally:
            if fetch_completed or loaded is not None:
                with _state_lock:
                    if loaded is not None:
                        _live_prices = loaded
                    _fetched_at = time.monotonic()

    return get_pricing_source()


def get_model_price(
    model_id: str,
    *,
    fallback_tier: Literal["fast", "reasoning"] = "fast",
) -> ModelPrice:
    """Look up per-token rates from live catalog, pinned table, or tier primary fallback."""
    cleaned = (model_id or "").strip()
    with _state_lock:
        live_prices = _live_prices
    if live_prices is not None and cleaned in live_prices:
        return live_prices[cleaned]
    if cleaned in PINNED_PRICES_2026_11_17:
        return PINNED_PRICES_2026_11_17[cleaned]
    if cleaned.endswith(":free") or cleaned.endswith("-free"):
        return ModelPrice(0.0, 0.0, 0.0, 0.0)
    default_key = (
        DEFAULT_REASONING_MODELS[0]
        if fallback_tier == "reasoning"
        else DEFAULT_FAST_MODELS[0]
    )
    return PINNED_PRICES_2026_11_17[default_key]


def _clean_usd(value: float) -> float:
    rounded = round(float(value), 8)
    return 0.0 if rounded == 0.0 or not math.isfinite(rounded) else max(0.0, rounded)


def compute_token_cost_usd(
    model_id: str,
    *,
    input_tokens: int,
    cached_tokens: int = 0,
    cache_write_tokens: int = 0,
    output_tokens: int = 0,
    fallback_tier: Literal["fast", "reasoning"] = "fast",
) -> float:
    """Price token counts where input_tokens includes cached read/write tokens."""
    price = get_model_price(model_id, fallback_tier=fallback_tier)
    in_tok = max(0, int(input_tokens))
    cached_tok = max(0, min(int(cached_tokens), in_tok))
    write_tok = max(0, min(int(cache_write_tokens), in_tok - cached_tok))
    uncached_tok = max(0, in_tok - cached_tok - write_tok)
    out_tok = max(0, int(output_tokens))

    read_rate = (
        price.cache_read_per_token
        if price.cache_read_per_token is not None
        else price.input_per_token
    )
    write_rate = (
        price.cache_write_per_token
        if price.cache_write_per_token is not None
        else price.input_per_token
    )
    raw_cost = (
        uncached_tok * price.input_per_token
        + cached_tok * read_rate
        + write_tok * write_rate
        + out_tok * price.output_per_token
    )
    return _clean_usd(raw_cost)


def compute_turn_costs(
    *,
    served_model: str,
    tier: Literal["fast", "reasoning"],
    input_tokens: int,
    cached_tokens: int = 0,
    cache_write_tokens: int = 0,
    output_tokens: int = 0,
    gateway_reported_cost: Any = None,
) -> tuple[float, float]:
    """Return (costUsd, baselineCostUsd) priced against REASONING_MODELS[0]."""
    reported = _parse_rate(gateway_reported_cost)
    if reported is not None:
        cost_usd = _clean_usd(reported)
    else:
        cost_usd = compute_token_cost_usd(
            served_model,
            input_tokens=input_tokens,
            cached_tokens=cached_tokens,
            cache_write_tokens=cache_write_tokens,
            output_tokens=output_tokens,
            fallback_tier=tier,
        )

    baseline_model = get_reasoning_baseline_model()
    if served_model == baseline_model and reported is not None:
        baseline_cost_usd = cost_usd
    else:
        baseline_cost_usd = compute_token_cost_usd(
            baseline_model,
            input_tokens=input_tokens,
            cached_tokens=cached_tokens,
            cache_write_tokens=cache_write_tokens,
            output_tokens=output_tokens,
            fallback_tier="reasoning",
        )
    return cost_usd, baseline_cost_usd
