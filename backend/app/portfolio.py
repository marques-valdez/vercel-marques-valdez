"""Whole-portfolio budget plans: build three candidates and score them together.

`build_candidate_plans` proposes moving a fixed share of budget (10%, 25%, 50%) out of
the lowest-return campaigns into the highest-return campaigns. Plans are defined by how
much budget moves, not by risk appetite: under the simulator's assumptions a larger
move raises the P10, P50, and P90 outcomes together, so the visible trade-off is the
size of the change against a falling return per dollar moved.

Each plan is emitted as ordinary `reallocate_budget` mutations, so applying a plan
goes through the same validation, audit log, and Undo as a single approved shift.
"""

from __future__ import annotations

from decimal import Decimal
import math
from typing import Any, Final, Literal, Mapping, Sequence

import anyio
from pydantic import BaseModel, ConfigDict

from app.db import fetch_campaign_daily_series, is_database_configured, is_dataset_in_sync
from app.sandbox_runner import (
    _extract_campaign_series_from_csv,
    run_portfolio_simulation_in_sandbox,
)
from app.twin import (
    MAX_MUTATIONS,
    CampaignSummary,
    DerivedTwinState,
    Mutation,
    compute_twin_state,
    get_rows_csv_text,
    validate_mutations,
)

SHIFT_STEP: Final[int] = 25
MAX_DONORS: Final[int] = 3
MAX_RECIPIENTS: Final[int] = 3
DONOR_FLOOR_SHARE: Final[float] = 0.40
RECIPIENT_MAX_GROWTH: Final[float] = 1.0
PORTFOLIO_TRIALS: Final[int] = 2000
PORTFOLIO_HORIZON_DAYS: Final[int] = 30
PORTFOLIO_SEED: Final[int] = 42
DEFAULT_SIGMA: Final[float] = 0.18

PLAN_DEFINITIONS: Final[tuple[tuple[str, str, float], ...]] = (
    ("cautious", "Cautious", 0.10),
    ("balanced", "Balanced", 0.25),
    ("bold", "Bold", 0.50),
)


