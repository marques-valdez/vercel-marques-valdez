"""Four structured LangGraph tools bound per request to the visitor's mutation log.

Why tools are built per request instead of at module import:
    Because the backend is stateless (zero database), each visitor's browser
    sends its own `localStorage` mutation log on every turn. Binding tools
    inside `build_agent_tools(mutations)` closes over that request's derived
    Digital Twin snapshot so concurrent visitors never share or leak state.

Safety boundary:
    - `propose_budget_reallocation` is strictly read-only: it computes exact
      before/after diffs and returns a proposal card; budgets change only after
      the user explicitly clicks Approve in the UI.
    - All numeric inputs reject Python `bool` (`isinstance(True, int)`) so
      malformed LLM tool arguments fail validation cleanly.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any, Literal, Mapping, Sequence

from langchain_core.tools import BaseTool, StructuredTool
from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.sandbox_runner import run_sandbox_query
from app.sql_templates import MAX_DAYS_WINDOW, MAX_ROW_LIMIT, TemplateInputId
from app.twin import (
    CHANNEL_NAME_TO_ID,
    ChannelId,
    Mutation,
    compute_twin_state,
    get_active_hygiene_issues,
    preview_budget_reallocation,
)
from app.workflow import compile_workflow

_HYGIENE_CHANNEL_ALIASES: dict[str, ChannelId] = {
    "google": "google_ads",
    "google ads": "google_ads",
    "google_ads": "google_ads",
    "linkedin": "linkedin_ads",
    "linkedin ads": "linkedin_ads",
    "linkedin_ads": "linkedin_ads",
    "meta": "meta_ads",
    "meta ads": "meta_ads",
    "meta_ads": "meta_ads",
}


class AuditCampaignHygieneInput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    channel: str | None = Field(
        default=None,
        description="Optional channel filter: google_ads, linkedin_ads, meta_ads, or all.",
    )


def _reject_bool_numeric_param(v: Any) -> Any:
    if isinstance(v, bool):
        raise ValueError("Boolean value is not valid for numeric parameter.")
    return v


class AnalyzeInSandboxInput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    template_id: TemplateInputId = Field(
        default="channel_roas_summary",
        description=(
            "Parameterized SQL template: channel_roas_summary, campaign_roas_ranking, "
            "daily_pacing_anomalies, or ad_group_efficiency."
        ),
    )
    channel: str | None = Field(
        default=None,
        description="Optional channel filter: google_ads, linkedin_ads, meta_ads, or all.",
    )
    days: int | None = Field(
        default=None,
        ge=1,
        le=MAX_DAYS_WINDOW,
        description="Optional trailing day window; omit to scan full history.",
    )
    sort_order: Literal["asc", "desc"] = Field(
        default="desc",
        description="Sort direction for campaign_roas_ranking.",
    )
    zero_conversions_only: bool = Field(
        default=False,
        description="When true on ad_group_efficiency, include only 0-conversion ad groups.",
    )
    limit: int = Field(
        default=20,
        ge=1,
        le=MAX_ROW_LIMIT,
        description="Maximum number of summary rows returned.",
    )

    @field_validator("days", "limit", mode="before")
    @classmethod
    def _reject_bool_days_and_limit(cls, v: Any) -> Any:
        return _reject_bool_numeric_param(v)


class ProposeBudgetReallocationInput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    from_campaign: str | None = Field(
        default=None,
        description="Source campaign ID or exact name; omit to pick lowest-ROAS funded campaign.",
    )
    to_campaign: str | None = Field(
        default=None,
        description="Target campaign ID or exact name; omit to pick highest-ROAS campaign.",
    )
    amount_per_day: float | None = Field(
        default=None,
        gt=0.0,
        allow_inf_nan=False,
        description="Daily USD shift amount; omit to shift 50% of source campaign daily budget.",
    )

    @field_validator("amount_per_day", mode="before")
    @classmethod
    def _reject_bool_amount_per_day(cls, v: Any) -> Any:
        return _reject_bool_numeric_param(v)


class CompileWorkflowInput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str | None = Field(
        default=None,
        max_length=80,
        description=(
            "Optional descriptive workflow name shown in the Workflows flyout "
            "(for example, 'LinkedIn 10% Pacing Guardrail')."
        ),
    )
    template: str = Field(
        default="daily-pacing-guardrail",
        description=(
            "Playbook template ID: daily-pacing-guardrail, creative-404-guard, "
            "cross-channel-roas, or paid-social-reallocation."
        ),
    )
    channels: list[str] | None = Field(
        default=None,
        description="Channel subset from google_ads, linkedin_ads, meta_ads.",
    )
    threshold: int = Field(
        default=15,
        ge=1,
        le=100,
        description="Spend-at-risk alert threshold percentage (1 to 100).",
    )
    schedule: str = Field(
        default="0 7 * * *",
        description="5-field UTC cron schedule for production Temporal execution.",
    )

    @field_validator("threshold", mode="before")
    @classmethod
    def _reject_bool_threshold(cls, v: Any) -> Any:
        return _reject_bool_numeric_param(v)


def _normalize_hygiene_channel(channel: str | None) -> ChannelId | None:
    if channel is None:
        return None
    trimmed = channel.strip()
    if not trimmed or trimmed.lower() in {"all", "*"}:
        return None
    if trimmed in CHANNEL_NAME_TO_ID:
        return CHANNEL_NAME_TO_ID[trimmed]
    resolved = _HYGIENE_CHANNEL_ALIASES.get(trimmed.lower())
    if resolved is None:
        raise ValueError(f"Unsupported channel filter {channel!r}")
    return resolved


def _resolve_campaign_ref(
    ref: str | None,
    campaigns: Sequence[Any],
) -> str | None:
    if ref is None:
        return None
    trimmed = ref.strip()
    if not trimmed:
        return None
    by_id = {c.campaignId: c.campaignId for c in campaigns}
    if trimmed in by_id:
        return trimmed
    lowered = trimmed.lower()
    for camp in campaigns:
        if camp.name.lower() == lowered or camp.campaignId.lower() == lowered:
            return camp.campaignId
    return trimmed


def build_agent_tools(
    mutations: Sequence[Mutation | Mapping[str, Any]] = (),
    *,
    data_dir: Path | None = None,
) -> list[BaseTool]:
    """Construct the 4 structured Relay Studio tools bound to the visitor's mutations."""
    frozen_mutations = tuple(mutations)

    async def _audit_campaign_hygiene(channel: str | None = None) -> dict[str, Any]:
        channel_id = _normalize_hygiene_channel(channel)
        state = compute_twin_state(frozen_mutations, data_dir=data_dir)
        channels_out = [
            ch.model_dump()
            for ch in state.channels
            if channel_id is None or ch.channelId == channel_id
        ]
        active_issues = get_active_hygiene_issues(state, channel_id=channel_id)
        broken_count = sum(1 for iss in active_issues if iss.issueType == "broken_404")
        utm_count = sum(1 for iss in active_issues if iss.issueType == "utm_violation")
        total_risk = round(sum(iss.dailySpendAtRisk for iss in active_issues), 2)
        return {
            "brokenCount": broken_count,
            "utmCount": utm_count,
            "totalSpendAtRiskPerDay": 0.0 if total_risk == 0.0 else total_risk,
            "channels": channels_out,
            "flaggedItems": [iss.model_dump() for iss in active_issues],
        }

    async def _analyze_in_sandbox(
        template_id: TemplateInputId = "channel_roas_summary",
        channel: str | None = None,
        days: int | None = None,
        sort_order: Literal["asc", "desc"] = "desc",
        zero_conversions_only: bool = False,
        limit: int = 20,
    ) -> dict[str, Any]:
        query_params: dict[str, Any] = {
            "channel": channel,
            "days": days,
            "sort_order": sort_order,
            "zero_conversions_only": zero_conversions_only,
            "limit": limit,
        }
        result = await run_sandbox_query(
            template_id,
            query_params,
            data_dir=data_dir,
        )
        return result.model_dump()

    async def _propose_budget_reallocation(
        from_campaign: str | None = None,
        to_campaign: str | None = None,
        amount_per_day: float | None = None,
    ) -> dict[str, Any]:
        # Run SQLite campaign ROAS aggregation without consuming the request's single remote microVM slot.
        await run_sandbox_query(
            "campaign_roas_ranking",
            prefer_in_process=True,
            data_dir=data_dir,
        )
        current_state = compute_twin_state(frozen_mutations, data_dir=data_dir)
        resolved_from = _resolve_campaign_ref(from_campaign, current_state.campaigns)
        resolved_to = _resolve_campaign_ref(to_campaign, current_state.campaigns)

        preview = preview_budget_reallocation(
            frozen_mutations,
            from_campaign=resolved_from,
            to_campaign=resolved_to,
            amount_per_day=amount_per_day,
            data_dir=data_dir,
        )
        digest = hashlib.sha256(
            json.dumps(
                {
                    "from": preview.fromCampaign,
                    "to": preview.toCampaign,
                    "amount": preview.amountPerDay,
                    "applied": current_state.totals.appliedMutations,
                },
                separators=(",", ":"),
            ).encode("utf-8")
        ).hexdigest()[:10]
        return {
            "proposalId": f"prop_{digest}",
            **preview.model_dump(),
        }

    async def _compile_workflow(
        name: str | None = None,
        template: str = "daily-pacing-guardrail",
        channels: list[str] | None = None,
        threshold: int = 15,
        schedule: str = "0 7 * * *",
    ) -> dict[str, Any]:
        return compile_workflow(
            name=name,
            template=template,
            channels=channels,
            threshold=threshold,
            schedule=schedule,
        )

    return [
        StructuredTool.from_function(
            coroutine=_audit_campaign_hygiene,
            name="audit_campaign_hygiene",
            description=(
                "Audit active broken 404 destination URLs and UTM taxonomy violations "
                "across Google Ads, LinkedIn Ads, and Meta Ads from Digital Twin state."
            ),
            args_schema=AuditCampaignHygieneInput,
        ),
        StructuredTool.from_function(
            coroutine=_analyze_in_sandbox,
            name="analyze_in_sandbox",
            description=(
                "Execute a parameterized SQLite aggregation over daily campaign performance "
                "rows in Vercel Sandbox (with badged in-process fallback) and return summary rows."
            ),
            args_schema=AnalyzeInSandboxInput,
        ),
        StructuredTool.from_function(
            coroutine=_propose_budget_reallocation,
            name="propose_budget_reallocation",
            description=(
                "Compute a read-only daily budget reallocation proposal shifting spend from "
                "a low-ROAS campaign to a high-ROAS campaign without mutating twin state."
            ),
            args_schema=ProposeBudgetReallocationInput,
        ),
        StructuredTool.from_function(
            coroutine=_compile_workflow,
            name="compile_workflow",
            description=(
                "Compile a 6-step campaign operations workflow specification, shareable slug, "
                "and display-only production Python Temporal workflow code."
            ),
            args_schema=CompileWorkflowInput,
        ),
    ]
