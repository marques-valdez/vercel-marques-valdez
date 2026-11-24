"""Deterministic Digital Twin loader, Pydantic v2 mutation validator, and state engine.

Why a deterministic replay engine instead of a paid database:
    Relay Studio stays zero-datastore on Vercel Hobby by keeping the canonical
    seed dataset (`backend/data/twin.json` + `rows.csv`) read-only on disk and
    replaying up to `MAX_MUTATIONS = 50` browser-stored mutations on every
    request. Because replay is pure and deterministic, any mutation sequence
    produces identical budgets, ROAS, and hygiene counts across serverless
    instances.

Numeric precision invariant:
    Budget math uses fixed-point `Decimal` (`BUDGET_QUANTUM = 0.000001`,
    `ROUND_HALF_UP`) rather than binary floats so repeated budget shifts never
    drift by fractions of a cent or fail conservation-of-budget assertions.
"""

from __future__ import annotations

import csv
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from functools import lru_cache
import io
import json
import math
from pathlib import Path
from typing import Annotated, Any, Final, Literal, Mapping, Self, Sequence

from pydantic import (
    AfterValidator,
    BaseModel,
    ConfigDict,
    Field,
    ModelWrapValidatorHandler,
    ValidationError,
    ValidationInfo,
    ValidatorFunctionWrapHandler,
    WrapValidator,
    field_validator,
    model_validator,
)
from pydantic_core import InitErrorDetails, PydanticCustomError

DATA_DIR: Final[Path] = Path(__file__).resolve().parents[1] / "data"
MAX_MUTATIONS: Final[int] = 50
BLENDED_ROAS_FORMULA: Final[str] = "Σ(budget_i × roas_i) / Σ(budget_i)"

EXPECTED_CSV_COLUMNS: Final[tuple[str, ...]] = (
    "date",
    "channel",
    "campaign_id",
    "ad_group_id",
    "spend",
    "clicks",
    "conversions",
    "pipeline_value",
)

ChannelId = Literal["google_ads", "linkedin_ads", "meta_ads"]
IssueType = Literal["broken_404", "utm_violation"]
IssueStatus = Literal["active", "paused", "fixed"]

CANONICAL_CHANNEL_ORDER: Final[tuple[ChannelId, ...]] = (
    "google_ads",
    "linkedin_ads",
    "meta_ads",
)
CHANNEL_ID_TO_NAME: Final[dict[str, str]] = {
    "google_ads": "Google Ads",
    "linkedin_ads": "LinkedIn Ads",
    "meta_ads": "Meta Ads",
}
CHANNEL_NAME_TO_ID: Final[dict[str, ChannelId]] = {
    "Google Ads": "google_ads",
    "LinkedIn Ads": "linkedin_ads",
    "Meta Ads": "meta_ads",
}
CHANNEL_LABELS: Final[dict[str, str]] = CHANNEL_ID_TO_NAME
CHANNEL_UTM_DEFAULTS: Final[dict[str, tuple[str, str]]] = {
    "google_ads": ("google", "cpc"),
    "linkedin_ads": ("linkedin", "paid_social"),
    "meta_ads": ("meta", "paid_social"),
}

BUDGET_QUANTUM: Final[Decimal] = Decimal("0.000001")
MAX_BUDGET_INPUT: Final[float] = 1_000_000_000_000.0


def _quantize_budget(value: Decimal | float | int) -> Decimal:
    """Convert a finite numeric budget value to a 6-decimal fixed-point Decimal."""
    try:
        return Decimal(str(value)).quantize(BUDGET_QUANTUM, rounding=ROUND_HALF_UP)
    except (InvalidOperation, ValueError, OverflowError) as exc:
        raise ValueError("Invalid numeric budget amount") from exc


def _clean_float(value: float, digits: int = 2) -> float:
    """Round float cleanly and normalize -0.0 to 0.0."""
    rounded = round(float(value), digits)
    return 0.0 if rounded == 0.0 else rounded


def _budget_to_float(value: Decimal) -> float:
    """Convert a 6-decimal budget Decimal back to a clean JSON float."""
    rounded = round(float(value), 6)
    return 0.0 if rounded == 0.0 else rounded


