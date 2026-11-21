"""Unit tests for the Digital Twin dataset, Pydantic v2 mutations, and state derivation."""

from __future__ import annotations

import csv
from decimal import Decimal
import hashlib
import importlib.util
import io
import json
import math
from pathlib import Path
import random
import re
import sqlite3
import sys
from typing import Any

from fastapi import FastAPI
from fastapi.testclient import TestClient
import pytest
from pydantic import BaseModel, Field, ValidationError

from app.twin import (
    BLENDED_ROAS_FORMULA,
    CHANNEL_ID_TO_NAME,
    CHANNEL_NAME_TO_ID,
    DATA_DIR,
    MAX_MUTATIONS,
    DerivedTwinState,
    FixUtmTaxonomyMutation,
    MutationList,
    PauseBrokenCreativesMutation,
    ReallocateBudgetMutation,
    TwinStateRequest,
    _find_non_finite_float,
    clear_twin_caches,
    compute_twin_state,
    get_active_hygiene_issues,
    get_data_dir,
    get_row_count,
    get_rows_csv_path,
    get_rows_csv_text,
    get_twin_json_path,
    load_base_twin,
    preview_budget_reallocation,
    validate_mutations,
)

REPO_ROOT = Path(__file__).resolve().parents[2]
GENERATOR_SCRIPT = REPO_ROOT / "scripts" / "generate_twin.py"

# Hex-encoded regex patterns so zero forbidden words or personal/internal tokens appear in source.
_HEX_HYGIENE_RULES: tuple[tuple[str, str, bool], ...] = (
    ("style_01", "5c6264656c76283f3a657c65737c65647c696e67295c62", True),
    (
        "style_02",
        "5c62283f3a69745c732b69735c732b7c69745b27e280995d735c732b293f776f7274685c732b6e6f74696e675c62",
        True,
    ),
    ("style_03", "5c62696e5c732b636f6e636c7573696f6e5c62", True),
    ("style_04", "5c626372756369616c283f3a6c79293f5c62", True),
    ("style_05", "5c6274657374616d656e74733f5c62", True),
    ("style_06", "5c6274617065737472283f3a797c696573295c62", True),
    ("style_07", "5c626c616e647363617065733f5c62", True),
    ("style_08", "5c62626561636f6e733f5c62", True),
    ("style_09", "5c626c657665726167283f3a657c65737c65647c696e67295c62", True),
    ("style_10", "5c627365616d6c657373283f3a6c797c6e657373293f5c62", True),
    (
        "style_11",
        "5c627265766f6c7574696f6e283f3a697a657c697a65737c697a65647c697a696e677c6973657c697365737c697365647c6973696e677c617279295c62",
        True,
    ),
    ("style_12", "5c6265766f6c76283f3a657c65737c65647c696e67295c62", True),
    ("id_owner", "6d6172717565737c76616c64657a7c6d61727175657376", True),
    (
        "id_infra",
        "2f7573722f6c6f63616c2f676f6f676c657c676f6f676c6572735c2e636f6d7c75706c696e6b5c2e676f6f677c6169726c6f636b2d70726f78797c61727469666163742d666f756e6472797c5c62676f6f676c65335c627c5c62636f6e636f72642d70726f645c627c5c626734645c62",
        True,
    ),
    ("id_shortlink", "5c62676f2f283f216e6f2d676f5c62295b612d7a302d395d5b612d7a302d395f2d5d2b", False),
    (
        "id_crm",
        "5c62283f3a3030317c3030337c3030367c3530307c613071295b412d5a612d7a302d395d7b31327d283f3a5b412d5a612d7a302d395d7b337d293f5c62",
        False,
    ),
    (
        "id_secret",
        "5c62283f3a6768705f7c67686f5f7c6769746875625f7061745f7c736b2d5b412d5a612d7a302d395d7b31362c7d7c76636b5f5b412d5a612d7a302d395d7b31362c7d7c41497a615b302d39412d5a612d7a5f2d5d7b33357d29",
        False,
    ),
)

_SKIPPED_WORKSPACE_DIRS: frozenset[str] = frozenset(
    {
        ".git",
        ".venv",
        "venv",
        "__pycache__",
        ".pytest_cache",
        ".mypy_cache",
        ".ruff_cache",
        "node_modules",
        ".next",
        ".vercel",
        "out",
    }
)

_SKIPPED_BINARY_SUFFIXES: frozenset[str] = frozenset(
    {
        ".png",
        ".ico",
        ".jpg",
        ".jpeg",
        ".webp",
        ".woff",
        ".woff2",
        ".ttf",
    }
)


def _collect_workspace_text_files(root: Path) -> list[Path]:
    return sorted(
        path
        for path in root.rglob("*")
        if path.is_file()
        and not any(
            part in _SKIPPED_WORKSPACE_DIRS for part in path.relative_to(root).parts
        )
        and path.suffix.lower() not in _SKIPPED_BINARY_SUFFIXES
    )


def _run_generator_into(output_dir: Path) -> None:
    spec = importlib.util.spec_from_file_location("generate_twin_mod", GENERATOR_SCRIPT)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    if hasattr(module, "generate_twin_files"):
        module.generate_twin_files(output_dir=output_dir)
    elif hasattr(module, "generate_twin"):
        module.generate_twin(output_dir=output_dir)
    else:
        raise AssertionError(
            "scripts/generate_twin.py must expose generate_twin_files(output_dir=...)"
        )


