"""Deterministic Digital Twin dataset generator for Fieldstone Relay Studio."""

from __future__ import annotations

import argparse
import csv
import io
import json
import random
from datetime import date, timedelta
from pathlib import Path
from typing import Any

DEFAULT_SEED = 20261117
GENERATED_FOR_DATE = date(2026, 11, 17)
NUM_DAYS = 100
START_DATE = GENERATED_FOR_DATE - timedelta(days=NUM_DAYS - 1)

CSV_HEADER = [
    "date",
    "channel",
    "campaign_id",
    "ad_group_id",
    "spend",
    "clicks",
    "conversions",
    "pipeline_value",
]

CHANNEL_SPECS: list[dict[str, Any]] = [
    {
        "channelId": "google_ads",
        "channel": "Google Ads",
        "utmSource": "google",
        "utmMedium": "cpc",
        "shortPrefix": "google",
    },
    {
        "channelId": "linkedin_ads",
        "channel": "LinkedIn Ads",
        "utmSource": "linkedin",
        "utmMedium": "paid_social",
        "shortPrefix": "linkedin",
    },
    {
        "channelId": "meta_ads",
        "channel": "Meta Ads",
        "utmSource": "meta",
        "utmMedium": "paid_social",
        "shortPrefix": "meta",
    },
]