def _find_non_finite_in_value(
    value: object,
) -> tuple[tuple[int | str, ...], float] | None:
    """Iteratively inspect scalars, mappings, and sequences for non-finite floats."""
    stack: list[tuple[tuple[int | str, ...], object]] = [((), value)]
    seen_ids: set[int] = set()
    seen_refs: list[object] = []

    while stack:
        path, curr = stack.pop()
        if (
            not isinstance(curr, bool)
            and isinstance(curr, float)
            and not math.isfinite(curr)
        ):
            return path, curr

        if isinstance(curr, Mapping):
            obj_id = id(curr)
            if obj_id in seen_ids:
                continue
            seen_ids.add(obj_id)
            seen_refs.append(curr)
            items = list(curr.items())
            for key, item in reversed(items):
                key_seg: int | str = (
                    key
                    if (isinstance(key, (int, str)) and not isinstance(key, bool))
                    else repr(key)
                )
                stack.append((path + (key_seg,), item))
                stack.append((path + (key_seg,), key))
        elif isinstance(curr, (list, tuple)):
            obj_id = id(curr)
            if obj_id in seen_ids:
                continue
            seen_ids.add(obj_id)
            seen_refs.append(curr)
            for idx in range(len(curr) - 1, -1, -1):
                stack.append((path + (idx,), curr[idx]))
        elif isinstance(curr, (set, frozenset)):
            obj_id = id(curr)
            if obj_id in seen_ids:
                continue
            seen_ids.add(obj_id)
            seen_refs.append(curr)
            for item in curr:
                stack.append((path, item))

    return None


def _find_non_finite_float(value: object) -> float | None:
    """Iteratively check scalars, mappings, and list/tuple items for non-finite floats."""
    found = _find_non_finite_in_value(value)
    return found[1] if found is not None else None


def _raise_if_non_finite_float(value: object, title: str) -> None:
    found = _find_non_finite_in_value(value)
    if found is not None:
        loc, bad_float = found
        error_detail = InitErrorDetails(
            type=PydanticCustomError(
                "finite_number",
                "Non-finite float values (NaN, Infinity, -Infinity) are not allowed",
            ),
            loc=loc,
            input=repr(bad_float),
        )
        raise ValidationError.from_exception_data(title, [error_detail])


def _guard_non_finite_wrap(
    value: Any,
    handler: ValidatorFunctionWrapHandler,
) -> Any:
    _raise_if_non_finite_float(value, "MutationList")
    return handler(value)


# ---------------------------------------------------------------------------
# Frozen Base Dataset Models (Immutable Cache Representation)
# ---------------------------------------------------------------------------


class BaseChannelRecord(BaseModel):
    model_config = ConfigDict(frozen=True, extra="ignore")

    channel: str
    channelId: ChannelId


class BaseCampaignRecord(BaseModel):
    model_config = ConfigDict(frozen=True, extra="ignore")

    campaignId: str = Field(min_length=1)
    name: str = Field(min_length=1)
    channel: str = Field(min_length=1)
    channelId: ChannelId
    matchType: str = Field(min_length=1)
    adGroupCount: int = Field(ge=1)
    dailyBudget: float = Field(ge=0.0, allow_inf_nan=False)
    totalSpend: float = Field(ge=0.0, allow_inf_nan=False)
    totalClicks: int = Field(ge=0)
    totalConversions: int = Field(ge=0)
    totalPipelineValue: float = Field(ge=0.0, allow_inf_nan=False)
    roas: float = Field(ge=0.0, allow_inf_nan=False)
    brokenCreatives: int = Field(ge=0)
    utmViolations: int = Field(ge=0)


class BaseAdGroupRecord(BaseModel):
    model_config = ConfigDict(frozen=True, extra="ignore")

    adGroupId: str = Field(min_length=1)
    name: str = Field(min_length=1)
    campaignId: str = Field(min_length=1)
    channel: str = Field(min_length=1)
    channelId: ChannelId
    creativeStatus: Literal["active", "paused"] = "active"
    destinationUrl: str = Field(min_length=1)
    destinationHttpStatus: int = 200
    utmQuery: str = Field(min_length=1)
    canonicalUtmQuery: str = Field(min_length=1)
    utmValid: bool = True


class BaseHygieneIssueRecord(BaseModel):
    model_config = ConfigDict(frozen=True, extra="ignore")

    issueId: str = Field(min_length=1)
    issueType: IssueType
    status: IssueStatus = "active"
    channel: str = Field(min_length=1)
    channelId: ChannelId
    campaignId: str = Field(min_length=1)
    campaignName: str = Field(min_length=1)
    adGroupId: str = Field(min_length=1)
    value: str = Field(min_length=1)
    canonicalValue: str | None = None
    recommendedFix: str = Field(min_length=1)
    dailySpendAtRisk: float = Field(ge=0.0, allow_inf_nan=False)
    brokenSince: str | None = None


class _RawBaseTwinFile(BaseModel):
    model_config = ConfigDict(frozen=True, extra="ignore")

    seed: int = 20261117
    generatedForDate: str = "2026-11-17"
    channels: list[BaseChannelRecord] = Field(default_factory=list)
    campaigns: list[BaseCampaignRecord]
    adGroups: list[BaseAdGroupRecord] = Field(default_factory=list)
    hygieneIssues: list[BaseHygieneIssueRecord]