def test_data_dir_resolves_without_cwd_dependency(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.chdir(tmp_path)
    assert get_data_dir() == DATA_DIR.resolve()
    assert get_twin_json_path().is_file()
    assert get_rows_csv_path().is_file()
    assert CHANNEL_ID_TO_NAME["google_ads"] == "Google Ads"
    assert CHANNEL_NAME_TO_ID["LinkedIn Ads"] == "linkedin_ads"
    state = compute_twin_state()
    assert state.totals.rowCount == 10400


def test_seeded_grand_totals_match_section_4_1() -> None:
    state = compute_twin_state()
    totals = state.totals
    assert totals.campaignCount == 12
    assert totals.adGroupCount == 104
    assert totals.rowCount == 10400
    assert totals.dailyBudget == 6167.0
    assert totals.monthlyBudget == 185010.0
    assert totals.brokenCreatives == 14
    assert totals.utmViolations == 9
    assert totals.spendAtRiskPerDay == 1567.4
    assert totals.blendedRoas == 3.15
    assert totals.appliedMutations == 0


def test_per_channel_subtotals_match_section_4_1() -> None:
    state = compute_twin_state()
    assert [ch.channelId for ch in state.channels] == [
        "google_ads",
        "linkedin_ads",
        "meta_ads",
    ]
    by_channel = {ch.channelId: ch for ch in state.channels}

    google = by_channel["google_ads"]
    assert google.channel == "Google Ads"
    assert google.campaignCount == 5
    assert google.adGroupCount == 50
    assert google.dailyBudget == 2900.0
    assert google.brokenCreatives == 4
    assert google.utmViolations == 2
    assert all(
        c.adGroupCount == 10 for c in state.campaigns if c.channelId == "google_ads"
    )

    linkedin = by_channel["linkedin_ads"]
    assert linkedin.channel == "LinkedIn Ads"
    assert linkedin.campaignCount == 4
    assert linkedin.adGroupCount == 36
    assert linkedin.dailyBudget == 2200.0
    assert linkedin.brokenCreatives == 6
    assert linkedin.utmViolations == 3
    assert all(
        c.adGroupCount == 9 for c in state.campaigns if c.channelId == "linkedin_ads"
    )

    meta = by_channel["meta_ads"]
    assert meta.channel == "Meta Ads"
    assert meta.campaignCount == 3
    assert meta.adGroupCount == 18
    assert meta.dailyBudget == 1067.0
    assert meta.brokenCreatives == 4
    assert meta.utmViolations == 4
    assert all(
        c.adGroupCount == 6 for c in state.campaigns if c.channelId == "meta_ads"
    )


def test_seeded_roas_outliers_and_linkedin_split() -> None:
    state = compute_twin_state()
    campaigns = state.campaigns
    assert len(campaigns) == 12

    lowest = min(campaigns, key=lambda c: c.roas)
    highest = max(campaigns, key=lambda c: c.roas)

    assert lowest.campaignId == "cmp_linkedin_01"
    assert lowest.channelId == "linkedin_ads"
    assert lowest.dailyBudget == 1400.0
    assert sum(1 for c in campaigns if c.dailyBudget == 1400.0) == 1
    assert sum(1 for c in campaigns if c.roas == lowest.roas) == 1

    other_linkedin_budget = sum(
        c.dailyBudget
        for c in campaigns
        if c.channelId == "linkedin_ads" and c.campaignId != lowest.campaignId
    )
    assert round(other_linkedin_budget, 2) == 800.0

    assert highest.campaignId == "cmp_google_01"
    assert highest.channelId == "google_ads"
    assert highest.matchType == "exact"
    assert sum(1 for c in campaigns if c.matchType == "exact") == 1
    assert sum(1 for c in campaigns if c.roas == highest.roas) == 1
    assert highest.roas > lowest.roas


def test_rows_csv_schema_and_sqlite_reconciliation() -> None:
    csv_text = get_rows_csv_text()
    reader = csv.DictReader(io.StringIO(csv_text))
    assert reader.fieldnames == [
        "date",
        "channel",
        "campaign_id",
        "ad_group_id",
        "spend",
        "clicks",
        "conversions",
        "pipeline_value",
    ]
    rows = list(reader)
    assert len(rows) == 10400
    assert get_row_count() == 10400

    distinct_dates = sorted({r["date"] for r in rows})
    distinct_ad_groups = {r["ad_group_id"] for r in rows}
    assert len(distinct_dates) == 100
    assert distinct_dates[0] == "2026-08-10"
    assert distinct_dates[-1] == "2026-11-17"
    assert len(distinct_ad_groups) == 104
    assert len({(r["date"], r["ad_group_id"]) for r in rows}) == 10400

    base = load_base_twin()
    broken_ag_ids = {
        ag.adGroupId for ag in base.adGroups if ag.destinationHttpStatus == 404
    }
    assert len(broken_ag_ids) == 14
    for r in rows:
        spend_val = float(r["spend"])
        clicks_val = int(r["clicks"])
        conv_val = int(r["conversions"])
        pipe_val = float(r["pipeline_value"])
        assert spend_val >= 1.0
        assert clicks_val >= 1
        assert conv_val >= 0
        if r["ad_group_id"] in broken_ag_ids:
            assert conv_val == 0
            assert pipe_val == 0.0
        elif conv_val == 0:
            assert pipe_val == 0.0
        else:
            assert pipe_val >= 1.0

    conn = sqlite3.connect(":memory:")
    conn.execute(
        """
        CREATE TABLE rows (
            date TEXT,
            channel TEXT,
            campaign_id TEXT,
            ad_group_id TEXT,
            spend REAL,
            clicks INTEGER,
            conversions INTEGER,
            pipeline_value REAL
        )
        """
    )
    conn.executemany(
        "INSERT INTO rows VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        [
            (
                r["date"],
                r["channel"],
                r["campaign_id"],
                r["ad_group_id"],
                float(r["spend"]),
                int(r["clicks"]),
                int(r["conversions"]),
                float(r["pipeline_value"]),
            )
            for r in rows
        ],
    )

    state = compute_twin_state()
    sql_by_campaign = {
        cid: (spend, clicks, conv, pipe)
        for cid, spend, clicks, conv, pipe in conn.execute(
            """
            SELECT campaign_id,
                   ROUND(SUM(spend), 2),
                   SUM(clicks),
                   SUM(conversions),
                   ROUND(SUM(pipeline_value), 2)
            FROM rows
            GROUP BY campaign_id
            """
        ).fetchall()
    }
    assert len(sql_by_campaign) == 12
    for camp in state.campaigns:
        spend, clicks, conv, pipe = sql_by_campaign[camp.campaignId]
        assert camp.totalSpend == pytest.approx(spend, abs=0.01)
        assert camp.totalClicks == clicks
        assert camp.totalConversions == conv
        assert camp.totalPipelineValue == pytest.approx(pipe, abs=0.01)
        assert camp.roas == round(pipe / spend, 2)


def test_baseline_weighted_and_historical_roas_identity() -> None:
    state = compute_twin_state()
    total_spend = sum(ch.totalSpend for ch in state.channels)
    total_pipeline = sum(ch.totalPipelineValue for ch in state.channels)
    assert state.totals.blendedRoas == round(total_pipeline / total_spend, 2)
    for ch in state.channels:
        assert ch.roas == round(ch.totalPipelineValue / ch.totalSpend, 2)