class PortfolioShift(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    fromCampaign: str
    fromCampaignName: str
    fromChannel: str
    toCampaign: str
    toCampaignName: str
    toChannel: str
    amountPerDay: float


class PortfolioPlan(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    planId: str
    label: str
    sharePct: int
    movedPerDay: float
    movedSharePct: float
    shifts: list[PortfolioShift]
    mutations: list[dict[str, Any]]
    fitsMutationCap: bool
    incrementalPipelineP10: float
    incrementalPipelineP50: float
    incrementalPipelineP90: float
    blendedRoasP10: float
    blendedRoasP50: float
    blendedRoasP90: float
    probabilityOfPositiveLiftPct: float
    liftPerDollarMoved: float


class PortfolioBaseline(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    dailyBudget: float
    blendedRoas: float


class PortfolioOptimizeResult(BaseModel):
    """Response contract for POST /api/agent/reallocation/optimize."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    mode: Literal["sandbox", "in-process"]
    trials: int
    horizonDays: int
    sandboxMs: float
    baseline: PortfolioBaseline
    plans: list[PortfolioPlan]
    note: str | None = None


def estimate_log_sigma(series: Sequence[Mapping[str, Any]]) -> float:
    """Estimate daily log-ROAS volatility from a campaign's daily spend/pipeline rows."""
    ratios = [
        float(point["pipeline_value"]) / float(point["spend"])
        for point in series
        if float(point.get("spend", 0.0)) > 0.0
        and float(point.get("pipeline_value", 0.0)) > 0.0
    ]
    if len(ratios) < 3:
        return DEFAULT_SIGMA
    logs = [math.log(max(0.05, ratio)) for ratio in ratios]
    mean_log = sum(logs) / len(logs)
    variance = sum((value - mean_log) ** 2 for value in logs) / max(1, len(logs) - 1)
    return max(0.05, min(0.45, math.sqrt(variance)))


def _floor_to_step(value: float) -> int:
    return int(math.floor(value / SHIFT_STEP + 1e-9)) * SHIFT_STEP


def _round_to_step(value: float) -> int:
    return int(math.floor(value / SHIFT_STEP + 0.5)) * SHIFT_STEP


def select_donors_and_recipients(
    state: DerivedTwinState,
) -> tuple[list[CampaignSummary], list[CampaignSummary]]:
    """Pick up to three below-average donors and three above-average recipients."""
    blended = state.totals.blendedRoas
    funded = [c for c in state.campaigns if c.dailyBudget >= SHIFT_STEP]
    donors = sorted(
        (c for c in funded if c.roas < blended),
        key=lambda c: (c.roas, -c.dailyBudget, c.campaignId),
    )[:MAX_DONORS]
    recipients = sorted(
        (c for c in funded if c.roas > blended),
        key=lambda c: (-c.roas, c.campaignId),
    )[:MAX_RECIPIENTS]
    return donors, recipients


def build_plan_shifts(
    donors: Sequence[CampaignSummary],
    recipients: Sequence[CampaignSummary],
    share: float,
) -> list[tuple[str, str, int]]:
    """Return (from_campaign, to_campaign, whole-dollar amount) shifts for one plan."""
    if not donors or not recipients:
        return []

    max_cut_share = 1.0 - DONOR_FLOOR_SHARE
    cuts: dict[str, int] = {}
    for donor in donors:
        wanted = _round_to_step(donor.dailyBudget * share)
        ceiling = _floor_to_step(donor.dailyBudget * max_cut_share)
        cut = max(0, min(wanted, ceiling))
        if cut >= SHIFT_STEP:
            cuts[donor.campaignId] = cut

    room: dict[str, int] = {
        rec.campaignId: _floor_to_step(rec.dailyBudget * RECIPIENT_MAX_GROWTH)
        for rec in recipients
    }
    pool = min(sum(cuts.values()), sum(room.values()))
    if pool < SHIFT_STEP:
        return []

    # Trim donor cuts (best-returning donor first) if recipients cannot absorb the pool.
    excess = sum(cuts.values()) - pool
    for donor in sorted(donors, key=lambda c: (-c.roas, c.campaignId)):
        if excess <= 0:
            break
        take = min(excess, cuts.get(donor.campaignId, 0))
        if take > 0:
            cuts[donor.campaignId] -= take
            excess -= take

    # Split the pool across recipients in proportion to ROAS, in $25 steps.
    weight_total = sum(rec.roas for rec in recipients)
    adds: dict[str, int] = {}
    for rec in recipients:
        ideal = pool * rec.roas / weight_total if weight_total > 0 else 0.0
        adds[rec.campaignId] = min(room[rec.campaignId], _floor_to_step(ideal))
    leftover = pool - sum(adds.values())
    for rec in recipients:
        if leftover <= 0:
            break
        extra = min(leftover, room[rec.campaignId] - adds[rec.campaignId])
        if extra > 0:
            adds[rec.campaignId] += extra
            leftover -= extra

    # Pair donors with recipients greedily: at most len(donors)+len(recipients)-1 shifts.
    remaining_cuts = [(d.campaignId, cuts.get(d.campaignId, 0)) for d in donors]
    remaining_adds = [(r.campaignId, adds.get(r.campaignId, 0)) for r in recipients]
    shifts: list[tuple[str, str, int]] = []
    donor_idx = 0
    rec_idx = 0
    donor_left = remaining_cuts[0][1]
    rec_left = remaining_adds[0][1]
    while donor_idx < len(remaining_cuts) and rec_idx < len(remaining_adds):
        if donor_left <= 0:
            donor_idx += 1
            if donor_idx < len(remaining_cuts):
                donor_left = remaining_cuts[donor_idx][1]
            continue
        if rec_left <= 0:
            rec_idx += 1
            if rec_idx < len(remaining_adds):
                rec_left = remaining_adds[rec_idx][1]
            continue
        amount = min(donor_left, rec_left)
        shifts.append((remaining_cuts[donor_idx][0], remaining_adds[rec_idx][0], amount))
        donor_left -= amount
        rec_left -= amount
    return shifts


def _load_campaign_series(campaign_ids: Sequence[str]) -> dict[str, list[dict[str, Any]]]:
    """Daily spend/pipeline per campaign: Neon when it holds the bundled rows, else CSV."""
    if is_database_configured():
        try:
            series = fetch_campaign_daily_series(campaign_ids)
            if series is not None and is_dataset_in_sync():
                return series
        except Exception:
            pass
    return _extract_campaign_series_from_csv(get_rows_csv_text(), campaign_ids)


async def optimize_portfolio(
    mutations: Sequence[Mutation | Mapping[str, Any]] = (),
    *,
    prefer_in_process: bool = False,
) -> PortfolioOptimizeResult:
    """Build the three plans from current budgets and score them in one simulation."""
    validated = validate_mutations(mutations)
    state = compute_twin_state(validated)
    baseline = PortfolioBaseline(
        dailyBudget=state.totals.dailyBudget,
        blendedRoas=state.totals.blendedRoas,
    )
    by_id = {c.campaignId: c for c in state.campaigns}
    donors, recipients = select_donors_and_recipients(state)

    drafted: list[tuple[str, str, float, list[tuple[str, str, int]]]] = []
    seen_signatures: set[tuple[tuple[str, str, int], ...]] = set()
    for plan_id, label, share in PLAN_DEFINITIONS:
        shifts = build_plan_shifts(donors, recipients, share)
        signature = tuple(shifts)
        if not shifts or signature in seen_signatures:
            continue
        seen_signatures.add(signature)
        drafted.append((plan_id, label, share, shifts))

    if not drafted:
        return PortfolioOptimizeResult(
            mode="in-process",
            trials=PORTFOLIO_TRIALS,
            horizonDays=PORTFOLIO_HORIZON_DAYS,
            sandboxMs=0.0,
            baseline=baseline,
            plans=[],
            note=(
                "No plan available: there is no funded campaign below the blended "
                "ROAS to move budget from, or none above it to move budget to."
            ),
        )

    series_map = await anyio.to_thread.run_sync(
        _load_campaign_series, [c.campaignId for c in state.campaigns]
    )
    spec_plans: list[dict[str, Any]] = []
    for plan_id, _label, _share, shifts in drafted:
        after = {c.campaignId: Decimal(str(c.dailyBudget)) for c in state.campaigns}
        for from_id, to_id, amount in shifts:
            after[from_id] -= Decimal(amount)
            after[to_id] += Decimal(amount)
        spec_plans.append(
            {"planId": plan_id, "after": {cid: float(val) for cid, val in after.items()}}
        )
    spec = {
        "campaigns": [
            {
                "id": c.campaignId,
                "budget": c.dailyBudget,
                "roas": c.roas,
                "sigma": estimate_log_sigma(series_map.get(c.campaignId, [])),
            }
            for c in state.campaigns
        ],
        "plans": spec_plans,
        "trials": PORTFOLIO_TRIALS,
        "horizonDays": PORTFOLIO_HORIZON_DAYS,
        "seed": PORTFOLIO_SEED,
    }

    parsed, mode, elapsed_ms = await run_portfolio_simulation_in_sandbox(
        spec, prefer_in_process=prefer_in_process
    )
    scored = {str(item["planId"]): item for item in parsed["plans"]}

    plans_out: list[PortfolioPlan] = []
    for plan_id, label, share, shifts in drafted:
        plan_mutations = [
            {
                "type": "reallocate_budget",
                "from_campaign": from_id,
                "to_campaign": to_id,
                "amount_per_day": float(amount),
            }
            for from_id, to_id, amount in shifts
        ]
        fits_cap = len(validated) + len(plan_mutations) <= MAX_MUTATIONS
        if fits_cap:
            # Replays the full log, so a plan that would overdraw a campaign fails here.
            validate_mutations([*validated, *plan_mutations])
        moved = float(sum(amount for _f, _t, amount in shifts))
        result = scored[plan_id]
        p50 = float(result["incrementalPipelineP50"])
        plans_out.append(
            PortfolioPlan(
                planId=plan_id,
                label=label,
                sharePct=int(round(share * 100)),
                movedPerDay=moved,
                movedSharePct=round(moved / baseline.dailyBudget * 100.0, 1)
                if baseline.dailyBudget > 0
                else 0.0,
                shifts=[
                    PortfolioShift(
                        fromCampaign=from_id,
                        fromCampaignName=by_id[from_id].name,
                        fromChannel=by_id[from_id].channel,
                        toCampaign=to_id,
                        toCampaignName=by_id[to_id].name,
                        toChannel=by_id[to_id].channel,
                        amountPerDay=float(amount),
                    )
                    for from_id, to_id, amount in shifts
                ],
                mutations=plan_mutations,
                fitsMutationCap=fits_cap,
                incrementalPipelineP10=float(result["incrementalPipelineP10"]),
                incrementalPipelineP50=p50,
                incrementalPipelineP90=float(result["incrementalPipelineP90"]),
                blendedRoasP10=float(result["blendedRoasP10"]),
                blendedRoasP50=float(result["blendedRoasP50"]),
                blendedRoasP90=float(result["blendedRoasP90"]),
                probabilityOfPositiveLiftPct=float(result["probabilityOfPositiveLiftPct"]),
                liftPerDollarMoved=round(p50 / moved, 2) if moved > 0 else 0.0,
            )
        )

    return PortfolioOptimizeResult(
        mode=mode,
        trials=int(parsed["trials"]),
        horizonDays=int(parsed["horizonDays"]),
        sandboxMs=elapsed_ms,
        baseline=baseline,
        plans=plans_out,
    )