class BaseTwinDataset(BaseModel):
    """Deeply immutable in-memory representation of backend/data/{twin.json,rows.csv}."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    seed: int = 20261117
    generatedForDate: str = "2026-11-17"
    channels: tuple[BaseChannelRecord, ...]
    campaigns: tuple[BaseCampaignRecord, ...]
    adGroups: tuple[BaseAdGroupRecord, ...]
    hygieneIssues: tuple[BaseHygieneIssueRecord, ...]
    rowCount: int = Field(ge=0)


# ---------------------------------------------------------------------------
# Path Resolution & Immutable Cached Loaders
# ---------------------------------------------------------------------------


def get_data_dir(data_dir: Path | None = None) -> Path:
    """Resolve the read-only Digital Twin data directory."""
    return (data_dir if data_dir is not None else DATA_DIR).resolve()


def get_twin_json_path(data_dir: Path | None = None) -> Path:
    """Return the absolute path to twin.json."""
    return get_data_dir(data_dir) / "twin.json"


def get_rows_csv_path(data_dir: Path | None = None) -> Path:
    """Return the absolute path to rows.csv."""
    return get_data_dir(data_dir) / "rows.csv"


@lru_cache(maxsize=8)
def _load_rows_csv_cached(resolved_dir: Path) -> tuple[str, int]:
    csv_path = resolved_dir / "rows.csv"
    with csv_path.open("r", encoding="utf-8", newline="") as csv_file:
        csv_text = csv_file.read()
    reader = csv.reader(io.StringIO(csv_text, newline=""))
    header = next(reader, None)
    if header is None or tuple(header) != EXPECTED_CSV_COLUMNS:
        raise ValueError(
            f"Unexpected rows.csv header {header!r}; expected {list(EXPECTED_CSV_COLUMNS)!r}"
        )
    row_count = sum(1 for row in reader if row)
    return csv_text, row_count


def get_rows_csv_text(data_dir: Path | None = None) -> str:
    """Return the cached UTF-8 text of rows.csv without modifying disk state."""
    csv_text, _ = _load_rows_csv_cached(get_data_dir(data_dir))
    return csv_text


def get_row_count(data_dir: Path | None = None) -> int:
    """Return the exact data row count in rows.csv."""
    _, row_count = _load_rows_csv_cached(get_data_dir(data_dir))
    return row_count


@lru_cache(maxsize=8)
def _load_base_twin_cached(resolved_dir: Path) -> BaseTwinDataset:
    twin_path = resolved_dir / "twin.json"
    raw_payload = json.loads(twin_path.read_text(encoding="utf-8"))
    parsed = _RawBaseTwinFile.model_validate(raw_payload)
    _, row_count = _load_rows_csv_cached(resolved_dir)

    by_channel_id = {ch.channelId: ch for ch in parsed.channels}
    ordered_channels = tuple(
        by_channel_id.get(
            ch_id,
            BaseChannelRecord(channel=CHANNEL_LABELS[ch_id], channelId=ch_id),
        )
        for ch_id in CANONICAL_CHANNEL_ORDER
    )

    return BaseTwinDataset(
        seed=parsed.seed,
        generatedForDate=parsed.generatedForDate,
        channels=ordered_channels,
        campaigns=tuple(parsed.campaigns),
        adGroups=tuple(parsed.adGroups),
        hygieneIssues=tuple(parsed.hygieneIssues),
        rowCount=row_count,
    )


def load_base_twin(data_dir: Path | None = None) -> BaseTwinDataset:
    """Return the deeply frozen cached BaseTwinDataset."""
    return _load_base_twin_cached(get_data_dir(data_dir))


def clear_twin_caches() -> None:
    """Clear in-memory LRU caches (used in isolated unit tests)."""
    _load_rows_csv_cached.cache_clear()
    _load_base_twin_cached.cache_clear()


# ---------------------------------------------------------------------------
# Strict Pydantic v2 Client Mutation Schemas & Sequential Replay Validator
# ---------------------------------------------------------------------------


class PauseBrokenCreativesMutation(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    type: Literal["pause_broken_creatives"]

    @model_validator(mode="wrap")
    @classmethod
    def _reject_non_finite_floats(
        cls,
        value: Any,
        handler: ModelWrapValidatorHandler[Self],
    ) -> Self:
        _raise_if_non_finite_float(value, cls.__name__)
        return handler(value)


class FixUtmTaxonomyMutation(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    type: Literal["fix_utm_taxonomy"]

    @model_validator(mode="wrap")
    @classmethod
    def _reject_non_finite_floats(
        cls,
        value: Any,
        handler: ModelWrapValidatorHandler[Self],
    ) -> Self:
        _raise_if_non_finite_float(value, cls.__name__)
        return handler(value)


class ReallocateBudgetMutation(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    type: Literal["reallocate_budget"]
    from_campaign: str = Field(min_length=1)
    to_campaign: str = Field(min_length=1)
    amount_per_day: float = Field(gt=0.0, allow_inf_nan=False)

    @model_validator(mode="wrap")
    @classmethod
    def _reject_non_finite_floats(
        cls,
        value: Any,
        handler: ModelWrapValidatorHandler[Self],
    ) -> Self:
        _raise_if_non_finite_float(value, cls.__name__)
        return handler(value)

    @field_validator("from_campaign", "to_campaign", mode="before")
    @classmethod
    def _validate_campaign_id(cls, value: object) -> str:
        if not isinstance(value, str):
            raise ValueError("Campaign identifier must be a string")
        trimmed = value.strip()
        if not trimmed or trimmed != value:
            raise ValueError("Campaign identifier must be a non-empty trimmed string")
        return value

    @field_validator("amount_per_day", mode="before")
    @classmethod
    def _validate_amount_per_day(cls, value: object) -> float:
        if isinstance(value, bool) or not isinstance(value, (int, float, Decimal)):
            raise ValueError("amount_per_day must be a finite positive number")
        if isinstance(value, Decimal) and not value.is_finite():
            raise ValueError("amount_per_day must be a finite number greater than 0")
        try:
            numeric = float(value)
        except (OverflowError, TypeError, ValueError, InvalidOperation) as exc:
            raise ValueError("amount_per_day must be a finite positive number") from exc
        if not math.isfinite(numeric) or numeric <= 0.0:
            raise ValueError("amount_per_day must be a finite number greater than 0")
        if numeric > MAX_BUDGET_INPUT:
            raise ValueError("amount_per_day exceeds maximum allowable budget")
        try:
            exact_dec = value if isinstance(value, Decimal) else Decimal(str(numeric))
            quantized_dec = _quantize_budget(numeric)
        except (InvalidOperation, ValueError, OverflowError) as exc:
            raise ValueError("amount_per_day must be a finite positive number") from exc
        if exact_dec < BUDGET_QUANTUM or quantized_dec < BUDGET_QUANTUM:
            raise ValueError("amount_per_day must be at least 0.000001")
        return numeric

    @model_validator(mode="after")
    def _validate_distinct_campaigns(self) -> Self:
        if self.from_campaign == self.to_campaign:
            raise ValueError("from_campaign and to_campaign must be distinct")
        return self


Mutation = Annotated[
    PauseBrokenCreativesMutation | FixUtmTaxonomyMutation | ReallocateBudgetMutation,
    Field(discriminator="type"),
    WrapValidator(_guard_non_finite_wrap),
]


def _replay_mutations(
    mutations: Sequence[Mutation],
    base_twin: BaseTwinDataset,
) -> tuple[dict[str, Decimal], bool, bool]:
    """Sequentially validate and replay mutations over fresh working copies."""
    budgets: dict[str, Decimal] = {
        camp.campaignId: _quantize_budget(camp.dailyBudget)
        for camp in base_twin.campaigns
    }
    paused_broken = False
    fixed_utm = False

    for index, mutation in enumerate(mutations):
        if isinstance(mutation, PauseBrokenCreativesMutation):
            paused_broken = True
        elif isinstance(mutation, FixUtmTaxonomyMutation):
            fixed_utm = True
        elif isinstance(mutation, ReallocateBudgetMutation):
            if mutation.from_campaign not in budgets:
                raise ValueError(
                    f"Unknown from_campaign '{mutation.from_campaign}' at mutation index {index}"
                )
            if mutation.to_campaign not in budgets:
                raise ValueError(
                    f"Unknown to_campaign '{mutation.to_campaign}' at mutation index {index}"
                )
            amount_dec = _quantize_budget(mutation.amount_per_day)
            available_dec = budgets[mutation.from_campaign]
            if amount_dec > available_dec:
                raise ValueError(
                    f"Insufficient daily budget for '{mutation.from_campaign}' at mutation index {index}: "
                    f"requested {_budget_to_float(amount_dec)}, available {_budget_to_float(available_dec)}"
                )
            budgets[mutation.from_campaign] = (available_dec - amount_dec).quantize(
                BUDGET_QUANTUM, rounding=ROUND_HALF_UP
            )
            budgets[mutation.to_campaign] = (
                budgets[mutation.to_campaign] + amount_dec
            ).quantize(BUDGET_QUANTUM, rounding=ROUND_HALF_UP)

    return budgets, paused_broken, fixed_utm


def _validate_mutation_sequence_with_info(
    mutations: list[Mutation],
    info: ValidationInfo,
) -> list[Mutation]:
    data_dir: Path | None = None
    if isinstance(info.context, Mapping):
        raw_dir = info.context.get("data_dir")
        if isinstance(raw_dir, Path):
            data_dir = raw_dir
    base_twin = load_base_twin(data_dir)
    _replay_mutations(mutations, base_twin)
    return mutations


MutationList = Annotated[
    list[Mutation],
    Field(default_factory=list, max_length=MAX_MUTATIONS),
    AfterValidator(_validate_mutation_sequence_with_info),
    WrapValidator(_guard_non_finite_wrap),
]


class TwinStateRequest(BaseModel):
    """Inbound payload for POST /api/agent/twin/state."""

    model_config = ConfigDict(extra="forbid")

    mutations: MutationList = Field(default_factory=list)

    @model_validator(mode="wrap")
    @classmethod
    def _reject_non_finite_floats(
        cls,
        value: Any,
        handler: ModelWrapValidatorHandler[Self],
    ) -> Self:
        _raise_if_non_finite_float(value, cls.__name__)
        return handler(value)


def validate_mutations(
    mutations: Any,
    *,
    data_dir: Path | None = None,
) -> list[Mutation]:
    """Validate raw or typed mutations (cap 50 + sequential budget replay) via Pydantic v2."""
    context = {"data_dir": data_dir} if data_dir is not None else None
    validated = TwinStateRequest.model_validate({"mutations": mutations}, context=context)
    return list(validated.mutations)


# ---------------------------------------------------------------------------
# Derived Twin State Response Models (PROJECT.md § Interface Contracts § 1)
# ---------------------------------------------------------------------------


class TwinTotals(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    campaignCount: int
    adGroupCount: int
    rowCount: int
    dailyBudget: float
    monthlyBudget: float
    brokenCreatives: int
    utmViolations: int
    spendAtRiskPerDay: float
    blendedRoas: float
    appliedMutations: int


class ChannelSummary(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    channel: str
    channelId: ChannelId
    campaignCount: int
    adGroupCount: int
    dailyBudget: float
    brokenCreatives: int
    utmViolations: int
    spendAtRiskPerDay: float
    totalSpend: float
    totalPipelineValue: float
    roas: float


class CampaignSummary(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    campaignId: str
    name: str
    channel: str
    channelId: ChannelId
    matchType: str
    adGroupCount: int
    dailyBudget: float
    totalSpend: float
    totalClicks: int
    totalConversions: int
    totalPipelineValue: float
    roas: float
    brokenCreatives: int
    utmViolations: int


class HygieneIssue(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    issueId: str
    issueType: IssueType
    status: IssueStatus
    channel: str
    channelId: ChannelId
    campaignId: str
    campaignName: str
    adGroupId: str
    value: str
    recommendedFix: str
    dailySpendAtRisk: float
    brokenSince: str | None = None


class DerivedTwinState(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    totals: TwinTotals
    channels: list[ChannelSummary]
    campaigns: list[CampaignSummary]
    hygieneIssues: list[HygieneIssue]


# ---------------------------------------------------------------------------
# Pure Derived State & ROAS Computation Helpers
# ---------------------------------------------------------------------------


def _campaign_intrinsic_roas(campaign: BaseCampaignRecord | CampaignSummary) -> float:
    if campaign.totalSpend > 0.0:
        return campaign.totalPipelineValue / campaign.totalSpend
    return campaign.roas


def compute_blended_roas(
    campaigns: Sequence[BaseCampaignRecord | CampaignSummary],
    budget_overrides: Mapping[str, float | Decimal] | None = None,
) -> float:
    """Compute Σ(budget_i × roas_i) / Σ(budget_i) rounded to 2 decimal places."""
    weighted_return = 0.0
    total_budget = 0.0
    for camp in campaigns:
        raw_budget = (
            float(budget_overrides[camp.campaignId])
            if budget_overrides is not None and camp.campaignId in budget_overrides
            else float(camp.dailyBudget)
        )
        weighted_return += raw_budget * _campaign_intrinsic_roas(camp)
        total_budget += raw_budget
    if total_budget <= 0.0:
        return 0.0
    return _clean_float(weighted_return / total_budget, 2)


def _canonical_utm_value(
    issue: BaseHygieneIssueRecord,
    ad_groups_by_id: Mapping[str, BaseAdGroupRecord],
) -> str:
    if issue.canonicalValue:
        return issue.canonicalValue
    ad_group = ad_groups_by_id.get(issue.adGroupId)
    if ad_group is not None:
        return ad_group.canonicalUtmQuery
    source_slug, medium_slug = CHANNEL_UTM_DEFAULTS.get(
        issue.channelId, (issue.channelId, "paid_social")
    )
    return (
        f"utm_source={source_slug}&utm_medium={medium_slug}"
        f"&utm_campaign={issue.campaignId}&utm_content={issue.adGroupId}"
    )


def _build_derived_state(
    base_twin: BaseTwinDataset,
    budgets: Mapping[str, Decimal],
    *,
    paused_broken: bool,
    fixed_utm: bool,
    applied_mutations: int,
) -> DerivedTwinState:
    base_campaigns_by_id: dict[str, BaseCampaignRecord] = {
        c.campaignId: c for c in base_twin.campaigns
    }
    base_budgets: dict[str, Decimal] = {
        c.campaignId: _quantize_budget(c.dailyBudget) for c in base_twin.campaigns
    }
    ad_groups_by_id: dict[str, BaseAdGroupRecord] = {
        ag.adGroupId: ag for ag in base_twin.adGroups
    }

    derived_issues: list[HygieneIssue] = []
    active_broken_by_campaign: dict[str, int] = {c.campaignId: 0 for c in base_twin.campaigns}
    active_utm_by_campaign: dict[str, int] = {c.campaignId: 0 for c in base_twin.campaigns}

    for base_issue in base_twin.hygieneIssues:
        status: IssueStatus = base_issue.status
        value = base_issue.value

        if base_issue.issueType == "broken_404" and paused_broken:
            status = "paused"
        elif base_issue.issueType == "utm_violation" and fixed_utm:
            status = "fixed"
            value = _canonical_utm_value(base_issue, ad_groups_by_id)

        if status == "active":
            cur_budget = budgets[base_issue.campaignId]
            orig_budget = base_budgets[base_issue.campaignId]
            orig_camp = base_campaigns_by_id[base_issue.campaignId]
            uniform_base_risk = _clean_float(orig_camp.dailyBudget / orig_camp.adGroupCount, 2)
            if cur_budget == orig_budget:
                risk = _clean_float(base_issue.dailySpendAtRisk, 2)
            elif base_issue.dailySpendAtRisk == uniform_base_risk:
                risk = _clean_float(float(cur_budget) / orig_camp.adGroupCount, 2)
            elif orig_budget > Decimal("0"):
                ratio = float(cur_budget / orig_budget)
                risk = _clean_float(base_issue.dailySpendAtRisk * ratio, 2)
            else:
                risk = 0.0

            if base_issue.issueType == "broken_404":
                active_broken_by_campaign[base_issue.campaignId] += 1
            else:
                active_utm_by_campaign[base_issue.campaignId] += 1
        else:
            risk = 0.0

        derived_issues.append(
            HygieneIssue(
                issueId=base_issue.issueId,
                issueType=base_issue.issueType,
                status=status,
                channel=base_issue.channel,
                channelId=base_issue.channelId,
                campaignId=base_issue.campaignId,
                campaignName=base_issue.campaignName,
                adGroupId=base_issue.adGroupId,
                value=value,
                recommendedFix=base_issue.recommendedFix,
                dailySpendAtRisk=risk,
                brokenSince=base_issue.brokenSince,
            )
        )

    derived_campaigns: list[CampaignSummary] = []
    for camp in base_twin.campaigns:
        derived_campaigns.append(
            CampaignSummary(
                campaignId=camp.campaignId,
                name=camp.name,
                channel=camp.channel,
                channelId=camp.channelId,
                matchType=camp.matchType,
                adGroupCount=camp.adGroupCount,
                dailyBudget=_budget_to_float(budgets[camp.campaignId]),
                totalSpend=_clean_float(camp.totalSpend, 2),
                totalClicks=camp.totalClicks,
                totalConversions=camp.totalConversions,
                totalPipelineValue=_clean_float(camp.totalPipelineValue, 2),
                roas=_clean_float(_campaign_intrinsic_roas(camp), 2),
                brokenCreatives=active_broken_by_campaign[camp.campaignId],
                utmViolations=active_utm_by_campaign[camp.campaignId],
            )
        )

    derived_channels: list[ChannelSummary] = []
    for ch_rec in base_twin.channels:
        ch_id = ch_rec.channelId
        ch_base_campaigns = [c for c in base_twin.campaigns if c.channelId == ch_id]
        ch_derived_campaigns = [c for c in derived_campaigns if ch_id == c.channelId]
        ch_active_issues = [
            iss for iss in derived_issues if iss.channelId == ch_id and iss.status == "active"
        ]

        ch_budget_dec = sum(
            (budgets[c.campaignId] for c in ch_base_campaigns),
            start=Decimal("0"),
        )
        ch_daily_budget = _budget_to_float(ch_budget_dec)
        ch_total_spend = _clean_float(sum(c.totalSpend for c in ch_base_campaigns), 2)
        ch_total_pipeline = _clean_float(
            sum(c.totalPipelineValue for c in ch_base_campaigns), 2
        )
        ch_roas = compute_blended_roas(ch_base_campaigns, budgets)

        derived_channels.append(
            ChannelSummary(
                channel=ch_rec.channel,
                channelId=ch_id,
                campaignCount=len(ch_derived_campaigns),
                adGroupCount=sum(c.adGroupCount for c in ch_derived_campaigns),
                dailyBudget=ch_daily_budget,
                brokenCreatives=sum(c.brokenCreatives for c in ch_derived_campaigns),
                utmViolations=sum(c.utmViolations for c in ch_derived_campaigns),
                spendAtRiskPerDay=_clean_float(
                    sum(iss.dailySpendAtRisk for iss in ch_active_issues), 2
                ),
                totalSpend=ch_total_spend,
                totalPipelineValue=ch_total_pipeline,
                roas=ch_roas,
            )
        )

    total_daily_budget_dec = sum(budgets.values(), start=Decimal("0"))
    total_daily_budget = _budget_to_float(total_daily_budget_dec)
    monthly_budget = _budget_to_float(total_daily_budget_dec * Decimal(30))

    totals = TwinTotals(
        campaignCount=len(derived_campaigns),
        adGroupCount=sum(c.adGroupCount for c in derived_campaigns),
        rowCount=base_twin.rowCount,
        dailyBudget=total_daily_budget,
        monthlyBudget=monthly_budget,
        brokenCreatives=sum(c.brokenCreatives for c in derived_campaigns),
        utmViolations=sum(c.utmViolations for c in derived_campaigns),
        spendAtRiskPerDay=_clean_float(
            sum(ch.spendAtRiskPerDay for ch in derived_channels), 2
        ),
        blendedRoas=compute_blended_roas(base_twin.campaigns, budgets),
        appliedMutations=applied_mutations,
    )

    return DerivedTwinState(
        totals=totals,
        channels=derived_channels,
        campaigns=derived_campaigns,
        hygieneIssues=derived_issues,
    )


def compute_twin_state(
    mutations: Sequence[Mutation | Mapping[str, Any]] = (),
    *,
    data_dir: Path | None = None,
) -> DerivedTwinState:
    """Validate mutations and compute derived Digital Twin state without mutating base data."""
    validated_mutations = validate_mutations(mutations, data_dir=data_dir)
    base_twin = load_base_twin(data_dir)
    budgets, paused_broken, fixed_utm = _replay_mutations(validated_mutations, base_twin)
    return _build_derived_state(
        base_twin,
        budgets,
        paused_broken=paused_broken,
        fixed_utm=fixed_utm,
        applied_mutations=len(validated_mutations),
    )


def get_active_hygiene_issues(
    state: DerivedTwinState,
    channel_id: ChannelId | None = None,
) -> list[HygieneIssue]:
    """Return active hygiene issues (optionally filtered by channelId) for M2 tools."""
    return [
        issue
        for issue in state.hygieneIssues
        if issue.status == "active"
        and (channel_id is None or issue.channelId == channel_id)
    ]


class ReallocationWindowMetrics(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    fromDailyBudget: float
    toDailyBudget: float
    fromRoas: float
    toRoas: float
    totalDailyBudget: float


class BudgetReallocationPreview(BaseModel):
    """Read-only preview metrics for M2 propose_budget_reallocation."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    fromCampaign: str
    fromCampaignName: str
    fromChannel: str
    toCampaign: str
    toCampaignName: str
    toChannel: str
    amountPerDay: float
    before: ReallocationWindowMetrics
    after: ReallocationWindowMetrics
    blendedRoasBefore: float
    blendedRoasAfter: float
    formula: str = BLENDED_ROAS_FORMULA