def test_hygiene_issues_disjoint_and_spend_at_risk_additive() -> None:
    state = compute_twin_state()
    assert len(state.hygieneIssues) == 23
    assert len({i.issueId for i in state.hygieneIssues}) == 23
    assert len({i.adGroupId for i in state.hygieneIssues}) == 23
    assert sum(1 for i in state.hygieneIssues if i.issueType == "broken_404") == 14
    assert sum(1 for i in state.hygieneIssues if i.issueType == "utm_violation") == 9
    assert all(i.status == "active" and i.dailySpendAtRisk > 0 for i in state.hygieneIssues)

    for ch in state.channels:
        ch_sum = round(
            sum(
                i.dailySpendAtRisk
                for i in state.hygieneIssues
                if i.channelId == ch.channelId
            ),
            2,
        )
        assert ch.spendAtRiskPerDay == ch_sum

    total_sum = round(sum(ch.spendAtRiskPerDay for ch in state.channels), 2)
    assert state.totals.spendAtRiskPerDay == total_sum


def test_generator_determinism_into_tmp_path(tmp_path: Path) -> None:
    _run_generator_into(tmp_path)
    generated_twin_bytes = (tmp_path / "twin.json").read_bytes()
    generated_csv_bytes = (tmp_path / "rows.csv").read_bytes()
    assert generated_twin_bytes == get_twin_json_path().read_bytes()
    assert generated_csv_bytes == get_rows_csv_path().read_bytes()
    parsed_keys = list(json.loads(generated_twin_bytes.decode("utf-8")).keys())
    assert parsed_keys == [
        "seed",
        "generatedForDate",
        "channels",
        "campaigns",
        "adGroups",
        "hygieneIssues",
    ]
    assert compute_twin_state(data_dir=tmp_path) == compute_twin_state()


def test_pause_broken_creatives_mutation_and_idempotency() -> None:
    state_once = compute_twin_state([{"type": "pause_broken_creatives"}])
    assert state_once.totals.brokenCreatives == 0
    assert state_once.totals.utmViolations == 9
    assert state_once.totals.spendAtRiskPerDay == 592.33
    assert state_once.totals.appliedMutations == 1
    broken_items = [i for i in state_once.hygieneIssues if i.issueType == "broken_404"]
    utm_items = [i for i in state_once.hygieneIssues if i.issueType == "utm_violation"]
    assert all(i.status == "paused" and i.dailySpendAtRisk == 0.0 for i in broken_items)
    assert all(i.status == "active" and i.dailySpendAtRisk > 0.0 for i in utm_items)
    assert len(get_active_hygiene_issues(state_once)) == 9

    state_twice = compute_twin_state(
        [{"type": "pause_broken_creatives"}, {"type": "pause_broken_creatives"}]
    )
    assert state_twice.totals.brokenCreatives == 0
    assert state_twice.totals.spendAtRiskPerDay == state_once.totals.spendAtRiskPerDay
    assert state_twice.totals.appliedMutations == 2


def test_fix_utm_taxonomy_mutation_rewrites_canonical_utm() -> None:
    baseline = compute_twin_state()
    original_utm_values = {
        i.issueId: i.value
        for i in baseline.hygieneIssues
        if i.issueType == "utm_violation"
    }
    fixed = compute_twin_state([{"type": "fix_utm_taxonomy"}])
    assert fixed.totals.utmViolations == 0
    assert fixed.totals.brokenCreatives == 14
    assert fixed.totals.spendAtRiskPerDay == 975.07
    assert fixed.totals.appliedMutations == 1

    canonical_re = re.compile(
        r"^utm_source=(google|linkedin|meta)&utm_medium=(cpc|paid_social)"
        r"&utm_campaign=cmp_[a-z]+_\d{2}&utm_content=ag_[a-z]+_\d{2}_\d{2}$"
    )
    for item in fixed.hygieneIssues:
        if item.issueType == "utm_violation":
            assert item.status == "fixed"
            assert item.dailySpendAtRisk == 0.0
            assert item.value != original_utm_values[item.issueId]
            assert canonical_re.match(item.value) is not None
        else:
            assert item.status == "active"
    assert len(get_active_hygiene_issues(fixed)) == 14


def test_combined_hygiene_remediation_clears_all_spend_at_risk() -> None:
    baseline = compute_twin_state()
    assert len(get_active_hygiene_issues(baseline, channel_id="linkedin_ads")) == 9

    state = compute_twin_state(
        [{"type": "fix_utm_taxonomy"}, {"type": "pause_broken_creatives"}]
    )
    assert state.totals.brokenCreatives == 0
    assert state.totals.utmViolations == 0
    assert state.totals.spendAtRiskPerDay == 0.0
    assert all(ch.spendAtRiskPerDay == 0.0 for ch in state.channels)
    assert get_active_hygiene_issues(state) == []
    assert len(state.hygieneIssues) == 23


def test_single_reallocate_budget_updates_campaigns_channels_and_roas() -> None:
    base = compute_twin_state()
    low = min(base.campaigns, key=lambda c: c.roas)
    high = max(base.campaigns, key=lambda c: c.roas)

    updated = compute_twin_state(
        [
            {
                "type": "reallocate_budget",
                "from_campaign": low.campaignId,
                "to_campaign": high.campaignId,
                "amount_per_day": 500.0,
            }
        ]
    )
    assert updated.totals.dailyBudget == 6167.0
    assert updated.totals.monthlyBudget == 185010.0
    assert updated.totals.blendedRoas > base.totals.blendedRoas
    assert updated.totals.appliedMutations == 1

    by_camp = {c.campaignId: c for c in updated.campaigns}
    assert by_camp[low.campaignId].dailyBudget == 900.0
    assert by_camp[high.campaignId].dailyBudget == high.dailyBudget + 500.0

    by_ch = {ch.channelId: ch for ch in updated.channels}
    assert by_ch["linkedin_ads"].dailyBudget == 1700.0
    assert by_ch["google_ads"].dailyBudget == 3400.0

    low_issues = [i for i in updated.hygieneIssues if i.campaignId == low.campaignId]
    assert all(i.dailySpendAtRisk == 100.0 for i in low_issues)


