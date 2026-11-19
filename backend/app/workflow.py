"""Workflow compiler (Temporal Python preview + share slug) and 6-step SSE dry-run engine.

Architecture role:
    Demonstrates the Option A boundary between interactive Vercel UI and
    Fieldstone's existing Temporal worker architecture:
    - `compile_workflow()` outputs a 6-node fan-out/fan-in DAG specification, a
      zero-DB `base64url` share slug (matching `frontend/lib/share.ts`), and
      display-only `temporalio` Python source representing what Fieldstone
      deploys to its production Kubernetes Temporal workers.
    - `stream_workflow_dry_run()` executes all 6 steps live in-app over SSE
      (running Step 4 inside Vercel Sandbox / SQLite fallback) so marketers can
      validate the workflow immediately without provisioning a Temporal cluster.
"""

from __future__ import annotations

import base64
from dataclasses import dataclass
import hashlib
import json
from pathlib import Path
import re
import time
from typing import Any, AsyncIterator, Final, Literal, Mapping, Sequence

from app.sandbox_runner import (
    compute_estimated_tokens_avoided,
    reset_request_sandbox_budget,
    restore_request_sandbox_budget,
    run_sandbox_query,
)
from app.twin import (
    CANONICAL_CHANNEL_ORDER,
    CHANNEL_ID_TO_NAME,
    CHANNEL_NAME_TO_ID,
    ChannelId,
    DerivedTwinState,
    Mutation,
    compute_twin_state,
    get_rows_csv_text,
    load_base_twin,
)

WorkflowTemplateId = Literal[
    "creative-404-guard",
    "cross-channel-roas",
    "paid-social-reallocation",
    "daily-pacing-guardrail",
]

WORKFLOW_TEMPLATES: Final[dict[WorkflowTemplateId, str]] = {
    "creative-404-guard": "Audit broken ad links & UTM tags",
    "cross-channel-roas": "Compare channel spend, pipeline & ROAS",
    "paid-social-reallocation": "Shift wasted social spend to top search",
    "daily-pacing-guardrail": "Daily pacing & broken-link check",
}

_TEMPLATE_ALIASES: Final[dict[str, WorkflowTemplateId]] = {
    "creative-404-guard": "creative-404-guard",
    "creative_404_guard": "creative-404-guard",
    "hygiene": "creative-404-guard",
    "cross-channel-roas": "cross-channel-roas",
    "cross_channel_roas": "cross-channel-roas",
    "roas": "cross-channel-roas",
    "paid-social-reallocation": "paid-social-reallocation",
    "paid_social_reallocation": "paid-social-reallocation",
    "reallocation": "paid-social-reallocation",
    "daily-pacing-guardrail": "daily-pacing-guardrail",
    "daily_pacing_guardrail": "daily-pacing-guardrail",
    "pacing": "daily-pacing-guardrail",
}

CANONICAL_WORKFLOW_NODES: Final[tuple[tuple[str, str], ...]] = (
    (
        "Pull active campaigns & budgets",
        "Pull active campaigns, ad groups, and daily budget caps across your selected channels.",
    ),
    (
        "Check landing pages for broken links",
        "Scan destination URLs across active ads to flag broken 404 landing pages wasting paid clicks.",
    ),
    (
        "Verify UTM tracking tags",
        "Check utm_source, utm_medium, and utm_campaign tags so paid conversions attribute cleanly in CRM.",
    ),
    (
        "Calculate channel spend & ROAS",
        "Roll up trailing spend, attributed pipeline, and return on ad spend across selected channels.",
    ),
    (
        "Check wasted-spend alert rule",
        "Flag an alert whenever daily spend on broken links or untagged ads crosses your alert threshold.",
    ),
    (
        "Send morning Slack & Sheets brief",
        "Prepare a prioritized morning brief with broken ads to pause, UTMs to fix, and channel ROAS.",
    ),
)

