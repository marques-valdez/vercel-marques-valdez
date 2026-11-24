"""Portfolio Monte Carlo: score several whole-portfolio budget plans in one pass.

Standard library only, so the exact same file runs in two places:
    - imported in-process by `app.portfolio`
    - uploaded as-is to a Vercel Sandbox microVM and run as `python portfolio_sim.py`
      next to a `spec.json` file

Model (same assumptions as the single-pair simulator in `sandbox_runner.py`):
    - each campaign's 30-day average ROAS is lognormal around its historical ROAS,
      with daily volatility `sigma` scaled by 1/sqrt(horizonDays)
    - budget removed from a campaign loses return at that campaign's ROAS
    - budget added to a campaign earns its ROAS times a Hill saturation factor
      1 / (1 + 0.22 * (growth_ratio - 1) ** 1.35)

Every plan is scored on the same random draws, so differences between plans come
from the plans and not from sampling noise. The model treats days as independent and
assumes historical ROAS holds at the new spend level; it does not model a campaign
underperforming its history.
"""

from __future__ import annotations

import json
import math
import random
import sys

HILL_ALPHA = 0.22
HILL_GAMMA = 1.35
MIN_ROAS = 0.05


def _percentile(sorted_values, fraction):
    index = int(round(fraction * (len(sorted_values) - 1)))
    return sorted_values[min(len(sorted_values) - 1, max(0, index))]


def saturation_factor(base_budget, new_budget):
    """Return the Hill diminishing-returns factor applied to added budget."""
    ratio = new_budget / max(base_budget, 1.0)
    return 1.0 / (1.0 + HILL_ALPHA * (max(0.0, ratio - 1.0) ** HILL_GAMMA))


def simulate(spec):
    """Score each plan in `spec` and return P10/P50/P90 lift and blended ROAS."""
    campaigns = spec["campaigns"]
    plans = spec["plans"]
    trials = int(spec.get("trials", 2000))
    horizon_days = int(spec.get("horizonDays", 30))
    seed = int(spec.get("seed", 42))

    scale = 1.0 / math.sqrt(max(1, horizon_days))
    prepared = []
    for camp in campaigns:
        roas = max(MIN_ROAS, float(camp["roas"]))
        sigma = float(camp["sigma"]) * scale
        prepared.append(
            (
                str(camp["id"]),
                float(camp["budget"]),
                math.log(roas) - 0.5 * sigma * sigma,
                sigma,
            )
        )
    total_budget = max(1.0, sum(item[1] for item in prepared))

    plan_terms = []
    for plan in plans:
        after = plan["after"]
        terms = []
        for camp_id, budget, _mu, _sigma in prepared:
            new_budget = float(after.get(camp_id, budget))
            if new_budget > budget:
                added = new_budget - budget
                terms.append(budget + added * saturation_factor(budget, new_budget))
            else:
                terms.append(max(0.0, new_budget))
        plan_terms.append(terms)

    rng = random.Random(seed)
    lifts = [[] for _ in plans]
    roas_samples = [[] for _ in plans]
    positives = [0 for _ in plans]

    for _ in range(trials):
        draws = [math.exp(rng.gauss(mu, sigma)) for _id, _budget, mu, sigma in prepared]
        base_daily = sum(item[1] * draw for item, draw in zip(prepared, draws))
        for index, terms in enumerate(plan_terms):
            plan_daily = sum(term * draw for term, draw in zip(terms, draws))
            lift = (plan_daily - base_daily) * horizon_days
            lifts[index].append(lift)
            roas_samples[index].append(plan_daily / total_budget)
            if lift > 0.0:
                positives[index] += 1

    results = []
    for index, plan in enumerate(plans):
        lift_sorted = sorted(lifts[index])
        roas_sorted = sorted(roas_samples[index])
        results.append(
            {
                "planId": str(plan["planId"]),
                "incrementalPipelineP10": round(_percentile(lift_sorted, 0.10), 2),
                "incrementalPipelineP50": round(_percentile(lift_sorted, 0.50), 2),
                "incrementalPipelineP90": round(_percentile(lift_sorted, 0.90), 2),
                "blendedRoasP10": round(_percentile(roas_sorted, 0.10), 2),
                "blendedRoasP50": round(_percentile(roas_sorted, 0.50), 2),
                "blendedRoasP90": round(_percentile(roas_sorted, 0.90), 2),
                "probabilityOfPositiveLiftPct": round(
                    positives[index] / max(1, trials) * 100.0, 1
                ),
            }
        )
    return {"trials": trials, "horizonDays": horizon_days, "plans": results}


def main():
    with open("spec.json", "r", encoding="utf-8") as spec_file:
        spec = json.load(spec_file)
    sys.stdout.write(json.dumps(simulate(spec), separators=(",", ":"), allow_nan=False))


if __name__ == "__main__":
    main()