def test_sequential_full_budget_drain_and_float_precision_triplets() -> None:
    base = compute_twin_state()
    low = min(base.campaigns, key=lambda c: c.roas)
    high = max(base.campaigns, key=lambda c: c.roas)

    drained = compute_twin_state(
        [
            {
                "type": "reallocate_budget",
                "from_campaign": low.campaignId,
                "to_campaign": high.campaignId,
                "amount_per_day": 500.0,
            },
            {
                "type": "reallocate_budget",
                "from_campaign": low.campaignId,
                "to_campaign": high.campaignId,
                "amount_per_day": 900.0,
            },
        ]
    )
    by_camp = {c.campaignId: c for c in drained.campaigns}
    assert by_camp[low.campaignId].dailyBudget == 0.0
    assert all(
        i.dailySpendAtRisk == 0.0
        for i in drained.hygieneIssues
        if i.campaignId == low.campaignId
    )

    triplet_drained = compute_twin_state(
        [
            {
                "type": "reallocate_budget",
                "from_campaign": low.campaignId,
                "to_campaign": high.campaignId,
                "amount_per_day": 466.67,
            },
            {
                "type": "reallocate_budget",
                "from_campaign": low.campaignId,
                "to_campaign": high.campaignId,
                "amount_per_day": 466.67,
            },
            {
                "type": "reallocate_budget",
                "from_campaign": low.campaignId,
                "to_campaign": high.campaignId,
                "amount_per_day": 466.66,
            },
        ]
    )
    assert {c.campaignId: c for c in triplet_drained.campaigns}[low.campaignId].dailyBudget == 0.0


def test_over_budget_by_one_cent_fails_validation() -> None:
    base = compute_twin_state()
    low = min(base.campaigns, key=lambda c: c.roas)
    high = max(base.campaigns, key=lambda c: c.roas)

    with pytest.raises(ValidationError) as exc_info:
        compute_twin_state(
            [
                {
                    "type": "reallocate_budget",
                    "from_campaign": low.campaignId,
                    "to_campaign": high.campaignId,
                    "amount_per_day": 500.0,
                },
                {
                    "type": "reallocate_budget",
                    "from_campaign": low.campaignId,
                    "to_campaign": high.campaignId,
                    "amount_per_day": 900.01,
                },
            ]
        )
    assert isinstance(exc_info.value, ValueError)


def test_chained_reallocation_order_sensitivity() -> None:
    base = compute_twin_state()
    low = min(base.campaigns, key=lambda c: c.roas)
    mid = next(
        c
        for c in base.campaigns
        if c.campaignId != low.campaignId and c.dailyBudget < 1200.0
    )
    third = next(
        c
        for c in base.campaigns
        if c.campaignId not in {low.campaignId, mid.campaignId}
    )

    top_up = 1200.0 - mid.dailyBudget + 100.0
    step_a = {
        "type": "reallocate_budget",
        "from_campaign": low.campaignId,
        "to_campaign": mid.campaignId,
        "amount_per_day": top_up,
    }
    step_b = {
        "type": "reallocate_budget",
        "from_campaign": mid.campaignId,
        "to_campaign": third.campaignId,
        "amount_per_day": 1200.0,
    }

    chained = compute_twin_state([step_a, step_b])
    assert chained.totals.appliedMutations == 2

    with pytest.raises(ValidationError):
        compute_twin_state([step_b, step_a])


def test_reallocation_round_trip_restores_exact_baseline_numbers() -> None:
    base = compute_twin_state()
    low = min(base.campaigns, key=lambda c: c.roas)
    high = max(base.campaigns, key=lambda c: c.roas)

    round_trip = compute_twin_state(
        [
            {
                "type": "reallocate_budget",
                "from_campaign": low.campaignId,
                "to_campaign": high.campaignId,
                "amount_per_day": 350.0,
            },
            {
                "type": "reallocate_budget",
                "from_campaign": high.campaignId,
                "to_campaign": low.campaignId,
                "amount_per_day": 350.0,
            },
        ]
    )
    assert round_trip.campaigns == base.campaigns
    assert round_trip.channels == base.channels
    assert round_trip.hygieneIssues == base.hygieneIssues
    assert round_trip.totals.blendedRoas == base.totals.blendedRoas
    assert round_trip.totals.dailyBudget == base.totals.dailyBudget
    assert round_trip.totals.appliedMutations == 2


def test_max_mutations_cap_50_passes_and_51_fails() -> None:
    base = compute_twin_state()
    low = min(base.campaigns, key=lambda c: c.roas)
    high = max(base.campaigns, key=lambda c: c.roas)
    unit_shift = {
        "type": "reallocate_budget",
        "from_campaign": low.campaignId,
        "to_campaign": high.campaignId,
        "amount_per_day": 10.0,
    }

    at_cap = compute_twin_state([unit_shift] * MAX_MUTATIONS)
    assert at_cap.totals.appliedMutations == 50

    with pytest.raises(ValidationError):
        compute_twin_state([unit_shift] * (MAX_MUTATIONS + 1))


@pytest.mark.parametrize(
    "payload",
    [
        {"mutations": [{"type": "pause_broken_creatives", "extra": True}]},
        {"mutations": [{"type": "fix_utm_taxonomy", "campaign": "x"}]},
        {
            "mutations": [
                {
                    "type": "reallocate_budget",
                    "from_campaign": "a",
                    "to_campaign": "b",
                    "amount_per_day": 10.0,
                    "note": "extra",
                }
            ]
        },
        {"mutations": [], "unexpectedTopLevel": 1},
    ],
)
def test_extra_fields_forbidden_on_all_variants_and_request(
    payload: dict[str, Any]
) -> None:
    with pytest.raises(ValidationError):
        TwinStateRequest.model_validate(payload)


@pytest.mark.parametrize(
    "bad_mutations",
    [
        None,
        "not-a-list",
        123,
        {"type": "pause_broken_creatives"},
        [{}],
        [{"type": "delete_campaign"}],
        [{"type": 123}],
        [{"type": None}],
    ],
)
def test_invalid_mutation_types_and_containers_rejected(bad_mutations: Any) -> None:
    with pytest.raises(ValidationError):
        validate_mutations(bad_mutations)


def test_invalid_campaign_ids_and_self_reallocation_rejected() -> None:
    valid_id = compute_twin_state().campaigns[0].campaignId
    other_id = compute_twin_state().campaigns[1].campaignId

    for invalid_item in [
        {
            "type": "reallocate_budget",
            "from_campaign": "cmp_unknown_99",
            "to_campaign": valid_id,
            "amount_per_day": 10.0,
        },
        {
            "type": "reallocate_budget",
            "from_campaign": valid_id,
            "to_campaign": "cmp_unknown_99",
            "amount_per_day": 10.0,
        },
        {
            "type": "reallocate_budget",
            "from_campaign": valid_id,
            "to_campaign": valid_id,
            "amount_per_day": 10.0,
        },
        {
            "type": "reallocate_budget",
            "from_campaign": "",
            "to_campaign": other_id,
            "amount_per_day": 10.0,
        },
        {
            "type": "reallocate_budget",
            "from_campaign": "   ",
            "to_campaign": other_id,
            "amount_per_day": 10.0,
        },
        {
            "type": "reallocate_budget",
            "from_campaign": f" {valid_id}",
            "to_campaign": other_id,
            "amount_per_day": 10.0,
        },
        {
            "type": "reallocate_budget",
            "from_campaign": f"{valid_id} ",
            "to_campaign": other_id,
            "amount_per_day": 10.0,
        },
        {
            "type": "reallocate_budget",
            "from_campaign": 123,
            "to_campaign": other_id,
            "amount_per_day": 10.0,
        },
    ]:
        with pytest.raises(ValidationError):
            compute_twin_state([invalid_item])