CANONICAL_WORKFLOW_DEPENDENCIES: Final[dict[str, tuple[str, ...]]] = {
    "Pull active campaigns & budgets": (),
    "Check landing pages for broken links": ("Pull active campaigns & budgets",),
    "Verify UTM tracking tags": ("Pull active campaigns & budgets",),
    "Calculate channel spend & ROAS": ("Pull active campaigns & budgets",),
    "Check wasted-spend alert rule": (
        "Check landing pages for broken links",
        "Verify UTM tracking tags",
        "Calculate channel spend & ROAS",
    ),
    "Send morning Slack & Sheets brief": ("Check wasted-spend alert rule",),
}

DEFAULT_WORKFLOW_TEMPLATE: Final[WorkflowTemplateId] = "daily-pacing-guardrail"
DEFAULT_THRESHOLD_PCT: Final[int] = 15
DEFAULT_CRON_SCHEDULE: Final[str] = "0 7 * * *"

_CRON_SCHEDULE_RE: Final[re.Pattern[str]] = re.compile(
    r"^[0-9*,/\-]+(?:\s+[0-9*,/\-]+){4}$"
)
_CHANNEL_ALIASES: Final[dict[str, ChannelId]] = {
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


@dataclass(frozen=True, slots=True)
class NormalizedWorkflowConfig:
    """Validated workflow configuration shared by compile_workflow and dry-run streaming."""

    template: WorkflowTemplateId
    channels: tuple[ChannelId, ...]
    threshold: int
    schedule: str


def normalize_workflow_template(template: Any = None) -> WorkflowTemplateId:
    """Validate or resolve a workflow template identifier."""
    if template is None:
        return DEFAULT_WORKFLOW_TEMPLATE
    if not isinstance(template, str):
        raise ValueError("workflow template must be a string")
    cleaned = template.strip().lower()
    if not cleaned:
        return DEFAULT_WORKFLOW_TEMPLATE
    resolved = _TEMPLATE_ALIASES.get(cleaned)
    if resolved is None:
        raise ValueError(
            f"Unsupported workflow template {template!r}; expected one of {list(WORKFLOW_TEMPLATES)}"
        )
    return resolved


def normalize_workflow_channels(channels: Any = None) -> list[ChannelId]:
    """Normalize a channel list into 1..3 canonical ChannelId values in canonical order."""
    if channels is None:
        return list(CANONICAL_CHANNEL_ORDER)
    if isinstance(channels, (str, bytes)) or not isinstance(channels, Sequence):
        raise ValueError("channels must be a list of channel identifiers")
    if len(channels) == 0:
        return list(CANONICAL_CHANNEL_ORDER)

    selected: set[ChannelId] = set()
    for raw_item in channels:
        if not isinstance(raw_item, str):
            raise ValueError("each channel identifier must be a string")
        trimmed = raw_item.strip()
        if trimmed in CHANNEL_NAME_TO_ID:
            selected.add(CHANNEL_NAME_TO_ID[trimmed])
            continue
        mapped = _CHANNEL_ALIASES.get(trimmed.lower())
        if mapped is None:
            raise ValueError(f"Unsupported channel identifier {raw_item!r}")
        selected.add(mapped)

    ordered = [ch for ch in CANONICAL_CHANNEL_ORDER if ch in selected]
    if not ordered:
        raise ValueError("At least one valid channel is required")
    return ordered


def normalize_threshold(threshold: Any = None) -> int:
    """Validate an integer alert threshold percentage between 1 and 100."""
    if threshold is None:
        return DEFAULT_THRESHOLD_PCT
    if isinstance(threshold, bool) or not isinstance(threshold, int):
        raise ValueError("threshold must be an integer between 1 and 100")
    if threshold < 1 or threshold > 100:
        raise ValueError("threshold must be between 1 and 100")
    return threshold


def normalize_schedule(schedule: Any = None) -> str:
    """Validate a standard 5-field cron schedule string."""
    if schedule is None:
        return DEFAULT_CRON_SCHEDULE
    if not isinstance(schedule, str):
        raise ValueError("schedule must be a 5-field cron string")
    cleaned = " ".join(schedule.strip().split())
    if not cleaned:
        return DEFAULT_CRON_SCHEDULE
    if len(cleaned) > 64 or not _CRON_SCHEDULE_RE.match(cleaned):
        raise ValueError("schedule must be a valid 5-field cron expression")
    return cleaned


def normalize_workflow_name(name: Any = None, fallback: str = "") -> str:
    """Normalize an optional human-readable workflow name (single-line, <= 80 chars)."""
    if name is None:
        return fallback
    if not isinstance(name, str):
        raise ValueError("workflow name must be a string")
    cleaned = " ".join(name.strip().split())
    if not cleaned:
        return fallback
    if len(cleaned) > 80:
        raise ValueError("workflow name must be at most 80 characters")
    return cleaned


def encode_playbook_slug(
    template: WorkflowTemplateId,
    channels: Sequence[ChannelId],
    threshold: int,
) -> str:
    """Encode unpadded base64url JSON matching frontend share.ts strict zod schema."""
    payload_bytes = json.dumps(
        {
            "template": template,
            "channels": list(channels),
            "threshold": threshold,
        },
        separators=(",", ":"),
        allow_nan=False,
    ).encode("utf-8")
    return base64.urlsafe_b64encode(payload_bytes).rstrip(b"=").decode("ascii")


def build_temporal_workflow_code(
    *,
    template: WorkflowTemplateId,
    title: str,
    channels: Sequence[ChannelId],
    threshold: int,
    schedule: str,
) -> str:
    """Generate display-only production Python Temporal workflow code."""
    channels_json = json.dumps(list(channels))
    return (
        '"""Generated for production on Fieldstone Kubernetes + Temporal workers.\n'
        'Display-only artifact in Relay Studio (not executed during browser dry runs)."""\n\n'
        "from __future__ import annotations\n\n"
        "import asyncio\n"
        "from dataclasses import dataclass\n"
        "from datetime import timedelta\n"
        "from temporalio import activity, workflow\n"
        "from temporalio.common import RetryPolicy\n\n"
        f"TEMPLATE_ID = {json.dumps(template)}\n"
        f"WORKFLOW_TITLE = {json.dumps(title)}\n"
        f"TARGET_CHANNELS = {channels_json}\n"
        f"ALERT_THRESHOLD_PCT = {threshold}\n"
        f"CRON_SCHEDULE = {json.dumps(schedule)}\n\n\n"
        "@dataclass(frozen=True)\n"
        "class GuardrailInput:\n"
        "    channels: list[str]\n"
        "    threshold_pct: int = ALERT_THRESHOLD_PCT\n\n\n"
        "@activity.defn\n"
        "async def fetch_channels(channels: list[str]) -> dict:\n"
        '    """Step 1: Fetch active channel budgets and campaign metadata."""\n'
        "    return {'channels': channels}\n\n\n"
        "@activity.defn\n"
        "async def check_creative_url_status(channel_snapshot: dict) -> dict:\n"
        '    """Step 2: Inspect creative destination HTTP status codes."""\n'
        "    return {'checked': True, 'snapshot': channel_snapshot}\n\n\n"
        "@activity.defn\n"
        "async def validate_utm_schema(channel_snapshot: dict) -> dict:\n"
        '    """Step 3: Validate ad group UTM source, medium, campaign, and content tags."""\n'
        "    return {'validated': True, 'snapshot': channel_snapshot}\n\n\n"
        "@activity.defn\n"
        "async def aggregate_rows_in_sandbox(channels: list[str]) -> dict:\n"
        '    """Step 4: Run parameterized SQLite summary inside Vercel Sandbox."""\n'
        "    return {'channels': channels, 'template': 'channel_roas_summary'}\n\n\n"
        "@activity.defn\n"
        "async def evaluate_threshold_gate(\n"
        "    url_report: dict,\n"
        "    utm_report: dict,\n"
        "    roas_summary: dict,\n"
        "    threshold_pct: int,\n"
        ") -> dict:\n"
        '    """Step 5: Compare daily spend at risk against the configured alert threshold."""\n'
        "    return {\n"
        "        'thresholdPct': threshold_pct,\n"
        "        'urlReport': url_report,\n"
        "        'utmReport': utm_report,\n"
        "        'roasSummary': roas_summary,\n"
        "    }\n\n\n"
        "@activity.defn\n"
        "async def format_operations_digest(gate_result: dict) -> str:\n"
        '    """Step 6: Format operator summary for Slack and Sheets delivery."""\n'
        "    return f'{WORKFLOW_TITLE}: threshold={gate_result[\"thresholdPct\"]}%'\n\n\n"
        "@workflow.defn\n"
        "class RelayCampaignGuardrailWorkflow:\n"
        '    """Six-node scheduled guardrail DAG compiled by Relay Studio."""\n\n'
        "    @workflow.run\n"
        "    async def run(self, params: GuardrailInput) -> dict:\n"
        "        retry = RetryPolicy(maximum_attempts=3)\n"
        "        timeout = timedelta(seconds=30)\n"
        "        snapshot = await workflow.execute_activity(\n"
        "            fetch_channels,\n"
        "            params.channels,\n"
        "            start_to_close_timeout=timeout,\n"
        "            retry_policy=retry,\n"
        "        )\n"
        "        url_report, utm_report, roas_summary = await asyncio.gather(\n"
        "            workflow.execute_activity(\n"
        "                check_creative_url_status,\n"
        "                snapshot,\n"
        "                start_to_close_timeout=timeout,\n"
        "                retry_policy=retry,\n"
        "            ),\n"
        "            workflow.execute_activity(\n"
        "                validate_utm_schema,\n"
        "                snapshot,\n"
        "                start_to_close_timeout=timeout,\n"
        "                retry_policy=retry,\n"
        "            ),\n"
        "            workflow.execute_activity(\n"
        "                aggregate_rows_in_sandbox,\n"
        "                params.channels,\n"
        "                start_to_close_timeout=timeout,\n"
        "                retry_policy=retry,\n"
        "            ),\n"
        "        )\n"
        "        gate_result = await workflow.execute_activity(\n"
        "            evaluate_threshold_gate,\n"
        "            args=[url_report, utm_report, roas_summary, params.threshold_pct],\n"
        "            start_to_close_timeout=timeout,\n"
        "            retry_policy=retry,\n"
        "        )\n"
        "        digest_text = await workflow.execute_activity(\n"
        "            format_operations_digest,\n"
        "            gate_result,\n"
        "            start_to_close_timeout=timeout,\n"
        "            retry_policy=retry,\n"
        "        )\n"
        "        return {'digest': digest_text, 'gate': gate_result}\n"
    )


def compile_workflow(
    *,
    name: str | None = None,
    template: str | None = None,
    channels: Sequence[str] | None = None,
    threshold: int | None = None,
    schedule: str | None = None,
) -> dict[str, Any]:
    """Compile a 6-step workflow specification, shareable base64url slug, and Temporal code."""
    norm_template = normalize_workflow_template(template)
    norm_channels = normalize_workflow_channels(channels)
    norm_threshold = normalize_threshold(threshold)
    norm_schedule = normalize_schedule(schedule)

    default_title = WORKFLOW_TEMPLATES[norm_template]
    title = normalize_workflow_name(name, fallback=default_title)
    slug = encode_playbook_slug(norm_template, norm_channels, norm_threshold)
    fingerprint_payload: dict[str, Any] = {
        "template": norm_template,
        "channels": norm_channels,
        "threshold": norm_threshold,
        "schedule": norm_schedule,
    }
    if title != default_title:
        fingerprint_payload["name"] = title
    fingerprint = hashlib.sha256(
        json.dumps(fingerprint_payload, separators=(",", ":")).encode("utf-8")
    ).hexdigest()[:10]

    steps = [
        {
            "index": idx,
            "node": node_name,
            "description": description,
            "dependsOn": list(CANONICAL_WORKFLOW_DEPENDENCIES.get(node_name, ())),
        }
        for idx, (node_name, description) in enumerate(CANONICAL_WORKFLOW_NODES)
    ]
    temporal_code = build_temporal_workflow_code(
        template=norm_template,
        title=title,
        channels=norm_channels,
        threshold=norm_threshold,
        schedule=norm_schedule,
    )

    return {
        "workflowId": f"wf_{fingerprint}",
        "title": title,
        "template": norm_template,
        "slug": slug,
        "channels": list(norm_channels),
        "threshold": norm_threshold,
        "schedule": norm_schedule,
        "steps": steps,
        "temporalCode": temporal_code,
    }


compile_workflow_spec = compile_workflow


def normalize_workflow_run_config(
    workflow: Mapping[str, Any] | None = None,
) -> NormalizedWorkflowConfig:
    """Validate optional workflow payload sent to POST /api/agent/workflows/run."""
    if workflow is None:
        return NormalizedWorkflowConfig(
            template=DEFAULT_WORKFLOW_TEMPLATE,
            channels=CANONICAL_CHANNEL_ORDER,
            threshold=DEFAULT_THRESHOLD_PCT,
            schedule=DEFAULT_CRON_SCHEDULE,
        )
    if not isinstance(workflow, Mapping):
        raise ValueError("workflow must be an object or null")
    norm_template = normalize_workflow_template(workflow.get("template"))
    norm_channels = tuple(normalize_workflow_channels(workflow.get("channels")))
    norm_threshold = normalize_threshold(workflow.get("threshold"))
    norm_schedule = normalize_schedule(workflow.get("schedule"))
    return NormalizedWorkflowConfig(
        template=norm_template,
        channels=norm_channels,
        threshold=norm_threshold,
        schedule=norm_schedule,
    )


def _format_sse_frame(payload: Mapping[str, Any]) -> str:
    return f"data: {json.dumps(payload, separators=(',', ':'), allow_nan=False)}\n\n"


async def stream_workflow_dry_run(
    *,
    config: NormalizedWorkflowConfig | None = None,
    workflow: Mapping[str, Any] | None = None,
    state: DerivedTwinState | None = None,
    mutations: Sequence[Mutation | Mapping[str, Any]] = (),
    data_dir: Path | None = None,
) -> AsyncIterator[str]:
    """Stream the 6 ordered dry-run node events over the Digital Twin and Sandbox runner."""
    resolved_cfg = config if config is not None else normalize_workflow_run_config(workflow)
    derived = state if state is not None else compute_twin_state(mutations, data_dir=data_dir)
    base_twin = load_base_twin(data_dir)

    selected_set = set(resolved_cfg.channels)
    selected_names = {CHANNEL_ID_TO_NAME[ch_id] for ch_id in resolved_cfg.channels}

    budget_token = reset_request_sandbox_budget()
    try:
        # Step 0: Fetch channels
        t0 = time.perf_counter()
        filtered_channels = [ch for ch in derived.channels if ch.channelId in selected_set]
        filtered_campaigns = [c for c in derived.campaigns if c.channelId in selected_set]
        scoped_daily_budget = round(sum(ch.dailyBudget for ch in filtered_channels), 2)
        scoped_ad_groups = sum(ch.adGroupCount for ch in filtered_channels)
        ms0 = round((time.perf_counter() - t0) * 1000.0, 2)
        yield _format_sse_frame(
            {
                "stepIndex": 0,
                "node": CANONICAL_WORKFLOW_NODES[0][0],
                "status": "completed",
                "ms": ms0,
                "mode": "twin",
                "detail": (
                    f"Pulled {len(filtered_channels)} channels, {len(filtered_campaigns)} active campaigns, "
                    f"and {scoped_ad_groups} ad groups (${scoped_daily_budget:,.2f}/day budget)."
                ),
                "summary": {
                    "channelCount": len(filtered_channels),
                    "campaignCount": len(filtered_campaigns),
                    "adGroupCount": scoped_ad_groups,
                    "dailyBudget": scoped_daily_budget,
                },
            }
        )

        # Step 1: Check creative URL status (reads twin fields only — zero outbound HTTP)
        t1 = time.perf_counter()
        scoped_base_ags = [ag for ag in base_twin.adGroups if ag.channelId in selected_set]
        broken_issues = [
            iss
            for iss in derived.hygieneIssues
            if iss.channelId in selected_set and iss.issueType == "broken_404"
        ]
        active_broken = sum(1 for iss in broken_issues if iss.status == "active")
        paused_broken = sum(1 for iss in broken_issues if iss.status == "paused")
        broken_risk = round(
            sum(iss.dailySpendAtRisk for iss in broken_issues if iss.status == "active"),
            2,
        )
        ms1 = round((time.perf_counter() - t1) * 1000.0, 2)
        yield _format_sse_frame(
            {
                "stepIndex": 1,
                "node": CANONICAL_WORKFLOW_NODES[1][0],
                "status": "completed",
                "ms": ms1,
                "mode": "twin",
                "detail": (
                    f"Checked {len(scoped_base_ags)} destination URLs: "
                    f"{active_broken} broken 404 links active, {paused_broken} paused (${broken_risk:,.2f}/day at risk)."
                ),
                "summary": {
                    "checkedAdGroups": len(scoped_base_ags),
                    "brokenCreatives": active_broken,
                    "pausedCreatives": paused_broken,
                    "spendAtRiskPerDay": broken_risk,
                },
            }
        )

        # Step 2: Validate UTM schema
        t2 = time.perf_counter()
        utm_issues = [
            iss
            for iss in derived.hygieneIssues
            if iss.channelId in selected_set and iss.issueType == "utm_violation"
        ]
        active_utm = sum(1 for iss in utm_issues if iss.status == "active")
        fixed_utm = sum(1 for iss in utm_issues if iss.status == "fixed")
        utm_risk = round(
            sum(iss.dailySpendAtRisk for iss in utm_issues if iss.status == "active"),
            2,
        )
        ms2 = round((time.perf_counter() - t2) * 1000.0, 2)
        yield _format_sse_frame(
            {
                "stepIndex": 2,
                "node": CANONICAL_WORKFLOW_NODES[2][0],
                "status": "completed",
                "ms": ms2,
                "mode": "twin",
                "detail": (
                    f"Checked UTM tags across {len(scoped_base_ags)} ad groups: "
                    f"{active_utm} tracking issues active, {fixed_utm} fixed (${utm_risk:,.2f}/day at risk)."
                ),
                "summary": {
                    "checkedAdGroups": len(scoped_base_ags),
                    "utmViolations": active_utm,
                    "fixedUtmCount": fixed_utm,
                    "spendAtRiskPerDay": utm_risk,
                },
            }
        )

        # Step 3: Aggregate rows in Sandbox
        sql_params: dict[str, Any] | None = (
            {"channel": resolved_cfg.channels[0]}
            if len(resolved_cfg.channels) == 1
            else None
        )
        sandbox_res = await run_sandbox_query(
            "channel_roas_summary",
            params=sql_params,
            data_dir=data_dir,
        )
        scoped_table = [
            row for row in sandbox_res.table if row.get("channel") in selected_names
        ]
        scoped_est_avoided = (
            sandbox_res.estTokensAvoided
            if len(scoped_table) == len(sandbox_res.table)
            else compute_estimated_tokens_avoided(get_rows_csv_text(data_dir), scoped_table)
        )
        yield _format_sse_frame(
            {
                "stepIndex": 3,
                "node": CANONICAL_WORKFLOW_NODES[3][0],
                "status": "completed",
                "ms": sandbox_res.sandboxMs,
                "mode": sandbox_res.mode,
                "detail": (
                    f"Calculated spend, pipeline, and ROAS across {len(scoped_table)} channels "
                    f"from {sandbox_res.rowsScanned:,} daily performance records."
                ),
                "summary": {
                    "rowsScanned": sandbox_res.rowsScanned,
                    "rowsReturned": len(scoped_table),
                    "estTokensAvoided": scoped_est_avoided,
                    "table": scoped_table,
                },
            }
        )

        # Step 4: Threshold gate
        t4 = time.perf_counter()
        active_risk = round(broken_risk + utm_risk, 2)
        active_issue_count = active_broken + active_utm
        risk_pct = (
            round((active_risk / scoped_daily_budget) * 100.0, 2)
            if scoped_daily_budget > 0.0
            else 0.0
        )
        gate_triggered = (risk_pct >= resolved_cfg.threshold) or (active_issue_count > 0)
        gate_outcome = "action_required" if gate_triggered else "clear"
        gate_human_label = "alert triggered" if gate_triggered else "within threshold"
        ms4 = round((time.perf_counter() - t4) * 1000.0, 2)
        yield _format_sse_frame(
            {
                "stepIndex": 4,
                "node": CANONICAL_WORKFLOW_NODES[4][0],
                "status": "completed",
                "ms": ms4,
                "mode": "twin",
                "detail": (
                    f"{risk_pct:.2f}% of daily budget is tied to broken links or UTM issues "
                    f"(alert threshold: {resolved_cfg.threshold}%, {active_issue_count} open items — {gate_human_label})."
                ),
                "summary": {
                    "thresholdPct": resolved_cfg.threshold,
                    "spendAtRiskPct": risk_pct,
                    "activeIssues": active_issue_count,
                    "gateTriggered": gate_triggered,
                    "gateOutcome": gate_outcome,
                },
            }
        )

        # Step 5: Digest (preview only — zero outbound Slack or Sheets requests)
        t5 = time.perf_counter()
        channel_digest_parts = [
            f"{ch.channel}: ${ch.dailyBudget:,.2f}/day ({ch.roas:.2f}x ROAS)"
            for ch in filtered_channels
        ]
        lowest_ch = (
            min(filtered_channels, key=lambda c: c.roas)
            if len(filtered_channels) >= 2
            else None
        )
        highest_ch = (
            max(filtered_channels, key=lambda c: c.roas)
            if len(filtered_channels) >= 2
            else None
        )
        preview_text = (
            f"[{WORKFLOW_TEMPLATES[resolved_cfg.template]}] "
            f"Blended ROAS {derived.totals.blendedRoas:.2f}x | "
            f"Broken 404 links: {active_broken} | UTM tracking issues: {active_utm} | "
            f"Daily spend at risk: ${active_risk:,.2f}/day | "
            + " · ".join(channel_digest_parts)
        )
        ms5 = round((time.perf_counter() - t5) * 1000.0, 2)
        yield _format_sse_frame(
            {
                "stepIndex": 5,
                "node": CANONICAL_WORKFLOW_NODES[5][0],
                "status": "completed",
                "ms": ms5,
                "mode": "twin",
                "detail": preview_text,
                "summary": {
                    "previewText": preview_text,
                    "delivery": "preview-only",
                    "brokenCreatives": active_broken,
                    "utmViolations": active_utm,
                    "spendAtRiskPerDay": active_risk,
                    "spendAtRiskPct": risk_pct,
                    "thresholdPct": resolved_cfg.threshold,
                    "gateTriggered": gate_triggered,
                    "blendedRoas": derived.totals.blendedRoas,
                    "lowestRoasChannel": (
                        {
                            "channel": lowest_ch.channel,
                            "channelId": lowest_ch.channelId,
                            "roas": lowest_ch.roas,
                        }
                        if lowest_ch is not None
                        else None
                    ),
                    "highestRoasChannel": (
                        {
                            "channel": highest_ch.channel,
                            "channelId": highest_ch.channelId,
                            "roas": highest_ch.roas,
                        }
                        if highest_ch is not None
                        else None
                    ),
                },
            }
        )

        yield "data: [DONE]\n\n"
    finally:
        restore_request_sandbox_budget(budget_token)
