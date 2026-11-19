"""Tests for GET /api/agent/trends and POST /api/agent/reallocation/simulate."""

from __future__ import annotations

from fastapi.testclient import TestClient
import pytest

from app import db, main as app_main, sandbox_runner


@pytest.fixture(autouse=True)
def _reset_limiters(monkeypatch: pytest.MonkeyPatch) -> None:
    app_main.reset_rate_limiter()
    monkeypatch.setenv("SANDBOX_DISABLED", "1")
    yield
    app_main.reset_rate_limiter()


def test_trends_endpoint_returns_30_day_chronological_series_and_bounds() -> None:
    client = TestClient(app_main.app)

    res = client.get("/api/agent/trends")
    assert res.status_code == 200
    payload = res.json()
    assert payload["days"] == 30
    assert payload["mode"] == "in-process"
    assert list(payload["channels"].keys()) == [
        "google_ads",
        "linkedin_ads",
        "meta_ads",
    ]

    for ch_series in payload["channels"].values():
        pts = ch_series["points"]
        assert len(pts) == 30
        dates = [p["date"] for p in pts]
        assert dates == sorted(dates)
        assert all(p["spend"] > 0 for p in pts)
        assert all(p["roas"] >= 0 for p in pts)

    # Spend-weighted 7d vs 7d directional sanity on seeded dataset
    assert payload["channels"]["linkedin_ads"]["deltaPct"] < 0
    assert payload["channels"]["meta_ads"]["deltaPct"] > 0

    custom_res = client.get("/api/agent/trends?days=14")
    assert custom_res.status_code == 200
    assert custom_res.json()["days"] == 14
    assert len(custom_res.json()["channels"]["google_ads"]["points"]) == 14

    assert client.get("/api/agent/trends?days=3").status_code == 422
    assert client.get("/api/agent/trends?days=120").status_code == 422


def test_trends_endpoint_uses_neon_postgres_series_when_configured(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(sandbox_runner, "is_database_configured", lambda: True)
    monkeypatch.setattr(
        sandbox_runner,
        "fetch_channel_daily_trends",
        lambda days, data_dir=None: {
            "Google Ads": [
                {"date": "2026-11-10", "spend": 100.0, "pipeline_value": 400.0},
                {"date": "2026-11-11", "spend": 100.0, "pipeline_value": 500.0},
            ],
            "LinkedIn Ads": [
                {"date": "2026-11-10", "spend": 100.0, "pipeline_value": 200.0},
                {"date": "2026-11-11", "spend": 100.0, "pipeline_value": 150.0},
            ],
            "Meta Ads": [
                {"date": "2026-11-10", "spend": 100.0, "pipeline_value": 250.0},
                {"date": "2026-11-11", "spend": 100.0, "pipeline_value": 300.0},
            ],
        },
    )

    client = TestClient(app_main.app)
    res = client.get("/api/agent/trends?days=7")
    assert res.status_code == 200
    data = res.json()
    assert data["mode"] == "neon-postgres"
    assert data["channels"]["google_ads"]["firstWindowRoas"] == 4.5
    assert data["channels"]["google_ads"]["deltaPct"] == 0.0
    assert len(data["channels"]["meta_ads"]["points"]) == 2


def test_reallocation_simulate_endpoint_computes_live_slider_diffs_and_saturation() -> None:
    client = TestClient(app_main.app)

    low_res = client.post(
        "/api/agent/reallocation/simulate",
        json={
            "fromCampaign": "cmp_linkedin_01",
            "toCampaign": "cmp_google_01",
            "amountPerDay": 200,
            "proposalId": "prop_slider_test",
            "mutations": [],
        },
    )
    assert low_res.status_code == 200
    low_data = low_res.json()
    assert low_data["proposalId"] == "prop_slider_test"
    assert low_data["amountPerDay"] == 200.0
    assert low_data["before"]["totalDailyBudget"] == low_data["after"]["totalDailyBudget"]
    assert low_data["simulation"]["trials"] == 2000
    assert (
        low_data["simulation"]["incrementalPipelineP10"]
        <= low_data["simulation"]["incrementalPipelineP50"]
        <= low_data["simulation"]["incrementalPipelineP90"]
    )

    high_res = client.post(
        "/api/agent/reallocation/simulate",
        json={
            "fromCampaign": "cmp_linkedin_01",
            "toCampaign": "cmp_google_01",
            "amountPerDay": 900,
            "mutations": [],
        },
    )
    assert high_res.status_code == 200
    high_data = high_res.json()
    assert high_data["blendedRoasAfter"] > low_data["blendedRoasAfter"]
    assert (
        high_data["simulation"]["targetSaturationDragPct"]
        > low_data["simulation"]["targetSaturationDragPct"]
    )


def test_reallocation_simulate_rejects_invalid_amounts_and_campaigns() -> None:
    client = TestClient(app_main.app)

    # Amount exceeds source campaign daily budget ($1,400)
    too_high = client.post(
        "/api/agent/reallocation/simulate",
        json={
            "fromCampaign": "cmp_linkedin_01",
            "toCampaign": "cmp_google_01",
            "amountPerDay": 9999,
            "mutations": [],
        },
    )
    assert too_high.status_code == 422

    # Non-positive amount
    zero_amt = client.post(
        "/api/agent/reallocation/simulate",
        json={
            "fromCampaign": "cmp_linkedin_01",
            "toCampaign": "cmp_google_01",
            "amountPerDay": 0,
            "mutations": [],
        },
    )
    assert zero_amt.status_code == 422

    # Identical source & target
    same_cmp = client.post(
        "/api/agent/reallocation/simulate",
        json={
            "fromCampaign": "cmp_linkedin_01",
            "toCampaign": "cmp_linkedin_01",
            "amountPerDay": 100,
            "mutations": [],
        },
    )
    assert same_cmp.status_code == 422

    # Unknown campaign
    unknown_cmp = client.post(
        "/api/agent/reallocation/simulate",
        json={
            "fromCampaign": "cmp_does_not_exist",
            "toCampaign": "cmp_google_01",
            "amountPerDay": 100,
            "mutations": [],
        },
    )
    assert unknown_cmp.status_code == 422
    _ = db