@pytest.mark.parametrize(
    "bad_amount",
    [
        True,
        False,
        0,
        0.0,
        -0.0,
        -1,
        -0.01,
        float("nan"),
        float("inf"),
        float("-inf"),
        "100",
        None,
        [],
        10**500,
        1e30,
        1e-12,
        5e-7,
        9.99999e-7,
        Decimal("0.0000005"),
        Decimal("NaN"),
    ],
)
def test_invalid_amount_per_day_edge_cases_rejected(bad_amount: Any) -> None:
    campaigns = compute_twin_state().campaigns
    with pytest.raises(ValidationError):
        compute_twin_state(
            [
                {
                    "type": "reallocate_budget",
                    "from_campaign": campaigns[0].campaignId,
                    "to_campaign": campaigns[1].campaignId,
                    "amount_per_day": bad_amount,
                }
            ]
        )


def test_base_cache_and_disk_immutability_across_calls() -> None:
    twin_sha_before = hashlib.sha256(get_twin_json_path().read_bytes()).hexdigest()
    csv_sha_before = hashlib.sha256(get_rows_csv_path().read_bytes()).hexdigest()

    clear_twin_caches()
    base_dataset = load_base_twin()
    with pytest.raises(ValidationError):
        base_dataset.rowCount = 0  # type: ignore[misc]

    initial_state = compute_twin_state([])
    low = min(initial_state.campaigns, key=lambda c: c.roas)
    high = max(initial_state.campaigns, key=lambda c: c.roas)

    mutated = compute_twin_state(
        [
            {"type": "pause_broken_creatives"},
            {"type": "fix_utm_taxonomy"},
            {
                "type": "reallocate_budget",
                "from_campaign": low.campaignId,
                "to_campaign": high.campaignId,
                "amount_per_day": 600.0,
            },
        ]
    )
    assert mutated != initial_state
    with pytest.raises(ValidationError):
        mutated.totals.dailyBudget = 0.0  # type: ignore[misc]

    reset_state = compute_twin_state([])
    assert reset_state == initial_state
    assert hashlib.sha256(get_twin_json_path().read_bytes()).hexdigest() == twin_sha_before
    assert hashlib.sha256(get_rows_csv_path().read_bytes()).hexdigest() == csv_sha_before


def test_preview_budget_reallocation_matches_approved_post_state() -> None:
    base = compute_twin_state()
    preview = preview_budget_reallocation([])
    assert preview.formula == BLENDED_ROAS_FORMULA
    assert preview.fromCampaign == "cmp_linkedin_01"
    assert preview.toCampaign == "cmp_google_01"
    assert preview.before.fromDailyBudget == 1400.0
    assert preview.blendedRoasBefore == base.totals.blendedRoas
    assert preview.blendedRoasAfter > preview.blendedRoasBefore

    approved = compute_twin_state(
        [
            {
                "type": "reallocate_budget",
                "from_campaign": preview.fromCampaign,
                "to_campaign": preview.toCampaign,
                "amount_per_day": preview.amountPerDay,
            }
        ]
    )
    by_camp = {c.campaignId: c for c in approved.campaigns}
    assert by_camp[preview.fromCampaign].dailyBudget == preview.after.fromDailyBudget
    assert by_camp[preview.toCampaign].dailyBudget == preview.after.toDailyBudget
    assert approved.totals.blendedRoas == preview.blendedRoasAfter

    with pytest.raises(ValueError):
        preview_budget_reallocation(
            from_campaign="cmp_google_01", to_campaign="cmp_google_01"
        )
    with pytest.raises(ValueError):
        preview_budget_reallocation(
            from_campaign="cmp_unknown", to_campaign="cmp_google_01"
        )
    with pytest.raises(ValueError):
        preview_budget_reallocation(
            from_campaign="cmp_linkedin_01",
            to_campaign="cmp_google_01",
            amount_per_day=5000.0,
        )


def test_root_deliverables_and_vercel_services_contract() -> None:
    vercel_cfg = json.loads((REPO_ROOT / "vercel.json").read_text(encoding="utf-8"))
    assert set(vercel_cfg.keys()) <= {"$schema", "services", "rewrites"}
    assert vercel_cfg["services"] == {
        "backend": {
            "root": "backend/",
            "framework": "fastapi",
            "entrypoint": "app.main:app",
        },
        "frontend": {
            "root": "frontend/",
            "framework": "nextjs",
        },
    }
    assert vercel_cfg["rewrites"] == [
        {"source": "/api/agent/(.*)", "destination": {"service": "backend"}},
        {"source": "/(.*)", "destination": {"service": "frontend"}},
    ]

    spec_a = REPO_ROOT / "01_Option_A_Relay_Studio_Vercel_App_Spec.md"
    spec_b = REPO_ROOT / "02_Option_B_Roadmap_and_Architecture_White_Paper_Spec.md"
    assert spec_a.stat().st_size == 31597
    assert spec_b.stat().st_size == 32101
    assert (
        hashlib.sha256(spec_a.read_bytes()).hexdigest()
        == "50bf34eaca397941de22cd5741611ed2a3e961f7c06fbe3d21525fc20e56f4f6"
    )
    assert (
        hashlib.sha256(spec_b.read_bytes()).hexdigest()
        == "2e3fc626ee42c3a8f1b121457cfc632c5aef16af5fdc51a4c227eb867df2c683"
    )

    env_text = (REPO_ROOT / ".env.example").read_text(encoding="utf-8")
    for required_var in (
        "VERCEL_OIDC_TOKEN=",
        "AI_GATEWAY_API_KEY=",
        "FAST_MODELS=",
        "REASONING_MODELS=",
        "GATEWAY_REPORTING_TAGS=",
        "SANDBOX_DISABLED=",
    ):
        assert required_var in env_text


