"""Endpoint, workflow SSE, message cap, 422 NaN/surrogate, and 429 rate-limiter tests."""

from __future__ import annotations

import json
from typing import Any

from fastapi.testclient import TestClient
import pytest
from vercel import sandbox
from vercel.sandbox import CompletedCommand, NetworkPolicy

from app.main import (
    RATE_LIMIT_MAX_REQUESTS,
    RATE_LIMIT_MAX_TRACKED_IPS,
    SlidingWindowRateLimiter,
    app,
    reset_rate_limiter,
)
from app.workflow import CANONICAL_WORKFLOW_NODES


def _parse_sse_events(raw_text: str) -> tuple[list[dict[str, Any]], bool]:
    blocks = [b for b in raw_text.split("\n\n") if b.strip()]
    events: list[dict[str, Any]] = []
    saw_done = False
    for idx, blk in enumerate(blocks):
        assert blk.startswith("data: ")
        data_str = blk[len("data: ") :]
        if data_str == "[DONE]":
            assert idx == len(blocks) - 1
            saw_done = True
        else:
            obj = json.loads(data_str)
            json.dumps(obj, allow_nan=False)
            events.append(obj)
    return events, saw_done


@pytest.fixture(autouse=True)
def _reset_limiter_between_tests(monkeypatch: pytest.MonkeyPatch):
    reset_rate_limiter()
    monkeypatch.setenv("SANDBOX_DISABLED", "1")
    monkeypatch.delenv("AI_GATEWAY_API_KEY", raising=False)
    monkeypatch.delenv("VERCEL_OIDC_TOKEN", raising=False)
    yield
    reset_rate_limiter()