def preview_budget_reallocation(
    mutations: Sequence[Mutation | Mapping[str, Any]] = (),
    *,
    from_campaign: str | None = None,
    to_campaign: str | None = None,
    amount_per_day: float | None = None,
    default_shift_share: float = 0.5,
    data_dir: Path | None = None,
) -> BudgetReallocationPreview:
    """Compute read-only before/after reallocation metrics without mutating state."""
    if isinstance(default_shift_share, bool) or not isinstance(
        default_shift_share, (int, float, Decimal)
    ):
        raise ValueError("default_shift_share must be a finite number in (0.0, 1.0]")
    if isinstance(default_shift_share, Decimal) and not default_shift_share.is_finite():
        raise ValueError("default_shift_share must be a finite number in (0.0, 1.0]")
    try:
        share_float = float(default_shift_share)
        share_dec = (
            default_shift_share
            if isinstance(default_shift_share, Decimal)
            else Decimal(str(share_float))
        )
    except (OverflowError, TypeError, ValueError, InvalidOperation) as exc:
        raise ValueError(
            "default_shift_share must be a finite number in (0.0, 1.0]"
        ) from exc
    if (
        not math.isfinite(share_float)
        or share_float <= 0.0
        or share_float > 1.0
        or share_dec <= Decimal("0")
        or share_dec > Decimal("1")
    ):
        raise ValueError("default_shift_share must be in (0.0, 1.0]")

    for param_name, camp_id in (
        ("from_campaign", from_campaign),
        ("to_campaign", to_campaign),
    ):
        if camp_id is not None:
            if not isinstance(camp_id, str):
                raise ValueError(f"{param_name} must be a string")
            trimmed_id = camp_id.strip()
            if not trimmed_id or trimmed_id != camp_id:
                raise ValueError(f"{param_name} must be a non-empty trimmed string")

    validated_mutations = validate_mutations(mutations, data_dir=data_dir)
    base_twin = load_base_twin(data_dir)
    budgets_before, _, _ = _replay_mutations(validated_mutations, base_twin)
    state_before = compute_twin_state(validated_mutations, data_dir=data_dir)
    by_id = {c.campaignId: c for c in state_before.campaigns}

    if from_campaign is not None and from_campaign not in by_id:
        raise ValueError(f"Unknown from_campaign '{from_campaign}'")
    if to_campaign is not None and to_campaign not in by_id:
        raise ValueError(f"Unknown to_campaign '{to_campaign}'")
    if (
        from_campaign is not None
        and to_campaign is not None
        and from_campaign == to_campaign
    ):
        raise ValueError("from_campaign and to_campaign must be distinct")

    if from_campaign is None:
        all_funded = [
            c
            for c in state_before.campaigns
            if budgets_before[c.campaignId] > Decimal("0")
        ]
        if not all_funded:
            raise ValueError("No funded campaign available to reallocate from")
        funded = [c for c in all_funded if c.campaignId != to_campaign]
        if not funded:
            raise ValueError(
                "No distinct funded source campaign available to reallocate from"
            )
        source = min(
            funded,
            key=lambda c: (c.roas, -budgets_before[c.campaignId], c.campaignId),
        )
        from_campaign = source.campaignId

    if to_campaign is None:
        candidates = [
            c for c in state_before.campaigns if c.campaignId != from_campaign
        ]
        if not candidates:
            raise ValueError(
                "No distinct destination campaign available to reallocate to"
            )
        target = max(candidates, key=lambda c: (c.roas, c.campaignId))
        to_campaign = target.campaignId

    source_camp = by_id[from_campaign]
    target_camp = by_id[to_campaign]
    avail_dec = budgets_before[from_campaign]

    if amount_per_day is None:
        if avail_dec <= Decimal("0"):
            raise ValueError(
                f"Campaign '{from_campaign}' has no available daily budget to reallocate"
            )
        cent_target = (avail_dec * Decimal(str(share_float))).quantize(
            Decimal("0.01"), rounding=ROUND_HALF_UP
        )
        floored_target = max(cent_target, Decimal("0.01"))
        clamped_dec = min(floored_target, avail_dec).quantize(
            BUDGET_QUANTUM, rounding=ROUND_HALF_UP
        )
        amount_per_day = _budget_to_float(clamped_dec)

    candidate_mut = ReallocateBudgetMutation(
        type="reallocate_budget",
        from_campaign=from_campaign,
        to_campaign=to_campaign,
        amount_per_day=amount_per_day,
    )
    amount_dec = _quantize_budget(candidate_mut.amount_per_day)
    if amount_dec > avail_dec:
        raise ValueError(
            f"Requested shift {_budget_to_float(amount_dec)} exceeds current daily budget "
            f"{_budget_to_float(avail_dec)} for '{from_campaign}'"
        )

    budgets_after = dict(budgets_before)
    budgets_after[from_campaign] = (budgets_after[from_campaign] - amount_dec).quantize(
        BUDGET_QUANTUM, rounding=ROUND_HALF_UP
    )
    budgets_after[to_campaign] = (budgets_after[to_campaign] + amount_dec).quantize(
        BUDGET_QUANTUM, rounding=ROUND_HALF_UP
    )

    return BudgetReallocationPreview(
        fromCampaign=source_camp.campaignId,
        fromCampaignName=source_camp.name,
        fromChannel=source_camp.channel,
        toCampaign=target_camp.campaignId,
        toCampaignName=target_camp.name,
        toChannel=target_camp.channel,
        amountPerDay=_budget_to_float(amount_dec),
        before=ReallocationWindowMetrics(
            fromDailyBudget=_budget_to_float(avail_dec),
            toDailyBudget=_budget_to_float(budgets_before[to_campaign]),
            fromRoas=source_camp.roas,
            toRoas=target_camp.roas,
            totalDailyBudget=state_before.totals.dailyBudget,
        ),
        after=ReallocationWindowMetrics(
            fromDailyBudget=_budget_to_float(budgets_after[from_campaign]),
            toDailyBudget=_budget_to_float(budgets_after[to_campaign]),
            fromRoas=source_camp.roas,
            toRoas=target_camp.roas,
            totalDailyBudget=state_before.totals.dailyBudget,
        ),
        blendedRoasBefore=state_before.totals.blendedRoas,
        blendedRoasAfter=compute_blended_roas(base_twin.campaigns, budgets_after),
        formula=BLENDED_ROAS_FORMULA,
    )