def test_sanitization_and_copy_hygiene_across_twin_artifacts(tmp_path: Path) -> None:
    compiled_rules = [
        (
            name,
            re.compile(
                bytes.fromhex(hex_pat).decode("utf-8"),
                re.IGNORECASE if ignore_case else 0,
            ),
        )
        for name, hex_pat, ignore_case in _HEX_HYGIENE_RULES
    ]

    workspace_files = _collect_workspace_text_files(REPO_ROOT)
    relative_names = {path.relative_to(REPO_ROOT).as_posix() for path in workspace_files}
    expected_m1_files = {
        "README.md",
        ".env.example",
        ".gitignore",
        "vercel.json",
        "01_Option_A_Relay_Studio_Vercel_App_Spec.md",
        "02_Option_B_Roadmap_and_Architecture_White_Paper_Spec.md",
        "scripts/generate_twin.py",
        "backend/.python-version",
        "backend/pyproject.toml",
        "backend/uv.lock",
        "backend/data/twin.json",
        "backend/data/rows.csv",
        "backend/app/__init__.py",
        "backend/app/twin.py",
        "backend/tests/test_twin.py",
    }
    assert expected_m1_files <= relative_names

    # Allow only the two canonical public submission URLs inside root Markdown docs
    # while still enforcing id_owner on all remaining prose and across all code/data files.
    canonical_public_url_rx = re.compile(
        bytes.fromhex(
            "283f3a68747470733f3a2f2f293f283f3a76657263656c2d6d6172717565732d76616c64657a"
            "5c2e76657263656c5c2e6170707c6769746875625c2e636f6d2f6d6172717565732d76616c64"
            "657a2f76657263656c2d6d6172717565732d76616c64657a29283f3a2f5b5e5c735c295c223e"
            "603c5c2a5d2a293f"
        ).decode("utf-8"),
        re.IGNORECASE,
    )

    for path in workspace_files:
        text = path.read_text(encoding="utf-8")
        is_root_markdown = path.parent == REPO_ROOT and path.suffix.lower() == ".md"
        for rule_name, rx in compiled_rules:
            target_text = (
                canonical_public_url_rx.sub("", text)
                if (is_root_markdown and rule_name == "id_owner")
                else text
            )
            match = rx.search(target_text)
            assert match is None, (
                f"Hygiene rule {rule_name!r} matched {match.group(0)!r} "
                f"in {path.relative_to(REPO_ROOT)}"
            )

    # Confirm binary assets and .vercel / out directories are skipped cleanly.
    (tmp_path / ".vercel").mkdir()
    (tmp_path / ".vercel" / "project.json").write_bytes(b"\xff\xfe\x00\x01")
    (tmp_path / "frontend" / "out").mkdir(parents=True)
    (tmp_path / "frontend" / "out" / "bundle.bin").write_bytes(b"\xff\xfe")
    (tmp_path / "frontend" / "public").mkdir(parents=True)
    for ext in _SKIPPED_BINARY_SUFFIXES:
        (tmp_path / "frontend" / "public" / f"asset{ext}").write_bytes(b"\x89PNG\r\n\x1a\n\xff")
    (tmp_path / "frontend" / "page.tsx").write_text("export default function Page() {}\n", encoding="utf-8")
    collected_tmp = [p.relative_to(tmp_path).as_posix() for p in _collect_workspace_text_files(tmp_path)]
    assert collected_tmp == ["frontend/page.tsx"]

    # Confirm detector catches positive synthetic samples decoded from hex at runtime.
    synthetic_style = bytes.fromhex("64656c76696e67").decode("utf-8")
    synthetic_infra = bytes.fromhex("75706c696e6b2e676f6f67").decode("utf-8")
    assert any(rx.search(synthetic_style) for _, rx in compiled_rules)
    assert any(rx.search(synthetic_infra) for _, rx in compiled_rules)


def test_micro_shift_six_decimal_budget_conservation_and_full_drain() -> None:
    two_micro_shifts = compute_twin_state(
        [
            {
                "type": "reallocate_budget",
                "from_campaign": "cmp_linkedin_01",
                "to_campaign": "cmp_google_01",
                "amount_per_day": 0.00004,
            },
            {
                "type": "reallocate_budget",
                "from_campaign": "cmp_linkedin_01",
                "to_campaign": "cmp_meta_01",
                "amount_per_day": 0.00004,
            },
        ]
    )
    assert round(sum(ch.dailyBudget for ch in two_micro_shifts.channels), 6) == 6167.0
    assert round(sum(c.dailyBudget for c in two_micro_shifts.campaigns), 6) == 6167.0
    assert two_micro_shifts.totals.dailyBudget == 6167.0
    for ch in two_micro_shifts.channels:
        ch_camp_sum = round(
            sum(
                c.dailyBudget
                for c in two_micro_shifts.campaigns
                if c.channelId == ch.channelId
            ),
            6,
        )
        assert ch_camp_sum == ch.dailyBudget

    # Shifting 0.000001 must report exact 1399.999999 and allow draining that exact balance.
    after_quantum = compute_twin_state(
        [
            {
                "type": "reallocate_budget",
                "from_campaign": "cmp_linkedin_01",
                "to_campaign": "cmp_google_01",
                "amount_per_day": 0.000001,
            }
        ]
    )
    by_camp = {c.campaignId: c for c in after_quantum.campaigns}
    assert by_camp["cmp_linkedin_01"].dailyBudget == 1399.999999
    assert by_camp["cmp_google_01"].dailyBudget == 900.000001

    with pytest.raises(ValidationError):
        compute_twin_state(
            [
                {
                    "type": "reallocate_budget",
                    "from_campaign": "cmp_linkedin_01",
                    "to_campaign": "cmp_google_01",
                    "amount_per_day": 0.000001,
                },
                {
                    "type": "reallocate_budget",
                    "from_campaign": "cmp_linkedin_01",
                    "to_campaign": "cmp_google_01",
                    "amount_per_day": 1400.0,
                },
            ]
        )

    fully_drained = compute_twin_state(
        [
            {
                "type": "reallocate_budget",
                "from_campaign": "cmp_linkedin_01",
                "to_campaign": "cmp_google_01",
                "amount_per_day": 0.000001,
            },
            {
                "type": "reallocate_budget",
                "from_campaign": "cmp_linkedin_01",
                "to_campaign": "cmp_google_01",
                "amount_per_day": by_camp["cmp_linkedin_01"].dailyBudget,
            },
        ]
    )
    assert {c.campaignId: c for c in fully_drained.campaigns}["cmp_linkedin_01"].dailyBudget == 0.0
    assert fully_drained.totals.dailyBudget == 6167.0