def test_health_endpoint_fields_and_python_312(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("VERCEL_ENV", raising=False)
    monkeypatch.delenv("VERCEL_DEPLOYMENT_ID", raising=False)
    monkeypatch.delenv("VERCEL_GIT_COMMIT_SHA", raising=False)

    client = TestClient(app)
    resp = client.get("/api/agent/health")
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "ok"
    assert body["pythonVersion"].startswith("3.12.")
    assert body["vercelEnv"] == "development"
    assert body["deploymentId"] == "local"
    assert body["commitSha"] == "local"
    assert body["pricingSource"] in {"pinned-2026-11-17", "live"}
    assert body["sandboxAvailable"] is False

    monkeypatch.setenv("VERCEL_ENV", "preview")
    monkeypatch.setenv("VERCEL_DEPLOYMENT_ID", "dpl_relay_preview_01")
    monkeypatch.setenv("VERCEL_GIT_COMMIT_SHA", "abc1234def5678")
    monkeypatch.setenv("SANDBOX_DISABLED", "0")
    monkeypatch.setenv("VERCEL_TOKEN", "tok_preview")
    monkeypatch.setenv("VERCEL_PROJECT_ID", "prj_relay")
    monkeypatch.setenv("VERCEL_TEAM_ID", "team_relay")

    preview_resp = client.get("/api/agent/health")
    assert preview_resp.status_code == 200
    preview_body = preview_resp.json()
    assert preview_body["vercelEnv"] == "preview"
    assert preview_body["deploymentId"] == "dpl_relay_preview_01"
    assert preview_body["commitSha"] == "abc1234def5678"
    assert preview_body["sandboxAvailable"] is True


def test_twin_state_endpoint_and_independent_mutation_replay() -> None:
    client = TestClient(app)

    base_resp = client.post("/api/agent/twin/state", json={})
    assert base_resp.status_code == 200
    base = base_resp.json()
    assert base["totals"]["campaignCount"] == 12
    assert base["totals"]["adGroupCount"] == 104
    assert base["totals"]["rowCount"] == 10400
    assert base["totals"]["dailyBudget"] == 6167.0
    assert base["totals"]["brokenCreatives"] == 14
    assert base["totals"]["utmViolations"] == 9

    # Browser A applies full hygiene remediation + $700/day budget reallocation.
    mutated_resp = client.post(
        "/api/agent/twin/state",
        json={
            "mutations": [
                {"type": "pause_broken_creatives"},
                {"type": "fix_utm_taxonomy"},
                {
                    "type": "reallocate_budget",
                    "from_campaign": "cmp_linkedin_01",
                    "to_campaign": "cmp_google_01",
                    "amount_per_day": 700.0,
                },
            ]
        },
    )
    assert mutated_resp.status_code == 200
    mutated = mutated_resp.json()
    assert mutated["totals"]["brokenCreatives"] == 0
    assert mutated["totals"]["utmViolations"] == 0
    assert mutated["totals"]["spendAtRiskPerDay"] == 0.0
    assert mutated["totals"]["dailyBudget"] == 6167.0
    assert mutated["totals"]["blendedRoas"] > base["totals"]["blendedRoas"]

    # Browser B with empty mutation log still sees untouched baseline totals.
    browser_b_resp = client.post("/api/agent/twin/state", json={"mutations": []})
    assert browser_b_resp.status_code == 200
    assert browser_b_resp.json() == base

    # 51 mutations -> 422.
    over_cap = [
        {
            "type": "reallocate_budget",
            "from_campaign": "cmp_linkedin_01",
            "to_campaign": "cmp_google_01",
            "amount_per_day": 1.0,
        }
    ] * 51
    assert client.post("/api/agent/twin/state", json={"mutations": over_cap}).status_code == 422


def test_workflows_run_streams_six_ordered_nodes_and_reflects_mutations(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    client = TestClient(app)
    resp = client.post(
        "/api/agent/workflows/run",
        json={
            "workflow": {
                "template": "daily-pacing-guardrail",
                "channels": ["google_ads", "linkedin_ads", "meta_ads"],
                "threshold": 15,
            },
            "mutations": [],
        },
    )
    assert resp.status_code == 200
    assert resp.headers.get("content-type") == "text/event-stream"
    assert resp.headers.get("cache-control") == "no-cache"

    events, saw_done = _parse_sse_events(resp.text)
    assert saw_done is True
    assert len(events) == 6
    assert [e["stepIndex"] for e in events] == [0, 1, 2, 3, 4, 5]
    assert [e["node"] for e in events] == [n for n, _ in CANONICAL_WORKFLOW_NODES]
    assert all(e["status"] == "completed" for e in events)
    assert events[1]["summary"]["brokenCreatives"] == 14
    assert events[2]["summary"]["utmViolations"] == 9
    assert events[3]["mode"] == "in-process"
    assert events[3]["summary"]["rowsScanned"] == 10400
    assert events[3]["summary"]["rowsReturned"] == 3
    assert events[4]["summary"]["gateTriggered"] is True
    assert events[5]["summary"]["delivery"] == "preview-only"

    # Re-run after remediating both hygiene categories and setting high threshold -> clear gate!
    clean_resp = client.post(
        "/api/agent/workflows/run",
        json={
            "workflow": {
                "template": "creative-404-guard",
                "channels": ["linkedin_ads"],
                "threshold": 25,
            },
            "mutations": [
                {"type": "pause_broken_creatives"},
                {"type": "fix_utm_taxonomy"},
            ],
        },
    )
    assert clean_resp.status_code == 200
    clean_events, clean_done = _parse_sse_events(clean_resp.text)
    assert clean_done is True
    assert clean_events[0]["summary"]["channelCount"] == 1
    assert clean_events[1]["summary"]["brokenCreatives"] == 0
    assert clean_events[2]["summary"]["utmViolations"] == 0
    assert clean_events[3]["summary"]["rowsReturned"] == 1
    assert clean_events[4]["summary"]["gateTriggered"] is False
    assert clean_events[4]["summary"]["gateOutcome"] == "clear"

    # Also verify Sandbox mode badge when SANDBOX_DISABLED=0 and Sandbox succeeds.
    class _FakeWorkflowBox:
        def __init__(self) -> None:
            class _Fs:
                async def write_text(self, path: str, content: str) -> None:
                    return None

            self.fs = _Fs()

        async def __aenter__(self) -> _FakeWorkflowBox:
            return self

        async def __aexit__(self, *args: Any) -> bool:
            return False

        async def run_command(self, *args: Any, **kwargs: Any) -> CompletedCommand:
            out = json.dumps(
                {
                    "rowsScanned": 10400,
                    "rowsReturned": 3,
                    "table": [
                        {"channel": "Google Ads", "roas": 4.49},
                        {"channel": "Meta Ads", "roas": 3.06},
                        {"channel": "LinkedIn Ads", "roas": 1.44},
                    ],
                }
            ).encode("utf-8")
            return CompletedCommand(
                id="cmd_wf",
                name="python",
                args=("job.py",),
                cwd="/vercel/sandbox",
                session_id="sess_wf",
                started_at=1,
                returncode=0,
                stdout=out,
                stderr=b"",
            )

    monkeypatch.setattr(
        sandbox,
        "create_sandbox",
        lambda *, network_policy=None, **kw: (
            _FakeWorkflowBox()
            if network_policy == NetworkPolicy.deny_all()
            else pytest.fail("Expected deny_all")
        ),
    )
    monkeypatch.setenv("SANDBOX_DISABLED", "0")
    sbx_resp = client.post("/api/agent/workflows/run", json={})
    sbx_events, _ = _parse_sse_events(sbx_resp.text)
    assert sbx_events[3]["mode"] == "sandbox"

    # Invalid workflow template or threshold -> HTTP 422 before streaming starts.
    assert (
        client.post(
            "/api/agent/workflows/run",
            json={"workflow": {"template": "nonexistent"}},
        ).status_code
        == 422
    )
    assert (
        client.post(
            "/api/agent/workflows/run",
            json={"workflow": {"threshold": 0}},
        ).status_code
        == 422
    )


def test_chat_message_count_and_2000_char_and_role_caps() -> None:
    client = TestClient(app)

    # 0 messages -> 422
    assert client.post("/api/agent/chat", json={"messages": []}).status_code == 422

    # 30 messages ending in user -> 200
    thirty_msgs = [
        {"role": "user" if idx % 2 == 0 else "assistant", "content": f"Turn {idx}"}
        for idx in range(29)
    ] + [{"role": "user", "content": "Final turn 30"}]
    assert len(thirty_msgs) == 30
    reset_rate_limiter()
    assert client.post("/api/agent/chat", json={"messages": thirty_msgs}).status_code == 200

    # 31 messages -> 422
    thirty_one = thirty_msgs + [{"role": "user", "content": "Turn 31"}]
    assert client.post("/api/agent/chat", json={"messages": thirty_one}).status_code == 422

    # 2,000-char user message -> 200; 2,001-char single-part or multi-part -> 422
    reset_rate_limiter()
    exact_2000 = {"messages": [{"role": "user", "content": "a" * 2000}]}
    assert client.post("/api/agent/chat", json=exact_2000).status_code == 200

    over_2001_single = {"messages": [{"role": "user", "content": "a" * 2001}]}
    assert client.post("/api/agent/chat", json=over_2001_single).status_code == 422

    over_2001_split = {
        "messages": [
            {
                "role": "user",
                "parts": [
                    {"type": "text", "text": "a" * 1001},
                    {"type": "text", "text": "b" * 1000},
                ],
            }
        ]
    }
    assert client.post("/api/agent/chat", json=over_2001_split).status_code == 422

    # Empty/whitespace user message -> 422; trailing assistant message -> 422
    assert (
        client.post(
            "/api/agent/chat", json={"messages": [{"role": "user", "content": "   "}]}
        ).status_code
        == 422
    )
    assert (
        client.post(
            "/api/agent/chat",
            json={
                "messages": [
                    {"role": "user", "content": "Hello"},
                    {"role": "assistant", "content": "Hi"},
                ]
            },
        ).status_code
        == 422
    )


def test_raw_nan_infinity_1e500_and_lone_surrogates_return_422_never_500() -> None:
    client = TestClient(app, raise_server_exceptions=False)

    chat_vectors = [
        b'{"messages":[{"role":"user","content":"hi"}],"extraMetric":NaN}',
        b'{"messages":[{"role":"user","content":"hi"}],"extraMetric":Infinity}',
        b'{"messages":[{"role":"user","content":"hi"}],"extraMetric":-Infinity}',
        b'{"messages":[{"role":"user","content":"hi"}],"extraMetric":1e500}',
        b'{"messages":[{"role":"user","content":"\\ud800"}]}',
        b'{"messages":[{"role":"user","content":"hi"}],"extraText":"\\udfff"}',
        b'{"messages":[{"role":"user","content":"hi"}],"twinMutations":[{"type":"reallocate_budget","from_campaign":"cmp_linkedin_01","to_campaign":"cmp_google_01","amount_per_day":NaN}]}',
    ]
    for raw in chat_vectors:
        resp = client.post(
            "/api/agent/chat",
            content=raw,
            headers={"Content-Type": "application/json"},
        )
        assert resp.status_code == 422, f"Expected 422 for {raw!r}, got {resp.status_code}"
        parsed = resp.json()
        json.dumps(parsed, allow_nan=False)
        resp.text.encode("utf-8")

    workflow_vectors = [
        b'{"workflow":{"threshold":NaN},"mutations":[]}',
        b'{"workflow":{"threshold":1e500},"mutations":[]}',
        b'{"workflow":{"template":"\\ud800"},"mutations":[]}',
        b'{"workflow":null,"mutations":[Infinity]}',
    ]
    for raw in workflow_vectors:
        resp = client.post(
            "/api/agent/workflows/run",
            content=raw,
            headers={"Content-Type": "application/json"},
        )
        assert resp.status_code == 422, f"Expected 422 for {raw!r}, got {resp.status_code}"
        json.dumps(resp.json(), allow_nan=False)
        resp.text.encode("utf-8")

    twin_vectors = [
        b'{"mutations":"\\ud800"}',
        b'{"mutations":[{"type":"reallocate_budget","from_campaign":"\\ud800","to_campaign":"cmp_google_01","amount_per_day":10.0}]}',
        b'{"mutations":[],"\\udfff":1}',
    ]
    for raw in twin_vectors:
        resp = client.post(
            "/api/agent/twin/state",
            content=raw,
            headers={"Content-Type": "application/json"},
        )
        assert resp.status_code == 422, f"Expected 422 for {raw!r}, got {resp.status_code}"
        json.dumps(resp.json(), allow_nan=False)
        resp.text.encode("utf-8")


def test_sliding_window_rate_limiter_20_per_min_xff_and_lru_bound() -> None:
    client = TestClient(app)
    valid_body = {"messages": [{"role": "user", "content": "Ping"}]}

    # Invalid 422 requests do not burn chat rate-limit slots.
    for _ in range(5):
        bad = client.post(
            "/api/agent/chat",
            json={"messages": []},
            headers={"X-Forwarded-For": "198.51.100.10, 10.0.0.1"},
        )
        assert bad.status_code == 422

    # 20 valid requests from 198.51.100.10 succeed; 21st returns 429 with Retry-After.
    for _ in range(RATE_LIMIT_MAX_REQUESTS):
        ok = client.post(
            "/api/agent/chat",
            json=valid_body,
            headers={"X-Forwarded-For": "198.51.100.10, 10.0.0.1"},
        )
        assert ok.status_code == 200

    blocked = client.post(
        "/api/agent/chat",
        json=valid_body,
        headers={"X-Forwarded-For": "198.51.100.10, 10.0.0.9"},
    )
    assert blocked.status_code == 429
    assert int(blocked.headers["Retry-After"]) >= 1

    # Distinct client IP remains unblocked, and health/twin routes remain unblocked.
    other_ip = client.post(
        "/api/agent/chat",
        json=valid_body,
        headers={"X-Forwarded-For": "198.51.100.99"},
    )
    assert other_ip.status_code == 200
    assert (
        client.get(
            "/api/agent/health", headers={"X-Forwarded-For": "198.51.100.10"}
        ).status_code
        == 200
    )
    assert (
        client.post(
            "/api/agent/twin/state",
            json={},
            headers={"X-Forwarded-For": "198.51.100.10"},
        ).status_code
        == 200
    )

    # Unit-verify window expiry and 4,096-IP LRU memory cap on SlidingWindowRateLimiter.
    limiter = SlidingWindowRateLimiter(max_requests=20, window_seconds=60.0, max_tracked_ips=4096)
    for _ in range(20):
        allowed, _ = limiter.check("203.0.113.5", now=100.0)
        assert allowed is True
    allowed_at_cap, retry = limiter.check("203.0.113.5", now=120.0)
    assert allowed_at_cap is False
    assert retry == 40
    allowed_after_window, _ = limiter.check("203.0.113.5", now=160.1)
    assert allowed_after_window is True

    for idx in range(5000):
        limiter.check(f"192.0.2.{idx}", now=200.0)
    assert len(limiter._buckets) <= RATE_LIMIT_MAX_TRACKED_IPS == 4096


def test_malformed_json_and_invalid_utf8_never_return_500() -> None:
    client = TestClient(app, raise_server_exceptions=False)
    for route in ("/api/agent/chat", "/api/agent/twin/state", "/api/agent/workflows/run"):
        bad_json = client.post(
            route,
            content=b"{malformed-json",
            headers={"Content-Type": "application/json"},
        )
        assert bad_json.status_code in {400, 422}

        bad_utf8 = client.post(
            route,
            content=b'{"messages":"\xff\xfe"}',
            headers={"Content-Type": "application/json"},
        )
        assert bad_utf8.status_code in {400, 422}