CAMPAIGN_SPECS: list[dict[str, Any]] = [
    {
        "campaignId": "cmp_google_01",
        "name": "Google Search — Exact Match Core",
        "channelId": "google_ads",
        "matchType": "exact",
        "adGroupCount": 10,
        "dailyBudget": 900.0,
        "targetRoas": 6.10,
        "cpcRange": (4.40, 5.20),
        "cvr": 0.054,
        "slugBase": "exact-match-core",
        "broken404": {},
        "utmViolations": {},
    },
    {
        "campaignId": "cmp_google_02",
        "name": "Google Search — Mid-Market Pipeline",
        "channelId": "google_ads",
        "matchType": "phrase",
        "adGroupCount": 10,
        "dailyBudget": 650.0,
        "targetRoas": 4.35,
        "cpcRange": (4.80, 5.80),
        "cvr": 0.044,
        "slugBase": "mid-market-pipeline",
        "broken404": {3: "https://fieldstone.example/lp/mid-market-roi-calculator-v1"},
        "utmViolations": {7: "utm_source=Google&utm_medium=PPC&utm_campaign=midmarket_q4"},
    },
    {
        "campaignId": "cmp_google_03",
        "name": "Google Search — Category Demand",
        "channelId": "google_ads",
        "matchType": "broad",
        "adGroupCount": 10,
        "dailyBudget": 550.0,
        "targetRoas": 3.45,
        "cpcRange": (3.90, 4.90),
        "cvr": 0.035,
        "slugBase": "category-demand",
        "broken404": {2: "https://fieldstone.example/lp/campaign-audit-template-2025"},
        "utmViolations": {6: "utm_source=adwords&utm_medium=search"},
    },
    {
        "campaignId": "cmp_google_04",
        "name": "Google Search — Competitor Switch",
        "channelId": "google_ads",
        "matchType": "phrase",
        "adGroupCount": 10,
        "dailyBudget": 450.0,
        "targetRoas": 3.95,
        "cpcRange": (5.20, 6.20),
        "cvr": 0.041,
        "slugBase": "competitor-switch",
        "broken404": {4: "https://fieldstone.example/compare/legacy-ad-tools-retired"},
        "utmViolations": {},
    },
    {
        "campaignId": "cmp_google_05",
        "name": "Google Cross-Network — Product Tour",
        "channelId": "google_ads",
        "matchType": "performance_max",
        "adGroupCount": 10,
        "dailyBudget": 350.0,
        "targetRoas": 2.95,
        "cpcRange": (2.80, 3.60),
        "cvr": 0.028,
        "slugBase": "product-tour",
        "broken404": {5: "https://fieldstone.example/tour/interactive-walkthrough-old"},
        "utmViolations": {},
    },
    {
        "campaignId": "cmp_linkedin_01",
        "name": "LinkedIn Account Targeting — Enterprise Tier",
        "channelId": "linkedin_ads",
        "matchType": "account_targeting",
        "adGroupCount": 9,
        "dailyBudget": 1400.0,
        "targetRoas": 0.85,
        "cpcRange": (11.50, 14.50),
        "cvr": 0.018,
        "slugBase": "enterprise-account-tier",
        "broken404": {
            1: "https://fieldstone.example/lp/enterprise-q2-playbook-old",
            4: "https://fieldstone.example/lp/abm-field-guide-2025",
            7: "https://fieldstone.example/webinars/global-ops-summit-archive",
        },
        "utmViolations": {9: "utm_source=LinkedIn&utm_medium=social&utm_campaign=enterprise_abm"},
    },
    {
        "campaignId": "cmp_linkedin_02",
        "name": "LinkedIn Sponsored — Marketing Ops Leaders",
        "channelId": "linkedin_ads",
        "matchType": "sponsored_content",
        "adGroupCount": 9,
        "dailyBudget": 350.0,
        "targetRoas": 2.45,
        "cpcRange": (9.20, 11.40),
        "cvr": 0.028,
        "slugBase": "marketing-ops-leaders",
        "broken404": {2: "https://fieldstone.example/resources/mops-checklist-v1"},
        "utmViolations": {6: "utm_medium=sponsored&utm_campaign=mops_q4"},
    },
    {
        "campaignId": "cmp_linkedin_03",
        "name": "LinkedIn Lead Forms — Benchmark Guide",
        "channelId": "linkedin_ads",
        "matchType": "lead_gen_forms",
        "adGroupCount": 9,
        "dailyBudget": 250.0,
        "targetRoas": 2.75,
        "cpcRange": (8.40, 10.20),
        "cvr": 0.032,
        "slugBase": "paid-media-benchmark",
        "broken404": {3: "https://fieldstone.example/reports/paid-media-benchmark-draft"},
        "utmViolations": {},
    },
    {
        "campaignId": "cmp_linkedin_04",
        "name": "LinkedIn Sponsored — Revenue Operations",
        "channelId": "linkedin_ads",
        "matchType": "message_ads",
        "adGroupCount": 9,
        "dailyBudget": 200.0,
        "targetRoas": 2.15,
        "cpcRange": (9.80, 12.00),
        "cvr": 0.025,
        "slugBase": "revenue-operations",
        "broken404": {2: "https://fieldstone.example/solutions/revops-workflow-beta"},
        "utmViolations": {5: "utm_source=li_ads&utm_medium=inmail&utm_campaign=revops promo"},
    },
    {
        "campaignId": "cmp_meta_01",
        "name": "Meta Feed — Lookalike Demand Capture",
        "channelId": "meta_ads",
        "matchType": "lookalike",
        "adGroupCount": 6,
        "dailyBudget": 467.0,
        "targetRoas": 3.10,
        "cpcRange": (2.60, 3.40),
        "cvr": 0.027,
        "slugBase": "lookalike-demand",
        "broken404": {2: "https://fieldstone.example/lp/demand-capture-kit-q2"},
        "utmViolations": {
            4: "utm_source=facebook&utm_medium=social_paid",
            6: "utm_source=ig&utm_medium=cpc&utm_campaign=lookalike_v2",
        },
    },
    {
        "campaignId": "cmp_meta_02",
        "name": "Meta Retargeting — Pricing Visitors",
        "channelId": "meta_ads",
        "matchType": "retargeting",
        "adGroupCount": 6,
        "dailyBudget": 350.0,
        "targetRoas": 3.80,
        "cpcRange": (2.20, 3.00),
        "cvr": 0.036,
        "slugBase": "retargeting-pricing",
        "broken404": {3: "https://fieldstone.example/pricing/team-tier-promo-expired"},
        "utmViolations": {5: "utm_source=Meta&utm_campaign=retarget_pricing"},
    },
    {
        "campaignId": "cmp_meta_03",
        "name": "Meta Feed — Paid Social Reach",
        "channelId": "meta_ads",
        "matchType": "interest",
        "adGroupCount": 6,
        "dailyBudget": 250.0,
        "targetRoas": 1.95,
        "cpcRange": (1.90, 2.70),
        "cvr": 0.018,
        "slugBase": "paid-social-reach",
        "broken404": {
            1: "https://fieldstone.example/stories/b2b-growth-reel-404",
            4: "https://fieldstone.example/events/autumn-roadshow-registration",
        },
        "utmViolations": {6: "utm_source=fb_ig&utm_medium=boosted_post"},
    },
]