def test_sub_quantum_boundary_rejected_and_exact_quantum_accepted() -> None:
    with pytest.raises(ValidationError):
        validate_mutations(
            [
                {
                    "type": "reallocate_budget",
                    "from_campaign": "cmp_linkedin_01",
                    "to_campaign": "cmp_google_01",
                    "amount_per_day": 5e-7,
                }
            ]
        )

    accepted = validate_mutations(
        [
            {
                "type": "reallocate_budget",
                "from_campaign": "cmp_linkedin_01",
                "to_campaign": "cmp_google_01",
                "amount_per_day": 1e-6,
            }
        ]
    )
    assert len(accepted) == 1


def test_preview_budget_reallocation_micro_shifts_near_drained_and_invalid_args() -> None:
    # 1. Explicit $0.000001 micro-shift preview serializes as 0.000001 and round-trips cleanly.
    micro_prev = preview_budget_reallocation(
        [],
        from_campaign="cmp_linkedin_01",
        to_campaign="cmp_google_01",
        amount_per_day=0.000001,
    )
    assert micro_prev.amountPerDay == 0.000001
    approved_micro = compute_twin_state(
        [
            {
                "type": "reallocate_budget",
                "from_campaign": micro_prev.fromCampaign,
                "to_campaign": micro_prev.toCampaign,
                "amount_per_day": micro_prev.amountPerDay,
            }
        ]
    )
    assert approved_micro.totals.dailyBudget == 6167.0

    # 2. Default-argument preview on near-drained states (0.00996, 0.00006, 0.000001 remaining).
    for shifted_out, expected_remaining in (
        (1399.99004, 0.00996),
        (1399.99994, 0.00006),
        (1399.999999, 0.000001),
    ):
        prior = [
            {
                "type": "reallocate_budget",
                "from_campaign": "cmp_linkedin_01",
                "to_campaign": "cmp_google_01",
                "amount_per_day": shifted_out,
            }
        ]
        prev = preview_budget_reallocation(prior)
        assert prev.fromCampaign == "cmp_linkedin_01"
        assert prev.amountPerDay == expected_remaining
        post_state = compute_twin_state(
            prior
            + [
                {
                    "type": "reallocate_budget",
                    "from_campaign": prev.fromCampaign,
                    "to_campaign": prev.toCampaign,
                    "amount_per_day": prev.amountPerDay,
                }
            ]
        )
        assert {c.campaignId: c for c in post_state.campaigns}["cmp_linkedin_01"].dailyBudget == 0.0
        assert post_state.totals.dailyBudget == 6167.0

    # 3. Deterministic 40-chain 6-decimal conservation + preview round-trip property sweep.
    rng = random.Random(20261118)
    base_state = compute_twin_state()
    camp_ids = [c.campaignId for c in base_state.campaigns]
    for _ in range(40):
        chain: list[dict[str, Any]] = []
        cur_state = base_state
        steps = rng.randint(1, 15)
        for _ in range(steps):
            funded_camps = [c for c in cur_state.campaigns if c.dailyBudget >= 0.000001]
            src = rng.choice(funded_camps)
            dst_id = rng.choice([cid for cid in camp_ids if cid != src.campaignId])
            max_micro = int(round(src.dailyBudget * 1_000_000))
            shift_micro = rng.randint(1, max(1, min(max_micro, 250_000_000)))
            chain.append(
                {
                    "type": "reallocate_budget",
                    "from_campaign": src.campaignId,
                    "to_campaign": dst_id,
                    "amount_per_day": round(shift_micro / 1_000_000, 6),
                }
            )
            cur_state = compute_twin_state(chain)
            assert round(sum(c.dailyBudget for c in cur_state.campaigns), 6) == 6167.0
            assert round(sum(ch.dailyBudget for ch in cur_state.channels), 6) == 6167.0

        preview = preview_budget_reallocation(chain)
        approved_chain = compute_twin_state(
            chain
            + [
                {
                    "type": "reallocate_budget",
                    "from_campaign": preview.fromCampaign,
                    "to_campaign": preview.toCampaign,
                    "amount_per_day": preview.amountPerDay,
                }
            ]
        )
        assert approved_chain.totals.dailyBudget == 6167.0

    # 4. Reject invalid default_shift_share values and non-string / untrimmed campaign IDs.
    for bad_share in (
        0.0,
        -0.5,
        1.5,
        True,
        False,
        "0.5",
        float("nan"),
        float("inf"),
        float("-inf"),
        Decimal("NaN"),
    ):
        with pytest.raises(ValueError):
            preview_budget_reallocation([], default_shift_share=bad_share)  # type: ignore[arg-type]

    for bad_cid in (123, True, "", "   ", " cmp_google_01", "cmp_google_01 "):
        with pytest.raises(ValueError):
            preview_budget_reallocation([], from_campaign=bad_cid, to_campaign="cmp_google_02")  # type: ignore[arg-type]
        with pytest.raises(ValueError):
            preview_budget_reallocation([], from_campaign="cmp_linkedin_01", to_campaign=bad_cid)  # type: ignore[arg-type]


def test_non_finite_float_errors_are_json_serializable_and_cycle_safe() -> None:
    deep_value: Any = float("nan")
    for _ in range(2500):
        deep_value = [deep_value]
    found_deep = _find_non_finite_float(deep_value)
    assert found_deep is not None and math.isnan(found_deep)

    cyclic_clean: list[Any] = [1.0, {"nested": [2.0]}]
    cyclic_clean.append(cyclic_clean)
    assert _find_non_finite_float(cyclic_clean) is None

    cyclic_inf: dict[str, Any] = {"ok": 1.0}
    cyclic_inf["self"] = cyclic_inf
    cyclic_inf["bad"] = (1, float("-inf"))
    assert _find_non_finite_float(cyclic_inf) == float("-inf")

    for fn in (
        lambda: TwinStateRequest.model_validate(float("nan")),
        lambda: TwinStateRequest.model_validate({"mutations": [], "extra": float("nan")}),
        lambda: validate_mutations([float("inf")]),
        lambda: compute_twin_state(
            [
                {
                    "type": "reallocate_budget",
                    "from_campaign": "cmp_linkedin_01",
                    "to_campaign": "cmp_google_01",
                    "amount_per_day": float("nan"),
                }
            ]
        ),
        lambda: PauseBrokenCreativesMutation.model_validate(
            {"type": "pause_broken_creatives", "extra": float("nan")}
        ),
        lambda: FixUtmTaxonomyMutation.model_validate(
            {"type": "fix_utm_taxonomy", "extra": float("-inf")}
        ),
        lambda: ReallocateBudgetMutation.model_validate(float("inf")),
    ):
        with pytest.raises(ValidationError) as exc_info:
            fn()
        serialized = json.dumps(exc_info.value.errors(), allow_nan=False)
        assert isinstance(json.loads(serialized), list)


