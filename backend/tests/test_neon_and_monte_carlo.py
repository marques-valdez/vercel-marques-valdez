"""Tests for Neon Postgres analytics SQL dialect and Sandbox Monte Carlo simulator."""

from __future__ import annotations

import json
import subprocess
import sys

import pytest

from app.sandbox_runner import (
    build_monte_carlo_script,
    run_monte_carlo_in_process,
    run_monte_carlo_reallocation_in_sandbox,
)
from app.sql_templates import TEMPLATE_IDS, compile_sql_template
from app.tools import build_agent_tools


@pytest.mark.parametrize("template_id", TEMPLATE_IDS)
def test_postgres_dialect_compiles_valid_parameterized_sql(template_id: str) -> None:
    compiled = compile_sql_template(
        template_id,
        {"channel": "google_ads", "days": 14, "limit": 10},
        dialect="postgres",
    )
    assert "relay_daily_performance" in compiled.sql
    assert "FROM rows" not in compiled.sql
    assert "?" not in compiled.sql
    assert "%s" in compiled.sql
    assert compiled.params == ("Google Ads", 14, 10)
    if template_id == "daily_pacing_anomalies":
        assert "d.date::text AS date" in compiled.sql


@pytest.mark.asyncio
async def test_monte_carlo_reallocation_monotonicity_and_determinism() -> None:
    res_a = await run_monte_carlo_reallocation_in_sandbox(
        from_campaign="cmp_li_cold_prospecting",
        to_campaign="cmp_g_brand_search",
        from_daily_budget=850.0,
        to_daily_budget=1100.0,
        from_roas=1.85,
        to_roas=4.85,
        amount_per_day=400.0,
        portfolio_daily_budget=6167.0,
        portfolio_blended_roas=3.42,
        prefer_in_process=True,
    )
    res_b = await run_monte_carlo_reallocation_in_sandbox(
        from_campaign="cmp_li_cold_prospecting",
        to_campaign="cmp_g_brand_search",
        from_daily_budget=850.0,
        to_daily_budget=1100.0,
        from_roas=1.85,
        to_roas=4.85,
        amount_per_day=400.0,
        portfolio_daily_budget=6167.0,
        portfolio_blended_roas=3.42,
        prefer_in_process=True,
    )

    assert res_a.mode == "in-process"
    assert res_a.trials == 2000
    assert res_a.horizonDays == 30
    assert res_a.incrementalPipelineP10 <= res_a.incrementalPipelineP50 <= res_a.incrementalPipelineP90
    assert res_a.blendedRoasP10 <= res_a.blendedRoasP50 <= res_a.blendedRoasP90
    assert 0.0 <= res_a.probabilityOfPositiveLiftPct <= 100.0
    assert res_a.probabilityOfPositiveLiftPct > 80.0
    assert res_a.targetSaturationDragPct > 0.0
    assert res_a.incrementalPipelineP50 == res_b.incrementalPipelineP50
    assert res_a.blendedRoasP50 == res_b.blendedRoasP50


def test_monte_carlo_sandbox_script_matches_in_process() -> None:
    spec = {
        "fromCampaign": "cmp_li_cold_prospecting",
        "toCampaign": "cmp_g_brand_search",
        "fromDailyBudget": 850.0,
        "toDailyBudget": 1100.0,
        "fromRoas": 1.85,
        "toRoas": 4.85,
        "amountPerDay": 400.0,
        "portfolioDailyBudget": 6167.0,
        "portfolioBlendedRoas": 3.42,
        "fromSeries": [],
        "toSeries": [],
        "trials": 500,
        "horizonDays": 30,
        "seed": 42,
    }
    in_proc = run_monte_carlo_in_process(spec)
    script = build_monte_carlo_script(spec)
    proc = subprocess.run(
        [sys.executable, "-c", script],
        capture_output=True,
        text=True,
        check=True,
        timeout=15,
    )
    from_script = json.loads(proc.stdout)
    assert from_script == in_proc


@pytest.mark.asyncio
async def test_propose_budget_reallocation_tool_attaches_simulation(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("SANDBOX_DISABLED", "1")
    tools = {t.name: t for t in build_agent_tools()}
    out = await tools["propose_budget_reallocation"].ainvoke({})
    assert "simulation" in out
    sim = out["simulation"]
    assert sim["trials"] == 2000
    assert sim["horizonDays"] == 30
    assert sim["incrementalPipelineP10"] <= sim["incrementalPipelineP50"] <= sim["incrementalPipelineP90"]