def _largest_remainder_cents(
    total_cents: int,
    weights: list[float],
    min_cents: int = 1,
) -> list[int]:
    """Allocate integer cents proportionally with zero rounding residual."""
    count = len(weights)
    if count == 0 or total_cents < count * min_cents:
        raise ValueError("Invalid cent allocation parameters.")
    pool = total_cents - count * min_cents
    weight_sum = sum(weights)
    exact = [pool * (w / weight_sum) for w in weights]
    floors = [int(val) for val in exact]
    remainder = pool - sum(floors)
    order = sorted(range(count), key=lambda idx: (-(exact[idx] - floors[idx]), idx))
    for idx in order[:remainder]:
        floors[idx] += 1
    return [min_cents + val for val in floors]


def build_twin_artifacts(seed: int = DEFAULT_SEED) -> tuple[str, str]:
    """Build serialized twin.json and rows.csv strings deterministically."""
    rng = random.Random(seed)
    dates = [START_DATE + timedelta(days=offset) for offset in range(NUM_DAYS)]
    channel_map = {item["channelId"]: item for item in CHANNEL_SPECS}

    ad_groups: list[dict[str, Any]] = []
    broken_issues_raw: list[dict[str, Any]] = []
    utm_issues_raw: list[dict[str, Any]] = []
    campaigns_out: list[dict[str, Any]] = []
    all_rows: list[tuple[str, int, int, str, str, str, int, int, int, int]] = []

    for cmp_idx, spec in enumerate(CAMPAIGN_SPECS):
        cid = spec["campaignId"]
        ch_info = channel_map[spec["channelId"]]
        ch_id = ch_info["channelId"]
        ch_name = ch_info["channel"]
        ag_count = spec["adGroupCount"]
        daily_budget = spec["dailyBudget"]
        target_roas = spec["targetRoas"]
        cmp_num = cid.split("_")[-1]

        if not set(spec["broken404"]).isdisjoint(set(spec["utmViolations"])):
            raise ValueError(f"Overlapping hygiene issue indices in {cid}.")

        cmp_spend_cents = int(round(daily_budget * NUM_DAYS * 100))
        cmp_pipe_cents = int(round(daily_budget * NUM_DAYS * target_roas * 100))
        base_ag_cents, rem_ag = divmod(cmp_spend_cents, ag_count)
        per_ag_risk = round(daily_budget / ag_count, 2)

        cmp_row_records: list[list[Any]] = []

        for ag_i in range(1, ag_count + 1):
            ag_id = f"ag_{ch_info['shortPrefix']}_{cmp_num}_{ag_i:02d}"
            ag_name = f"{spec['name']} · Group {ag_i:02d}"
            canonical_utm = (
                f"utm_source={ch_info['utmSource']}&utm_medium={ch_info['utmMedium']}"
                f"&utm_campaign={cid}&utm_content={ag_id}"
            )
            is_404 = ag_i in spec["broken404"]
            is_bad_utm = ag_i in spec["utmViolations"]

            dest_url = (
                spec["broken404"][ag_i]
                if is_404
                else f"https://fieldstone.example/lp/{spec['slugBase']}-{ag_i:02d}"
            )
            utm_query = spec["utmViolations"][ag_i] if is_bad_utm else canonical_utm

            ad_groups.append(
                {
                    "adGroupId": ag_id,
                    "name": ag_name,
                    "campaignId": cid,
                    "channel": ch_name,
                    "channelId": ch_id,
                    "creativeStatus": "active",
                    "destinationUrl": dest_url,
                    "destinationHttpStatus": 404 if is_404 else 200,
                    "utmQuery": utm_query,
                    "canonicalUtmQuery": canonical_utm,
                    "utmValid": not is_bad_utm,
                }
            )

            common_issue = {
                "status": "active",
                "channel": ch_name,
                "channelId": ch_id,
                "campaignId": cid,
                "campaignName": spec["name"],
                "adGroupId": ag_id,
                "dailySpendAtRisk": per_ag_risk,
            }
            if is_404:
                broken_issues_raw.append(
                    {
                        "sortPriority": 0 if cid == "cmp_linkedin_01" else 1,
                        "issueType": "broken_404",
                        **common_issue,
                        "value": dest_url,
                        "recommendedFix": "Pause creative until destination returns 200",
                    }
                )
            elif is_bad_utm:
                utm_issues_raw.append(
                    {
                        "sortPriority": 1,
                        "issueType": "utm_violation",
                        **common_issue,
                        "value": utm_query,
                        "recommendedFix": f"Rewrite UTM parameters to {canonical_utm}",
                    }
                )

            ag_spend_cents = base_ag_cents + (1 if ag_i <= rem_ag else 0)
            day_weights: list[float] = []
            for day_val in dates:
                weekday = day_val.weekday()
                season = 1.12 if weekday in (1, 2, 3) else (1.02 if weekday in (0, 4) else 0.74)
                day_weights.append(season * rng.uniform(0.88, 1.12))
            day_spend_cents = _largest_remainder_cents(ag_spend_cents, day_weights, min_cents=100)

            for day_val, spend_cents in zip(dates, day_spend_cents):
                spend_dollars = spend_cents / 100.0
                cpc = rng.uniform(*spec["cpcRange"])
                clicks = max(1, int(round(spend_dollars / cpc)))
                if is_404:
                    convs = 0
                    pipe_weight = 0.0
                else:
                    conv_prob = spec["cvr"] * rng.uniform(0.85, 1.15)
                    convs = sum(1 for _ in range(clicks) if rng.random() < conv_prob)
                    pipe_weight = convs * rng.uniform(0.82, 1.18) if convs > 0 else 0.0
                cmp_row_records.append(
                    [
                        day_val.isoformat(),
                        cmp_idx,
                        ag_i,
                        ch_name,
                        cid,
                        ag_id,
                        spend_cents,
                        clicks,
                        convs,
                        pipe_weight,
                    ]
                )

        pos_indices = [idx for idx, rec in enumerate(cmp_row_records) if rec[8] > 0]
        if not pos_indices:
            healthy_indices = [
                idx
                for idx, rec in enumerate(cmp_row_records)
                if int(rec[5].split("_")[-1]) not in spec["broken404"]
            ]
            best_idx = max(healthy_indices, key=lambda idx: cmp_row_records[idx][7])
            cmp_row_records[best_idx][8] = 1
            cmp_row_records[best_idx][9] = 1.0
            pos_indices = [best_idx]

        pos_weights = [float(cmp_row_records[idx][9]) for idx in pos_indices]
        pos_pipe_cents = _largest_remainder_cents(cmp_pipe_cents, pos_weights, min_cents=100)
        pos_map = dict(zip(pos_indices, pos_pipe_cents))

        total_clicks = 0
        total_convs = 0
        for idx, rec in enumerate(cmp_row_records):
            pipe_cents = pos_map.get(idx, 0)
            total_clicks += rec[7]
            total_convs += rec[8]
            all_rows.append(
                (rec[0], rec[1], rec[2], rec[3], rec[4], rec[5], rec[6], rec[7], rec[8], pipe_cents)
            )

        campaigns_out.append(
            {
                "campaignId": cid,
                "name": spec["name"],
                "channel": ch_name,
                "channelId": ch_id,
                "matchType": spec["matchType"],
                "adGroupCount": ag_count,
                "dailyBudget": round(daily_budget, 2),
                "totalSpend": round(cmp_spend_cents / 100.0, 2),
                "totalClicks": total_clicks,
                "totalConversions": total_convs,
                "totalPipelineValue": round(cmp_pipe_cents / 100.0, 2),
                "roas": round(cmp_pipe_cents / cmp_spend_cents, 2),
                "brokenCreatives": len(spec["broken404"]),
                "utmViolations": len(spec["utmViolations"]),
            }
        )

    broken_issues_raw.sort(key=lambda item: (item["sortPriority"], item["campaignId"], item["adGroupId"]))
    utm_issues_raw.sort(key=lambda item: (item["campaignId"], item["adGroupId"]))

    hygiene_issues: list[dict[str, Any]] = []
    for idx, raw in enumerate(broken_issues_raw + utm_issues_raw, start=1):
        hygiene_issues.append(
            {
                "issueId": f"hyg_{idx:02d}",
                "issueType": raw["issueType"],
                "status": raw["status"],
                "channel": raw["channel"],
                "channelId": raw["channelId"],
                "campaignId": raw["campaignId"],
                "campaignName": raw["campaignName"],
                "adGroupId": raw["adGroupId"],
                "value": raw["value"],
                "recommendedFix": raw["recommendedFix"],
                "dailySpendAtRisk": raw["dailySpendAtRisk"],
            }
        )

    channels_out: list[dict[str, Any]] = []
    for ch in CHANNEL_SPECS:
        ch_id = ch["channelId"]
        ch_cmps = [c for c in campaigns_out if c["channelId"] == ch_id]
        ch_issues = [h for h in hygiene_issues if h["channelId"] == ch_id and h["status"] == "active"]
        ch_spend = round(sum(c["totalSpend"] for c in ch_cmps), 2)
        ch_pipe = round(sum(c["totalPipelineValue"] for c in ch_cmps), 2)
        channels_out.append(
            {
                "channel": ch["channel"],
                "channelId": ch_id,
                "campaignCount": len(ch_cmps),
                "adGroupCount": sum(c["adGroupCount"] for c in ch_cmps),
                "dailyBudget": round(sum(c["dailyBudget"] for c in ch_cmps), 2),
                "brokenCreatives": sum(1 for h in ch_issues if h["issueType"] == "broken_404"),
                "utmViolations": sum(1 for h in ch_issues if h["issueType"] == "utm_violation"),
                "spendAtRiskPerDay": round(sum(h["dailySpendAtRisk"] for h in ch_issues), 2),
                "totalSpend": ch_spend,
                "totalPipelineValue": ch_pipe,
                "roas": round(ch_pipe / ch_spend, 2),
            }
        )

    twin_payload = {
        "seed": seed,
        "generatedForDate": GENERATED_FOR_DATE.isoformat(),
        "channels": channels_out,
        "campaigns": campaigns_out,
        "adGroups": ad_groups,
        "hygieneIssues": hygiene_issues,
    }

    all_rows.sort(key=lambda row: (row[0], row[1], row[2]))
    csv_buf = io.StringIO()
    writer = csv.writer(csv_buf, lineterminator="\n")
    writer.writerow(CSV_HEADER)
    for row in all_rows:
        writer.writerow(
            [
                row[0],
                row[3],
                row[4],
                row[5],
                f"{row[6] / 100.0:.2f}",
                row[7],
                row[8],
                f"{row[9] / 100.0:.2f}",
            ]
        )

    twin_json_text = json.dumps(twin_payload, indent=2, ensure_ascii=False) + "\n"
    rows_csv_text = csv_buf.getvalue()
    return twin_json_text, rows_csv_text