class _MockChatRequest(BaseModel):
    twinMutations: MutationList = Field(default_factory=list)


def test_fastapi_twin_state_and_mutation_list_http_422_safety() -> None:
    app = FastAPI()

    @app.post("/api/agent/twin/state", response_model=DerivedTwinState)
    async def twin_state_route(payload: TwinStateRequest) -> DerivedTwinState:
        return compute_twin_state(payload.mutations)

    @app.post("/api/agent/mock-chat")
    async def mock_chat_route(payload: _MockChatRequest) -> dict[str, int]:
        return {"count": len(payload.twinMutations)}

    @app.post("/api/agent/mock-mutations")
    async def mock_mutations_route(mutations: MutationList) -> dict[str, int]:
        return {"count": len(mutations)}

    assert "TwinStateRequest" in json.dumps(app.openapi(), allow_nan=False)

    client = TestClient(app, raise_server_exceptions=False)

    ok_empty = client.post("/api/agent/twin/state", json={})
    assert ok_empty.status_code == 200
    assert ok_empty.json()["totals"]["dailyBudget"] == 6167.0

    ok_one = client.post(
        "/api/agent/twin/state",
        json={"mutations": [{"type": "pause_broken_creatives"}]},
    )
    assert ok_one.status_code == 200
    assert ok_one.json()["totals"]["brokenCreatives"] == 0

    raw_non_finite_vectors = [
        b'{"mutations":[{"type":"reallocate_budget","from_campaign":"cmp_linkedin_01","to_campaign":"cmp_google_01","amount_per_day":NaN}]}',
        b'{"mutations":[{"type":"reallocate_budget","from_campaign":"cmp_linkedin_01","to_campaign":"cmp_google_01","amount_per_day":Infinity}]}',
        b'{"mutations":[{"type":"reallocate_budget","from_campaign":"cmp_linkedin_01","to_campaign":"cmp_google_01","amount_per_day":-Infinity}]}',
        b'{"mutations":[{"type":"reallocate_budget","from_campaign":"cmp_linkedin_01","to_campaign":"cmp_google_01","amount_per_day":1e500}]}',
        b'{"mutations":[],"extra":NaN}',
        b'{"mutations":[NaN]}',
        b"NaN",
        b'{"mutations":[{"type":NaN}]}',
    ]
    for raw_body in raw_non_finite_vectors:
        resp = client.post(
            "/api/agent/twin/state",
            content=raw_body,
            headers={"Content-Type": "application/json"},
        )
        assert resp.status_code == 422, f"Expected 422, got {resp.status_code} for {raw_body!r}"
        body = resp.json()
        assert "detail" in body
        json.dumps(body, allow_nan=False)

    for raw_chat_body in [
        b'{"twinMutations":[{"type":"reallocate_budget","from_campaign":"cmp_linkedin_01","to_campaign":"cmp_google_01","amount_per_day":NaN}]}',
        b'{"twinMutations":[{"type":"reallocate_budget","from_campaign":"cmp_linkedin_01","to_campaign":"cmp_google_01","amount_per_day":1e500}]}',
        b'{"twinMutations":[NaN]}',
        b'{"twinMutations":Infinity}',
    ]:
        chat_resp = client.post(
            "/api/agent/mock-chat",
            content=raw_chat_body,
            headers={"Content-Type": "application/json"},
        )
        assert chat_resp.status_code == 422
        json.dumps(chat_resp.json(), allow_nan=False)

    for raw_list_body in [
        b'[{"type":"reallocate_budget","from_campaign":"cmp_linkedin_01","to_campaign":"cmp_google_01","amount_per_day":NaN}]',
        b'[{"type":"reallocate_budget","from_campaign":"cmp_linkedin_01","to_campaign":"cmp_google_01","amount_per_day":Infinity}]',
        b'[{"type":"reallocate_budget","from_campaign":"cmp_linkedin_01","to_campaign":"cmp_google_01","amount_per_day":-Infinity}]',
        b'[{"type":"reallocate_budget","from_campaign":"cmp_linkedin_01","to_campaign":"cmp_google_01","amount_per_day":1e500}]',
        b"[NaN]",
        b"NaN",
    ]:
        list_resp = client.post(
            "/api/agent/mock-mutations",
            content=raw_list_body,
            headers={"Content-Type": "application/json"},
        )
        assert list_resp.status_code == 422
        json.dumps(list_resp.json(), allow_nan=False)

    fifty_one = [
        {
            "type": "reallocate_budget",
            "from_campaign": "cmp_linkedin_01",
            "to_campaign": "cmp_google_01",
            "amount_per_day": 1.0,
        }
    ] * 51
    invalid_json_vectors: list[Any] = [
        {"mutations": fifty_one},
        {
            "mutations": [
                {
                    "type": "reallocate_budget",
                    "from_campaign": "cmp_unknown_99",
                    "to_campaign": "cmp_google_01",
                    "amount_per_day": 10.0,
                }
            ]
        },
        {
            "mutations": [
                {
                    "type": "reallocate_budget",
                    "from_campaign": "cmp_linkedin_01",
                    "to_campaign": "cmp_google_01",
                    "amount_per_day": 1000.0,
                },
                {
                    "type": "reallocate_budget",
                    "from_campaign": "cmp_linkedin_01",
                    "to_campaign": "cmp_google_01",
                    "amount_per_day": 400.01,
                },
            ]
        },
        {"mutations": [], "unexpectedField": True},
        {
            "mutations": [
                {
                    "type": "reallocate_budget",
                    "from_campaign": "cmp_google_01",
                    "to_campaign": "cmp_google_01",
                    "amount_per_day": 10.0,
                }
            ]
        },
        {
            "mutations": [
                {
                    "type": "reallocate_budget",
                    "from_campaign": "cmp_linkedin_01",
                    "to_campaign": "cmp_google_01",
                    "amount_per_day": 5e-7,
                }
            ]
        },
    ]
    for bad_payload in invalid_json_vectors:
        resp = client.post("/api/agent/twin/state", json=bad_payload)
        assert resp.status_code == 422
        assert "detail" in resp.json()
