"""Tests for the three-plan portfolio optimizer and its shared simulation module."""

from __future__ import annotations

import json
from pathlib import Path
import subprocess
import sys

from fastapi.testclient import TestClient
import pytest

from app import portfolio_sim
from app.main import app, reset_rate_limiter
from app.portfolio import (
    DONOR_FLOOR_SHARE,
    SHIFT_STEP,
    build_plan_shifts,
    optimize_portfolio,
    select_donors_and_recipients,
)
from app.twin import MAX_MUTATIONS, compute_twin_state, validate_mutations


@pytest.fixture(autouse=True)
def _isolated(monkeypatch: pytest.MonkeyPatch) -> None:
    for key in ("DATABASE_URL", "POSTGRES_URL", "POSTGRES_PRISMA_URL"):
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setenv("SANDBOX_DISABLED", "1")
    reset_rate_limiter()


async def test_plans_respect_budget_constraints_and_replay_cleanly() -> None:
    result = await optimize_portfolio([])
    assert result.mode == "in-process"
    assert result.trials == 2000 and result.horizonDays == 30
    assert [p.planId for p in result.plans] == ["cautious", "balanced", "bold"]
    assert [p.sharePct for p in result.plans] == [10, 25, 50]

    base = compute_twin_state([])
    budgets = {c.campaignId: c.dailyBudget for c in base.campaigns}
    roas = {c.campaignId: c.roas for c in base.campaigns}
    blended = base.totals.blendedRoas

    moved_values = [p.movedPerDay for p in result.plans]
    assert moved_values == sorted(moved_values) and len(set(moved_values)) == 3

    for plan in result.plans:
        assert 1 <= len(plan.mutations) <= 5
        assert plan.fitsMutationCap is True
        after = compute_twin_state(validate_mutations(plan.mutations))
        assert after.totals.dailyBudget == pytest.approx(base.totals.dailyBudget)
        assert sum(s.amountPerDay for s in plan.shifts) == plan.movedPerDay
        donors = {s.fromCampaign for s in plan.shifts}
        recipients = {s.toCampaign for s in plan.shifts}
        assert len(donors) <= 3 and len(recipients) <= 3 and donors.isdisjoint(recipients)
        for shift in plan.shifts:
            assert shift.amountPerDay % SHIFT_STEP == 0 and shift.amountPerDay > 0
            assert roas[shift.fromCampaign] < blended < roas[shift.toCampaign]
        for camp in after.campaigns:
            before = budgets[camp.campaignId]
            if camp.campaignId in donors:
                assert camp.dailyBudget >= before * DONOR_FLOOR_SHARE
            if camp.campaignId in recipients:
                assert camp.dailyBudget <= before * 2.0
        assert plan.incrementalPipelineP10 <= plan.incrementalPipelineP50
        assert plan.incrementalPipelineP50 <= plan.incrementalPipelineP90
        assert plan.liftPerDollarMoved == pytest.approx(
            plan.incrementalPipelineP50 / plan.movedPerDay, abs=0.01
        )

    # Larger moves earn less per dollar moved (Hill saturation on added budget).
    per_dollar = [p.liftPerDollarMoved for p in result.plans]
    assert per_dollar == sorted(per_dollar, reverse=True)


async def test_optimizer_is_deterministic_and_tracks_applied_mutations() -> None:
    first = await optimize_portfolio([])
    second = await optimize_portfolio([])
    assert first.model_dump(exclude={"sandboxMs"}) == second.model_dump(exclude={"sandboxMs"})

    applied = first.plans[2].mutations
    follow_up = await optimize_portfolio(applied)
    assert follow_up.baseline.blendedRoas > first.baseline.blendedRoas
    assert follow_up.plans[0].movedPerDay < first.plans[0].movedPerDay

    filler = [
        {"type": "pause_broken_creatives"} for _ in range(MAX_MUTATIONS - 2)
    ]
    capped = await optimize_portfolio(filler)
    assert all(len(p.mutations) > 2 for p in capped.plans)
    assert all(p.fitsMutationCap is False for p in capped.plans)


def test_no_donors_or_recipients_yields_no_shifts() -> None:
    state = compute_twin_state([])
    donors, recipients = select_donors_and_recipients(state)
    assert len(donors) == 3 and len(recipients) == 3
    assert build_plan_shifts([], recipients, 0.25) == []
    assert build_plan_shifts(donors, [], 0.25) == []
    assert build_plan_shifts(donors, recipients, 0.0001) == []


def test_sandbox_script_and_in_process_import_produce_identical_output(
    tmp_path: Path,
) -> None:
    spec = {
        "campaigns": [
            {"id": "a", "budget": 1000.0, "roas": 0.9, "sigma": 0.4},
            {"id": "b", "budget": 500.0, "roas": 5.0, "sigma": 0.3},
            {"id": "c", "budget": 250.0, "roas": 3.0, "sigma": 0.2},
        ],
        "plans": [
            {"planId": "small", "after": {"a": 900.0, "b": 600.0, "c": 250.0}},
            {"planId": "large", "after": {"a": 500.0, "b": 1000.0, "c": 250.0}},
        ],
        "trials": 500,
        "horizonDays": 30,
        "seed": 7,
    }
    in_process = portfolio_sim.simulate(spec)

    (tmp_path / "spec.json").write_text(json.dumps(spec), encoding="utf-8")
    script = tmp_path / "portfolio_sim.py"
    script.write_text(Path(portfolio_sim.__file__).read_text(encoding="utf-8"), encoding="utf-8")
    completed = subprocess.run(
        [sys.executable, "-I", str(script)],
        cwd=tmp_path,
        capture_output=True,
        check=True,
        text=True,
    )
    assert json.loads(completed.stdout) == in_process

    small, large = in_process["plans"]
    assert small["incrementalPipelineP50"] > 0
    assert large["incrementalPipelineP50"] > small["incrementalPipelineP50"]
    assert portfolio_sim.saturation_factor(500.0, 500.0) == 1.0
    assert portfolio_sim.saturation_factor(500.0, 1000.0) == pytest.approx(1 / 1.22)


def test_optimize_endpoint_contract_validation_and_rate_limit() -> None:
    client = TestClient(app)
    res = client.post("/api/agent/reallocation/optimize", json={})
    assert res.status_code == 200
    body = res.json()
    assert body["mode"] == "in-process"
    assert body["baseline"] == {"dailyBudget": 6167.0, "blendedRoas": 3.15}
    assert [p["label"] for p in body["plans"]] == ["Cautious", "Balanced", "Bold"]

    bad = client.post(
        "/api/agent/reallocation/optimize",
        json={
            "mutations": [
                {
                    "type": "reallocate_budget",
                    "from_campaign": "cmp_google_01",
                    "to_campaign": "cmp_google_02",
                    "amount_per_day": 999999,
                }
            ]
        },
    )
    assert bad.status_code == 422

    reset_rate_limiter()
    codes = [
        client.post("/api/agent/reallocation/optimize", json={}).status_code
        for _ in range(61)
    ]
    assert codes[:60] == [200] * 60 and codes[60] == 429