def generate_twin_files(
    output_dir: Path | str | None = None,
    seed: int = DEFAULT_SEED,
) -> dict[str, Path]:
    """Write twin.json and rows.csv deterministically to output_dir."""
    target_dir = (
        Path(output_dir)
        if output_dir is not None
        else Path(__file__).resolve().parents[1] / "backend" / "data"
    )
    target_dir.mkdir(parents=True, exist_ok=True)

    twin_json_text, rows_csv_text = build_twin_artifacts(seed=seed)
    twin_path = target_dir / "twin.json"
    rows_path = target_dir / "rows.csv"

    with open(twin_path, "w", encoding="utf-8", newline="\n") as twin_file:
        twin_file.write(twin_json_text)
    with open(rows_path, "w", encoding="utf-8", newline="") as rows_file:
        rows_file.write(rows_csv_text)

    return {"twin_json": twin_path, "rows_csv": rows_path}


def main() -> None:
    parser = argparse.ArgumentParser(description="Generate Relay Studio Digital Twin dataset.")
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=Path(__file__).resolve().parents[1] / "backend" / "data",
        help="Output directory for twin.json and rows.csv",
    )
    parser.add_argument("--seed", type=int, default=DEFAULT_SEED, help="Deterministic PRNG seed")
    args = parser.parse_args()
    generate_twin_files(output_dir=args.output_dir, seed=args.seed)


if __name__ == "__main__":
    main()
