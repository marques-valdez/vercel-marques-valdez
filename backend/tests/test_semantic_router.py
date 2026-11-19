"""Tests for hybrid semantic routing (Decisions API -> $0 free LLM -> keyword fallback)."""

from __future__ import annotations

import httpx
import pytest

from app import router


@pytest.mark.asyncio
async def test_card_tier_hint_short_circuits_without_http_calls() -> None:
    called = False

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal called
        called = True
        return httpx.Response(500)

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        decision = await router.route_turn_async(
            "Rebalance my Q4 spend mix",
            tier_hint="fast",
            api_key="test-key",
            http_client=client,
        )

    assert called is False
    assert decision.tier == "fast"
    assert decision.routed_by == "card"
    assert decision.routing_confidence is None


@pytest.mark.asyncio
async def test_decisions_api_routes_semantic_prompt_with_confidence(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("SEMANTIC_ROUTER_MODE", "decisions")

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url == httpx.URL(router.AI_GATEWAY_DECISIONS_URL)
        return httpx.Response(
            200,
            json={
                "model": "baseten/joey-1",
                "answers": [
                    {
                        "type": "choice",
                        "name": "tier",
                        "choice": "reasoning",
                        "confidence": 0.94,
                    }
                ],
            },
        )

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        decision = await router.route_turn_async(
            "Which channels are wasting money and how should I rebalance my ad mix?",
            api_key="test-key",
            http_client=client,
        )

    assert decision.tier == "reasoning"
    assert decision.routed_by == "decision"
    assert decision.routing_confidence == 0.94
    assert decision.router_model == "baseten/joey-1"


@pytest.mark.asyncio
async def test_decisions_low_confidence_falls_back_to_keyword_then_fast(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("SEMANTIC_ROUTER_MODE", "decisions")

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "model": "baseten/joey-1",
                "answers": [
                    {
                        "type": "choice",
                        "name": "tier",
                        "choice": "reasoning",
                        "confidence": 0.42,
                    }
                ],
            },
        )

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        # No reasoning keyword -> falls back to keyword -> fast
        d_fast = await router.route_turn_async(
            "Check if any ads are broken",
            api_key="test-key",
            http_client=client,
        )
        # Has reasoning keyword ("budget") -> falls back to keyword -> reasoning
        d_reason = await router.route_turn_async(
            "Adjust my daily budget across channels",
            api_key="test-key",
            http_client=client,
        )

    assert d_fast.tier == "fast"
    assert d_fast.routed_by == "keyword"
    assert d_reason.tier == "reasoning"
    assert d_reason.routed_by == "keyword"


@pytest.mark.asyncio
async def test_decisions_402_cascades_to_free_llm_classifier(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("SEMANTIC_ROUTER_MODE", "decisions")
    urls_called: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        urls_called.append(str(request.url))
        if request.url == httpx.URL(router.AI_GATEWAY_DECISIONS_URL):
            return httpx.Response(402, json={"error": "Insufficient credits"})
        return httpx.Response(
            200,
            json={
                "model": "nvidia/nemotron-3.5-lightning-free",
                "choices": [{"message": {"content": '{"tier":"reasoning"}'}}],
            },
        )

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        decision = await router.route_turn_async(
            "How should I optimize my Q4 paid social mix?",
            api_key="test-key",
            http_client=client,
        )

    assert urls_called == [router.AI_GATEWAY_DECISIONS_URL, router.AI_GATEWAY_CHAT_URL]
    assert decision.tier == "reasoning"
    assert decision.routed_by == "semantic"
    assert decision.router_model == "nvidia/nemotron-3.5-lightning-free"


@pytest.mark.asyncio
async def test_free_llm_mode_skips_decisions_and_timeout_falls_back_to_keyword(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("SEMANTIC_ROUTER_MODE", "free-llm")

    def timeout_handler(request: httpx.Request) -> httpx.Response:
        assert request.url == httpx.URL(router.AI_GATEWAY_CHAT_URL)
        raise httpx.ReadTimeout("timeout")

    async with httpx.AsyncClient(transport=httpx.MockTransport(timeout_handler)) as client:
        decision = await router.route_turn_async(
            "Build a daily pacing guardrail",
            api_key="test-key",
            http_client=client,
        )

    assert decision.tier == "reasoning"
    assert decision.routed_by == "keyword"
