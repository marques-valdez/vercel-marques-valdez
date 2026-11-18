"""Parameterized SQLite analytics templates over Digital Twin daily performance rows."""

from __future__ import annotations

from dataclasses import dataclass
import re
from typing import Any, Final, Literal, Mapping

from app.twin import CHANNEL_ID_TO_NAME, CHANNEL_NAME_TO_ID

TemplateId = Literal[
    "channel_roas_summary",
    "campaign_roas_ranking",
    "daily_pacing_anomalies",
    "ad_group_efficiency",
]

TemplateInputId = Literal[
    "channel_roas_summary",
    "campaign_roas_ranking",
    "daily_pacing_anomalies",
    "ad_group_efficiency",
    "channel_summary",
    "campaign_roas",
    "campaign_ranking",
    "daily_pacing",
    "ad_groups",
    "ad_group_outliers",
]

TEMPLATE_IDS: Final[tuple[TemplateId, ...]] = (
    "channel_roas_summary",
    "campaign_roas_ranking",
    "daily_pacing_anomalies",
    "ad_group_efficiency",
)

TEMPLATE_ALIASES: Final[dict[str, TemplateId]] = {
    "channel_roas_summary": "channel_roas_summary",
    "channel_summary": "channel_roas_summary",
    "campaign_roas_ranking": "campaign_roas_ranking",
    "campaign_roas": "campaign_roas_ranking",
    "campaign_ranking": "campaign_roas_ranking",
    "daily_pacing_anomalies": "daily_pacing_anomalies",
    "daily_pacing": "daily_pacing_anomalies",
    "ad_group_efficiency": "ad_group_efficiency",
    "ad_groups": "ad_group_efficiency",
    "ad_group_outliers": "ad_group_efficiency",
}

DEFAULT_ROW_LIMIT: Final[int] = 20
MAX_ROW_LIMIT: Final[int] = 50
MAX_DAYS_WINDOW: Final[int] = 365

_ISO_DATE_RE: Final[re.Pattern[str]] = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_CAMPAIGN_ID_RE: Final[re.Pattern[str]] = re.compile(r"^[A-Za-z0-9_-]{1,64}$")

_SORT_DIRECTIONS: Final[dict[str, str]] = {
    "asc": "ASC",
    "desc": "DESC",
}

_CHANNEL_SHORT_ALIASES: Final[dict[str, str]] = {
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
class CompiledSqlQuery:
    """Validated parameterized SQLite query ready for Sandbox or in-process execution."""

    template_id: TemplateId
    sql: str
    params: tuple[Any, ...]


def normalize_template_id(template_id: str | None) -> TemplateId:
    """Resolve a canonical or friendly template identifier to one of the 4 SQL templates."""
    if template_id is None:
        return "channel_roas_summary"
    if not isinstance(template_id, str):
        raise ValueError("template_id must be a string")
    cleaned = template_id.strip().lower().replace("-", "_")
    if not cleaned:
        return "channel_roas_summary"
    resolved = TEMPLATE_ALIASES.get(cleaned)
    if resolved is None:
        raise ValueError(
            f"Unknown SQL template {template_id!r}; expected one of {list(TEMPLATE_IDS)}"
        )
    return resolved


def normalize_channel_filter(channel: str | None) -> str | None:
    """Normalize a channel slug or display label into the exact rows.csv channel value."""
    if channel is None:
        return None
    if not isinstance(channel, str):
        raise ValueError("channel filter must be a string or None")
    trimmed = channel.strip()
    if not trimmed or trimmed.lower() in {"all", "*"}:
        return None
    if trimmed in CHANNEL_NAME_TO_ID:
        return trimmed
    if trimmed in CHANNEL_ID_TO_NAME:
        return CHANNEL_ID_TO_NAME[trimmed]
    canonical_id = _CHANNEL_SHORT_ALIASES.get(trimmed.lower())
    if canonical_id is not None:
        return CHANNEL_ID_TO_NAME[canonical_id]
    raise ValueError(f"Unsupported channel filter {channel!r}")


def _validate_iso_date(value: Any, field_name: str) -> str:
    if not isinstance(value, str) or not _ISO_DATE_RE.match(value.strip()):
        raise ValueError(f"{field_name} must match YYYY-MM-DD")
    return value.strip()


def _validate_limit(value: Any) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise ValueError("limit must be an integer")
    if value < 1 or value > MAX_ROW_LIMIT:
        raise ValueError(f"limit must be between 1 and {MAX_ROW_LIMIT}")
    return value


def _build_where_clause(
    raw_params: Mapping[str, Any],
) -> tuple[str, list[Any]]:
    clauses: list[str] = []
    bound: list[Any] = []

    channel_name = normalize_channel_filter(raw_params.get("channel"))
    if channel_name is not None:
        clauses.append("channel = ?")
        bound.append(channel_name)

    campaign_id = raw_params.get("campaign_id")
    if campaign_id is not None:
        if not isinstance(campaign_id, str) or not _CAMPAIGN_ID_RE.match(campaign_id.strip()):
            raise ValueError("campaign_id must be an alphanumeric identifier")
        clauses.append("campaign_id = ?")
        bound.append(campaign_id.strip())

    start_date = raw_params.get("start_date")
    if start_date is not None:
        clauses.append("date >= ?")
        bound.append(_validate_iso_date(start_date, "start_date"))

    end_date = raw_params.get("end_date")
    if end_date is not None:
        clauses.append("date <= ?")
        bound.append(_validate_iso_date(end_date, "end_date"))

    days = raw_params.get("days")
    if days is not None:
        if isinstance(days, bool) or not isinstance(days, int):
            raise ValueError("days must be a positive integer")
        if days < 1 or days > MAX_DAYS_WINDOW:
            raise ValueError(f"days must be between 1 and {MAX_DAYS_WINDOW}")
        clauses.append(
            "date IN (SELECT DISTINCT date FROM rows ORDER BY date DESC LIMIT ?)"
        )
        bound.append(days)

    if not clauses:
        return "", bound
    return "WHERE " + " AND ".join(clauses) + "\n", bound


def compile_sql_template(
    template_id: str = "channel_roas_summary",
    params: Mapping[str, Any] | None = None,
) -> CompiledSqlQuery:
    """Compile a fixed parameterized SQLite query template with bound ? placeholders."""
    resolved_id = normalize_template_id(template_id)
    raw_params: Mapping[str, Any] = params if params is not None else {}
    if not isinstance(raw_params, Mapping):
        raise ValueError("params must be a mapping")

    raw_sort = raw_params.get("sort_order", "desc")
    if not isinstance(raw_sort, str) or raw_sort.strip().lower() not in _SORT_DIRECTIONS:
        raise ValueError("sort_order must be 'asc' or 'desc'")
    sort_sql = _SORT_DIRECTIONS[raw_sort.strip().lower()]

    zero_only = raw_params.get("zero_conversions_only")
    if zero_only is not None and not isinstance(zero_only, bool):
        raise ValueError("zero_conversions_only must be a boolean")

    limit_val = _validate_limit(raw_params.get("limit", DEFAULT_ROW_LIMIT))

    if resolved_id == "channel_roas_summary":
        where_sql, bound = _build_where_clause(raw_params)
        bound.append(limit_val)
        sql = (
            "SELECT\n"
            "  channel,\n"
            "  COUNT(DISTINCT campaign_id) AS campaigns,\n"
            "  COUNT(DISTINCT ad_group_id) AS ad_groups,\n"
            "  COUNT(*) AS row_count,\n"
            "  ROUND(SUM(spend), 2) AS total_spend,\n"
            "  SUM(clicks) AS total_clicks,\n"
            "  SUM(conversions) AS total_conversions,\n"
            "  ROUND(SUM(pipeline_value), 2) AS total_pipeline_value,\n"
            "  COALESCE(ROUND(SUM(pipeline_value) / NULLIF(SUM(spend), 0), 2), 0.0) AS roas,\n"
            "  COALESCE(ROUND(SUM(spend) / NULLIF(SUM(clicks), 0), 2), 0.0) AS cpc,\n"
            "  ROUND(SUM(spend) / NULLIF(SUM(conversions), 0), 2) AS cpa\n"
            "FROM rows\n"
            f"{where_sql}"
            "GROUP BY channel\n"
            "ORDER BY roas DESC, channel ASC\n"
            "LIMIT ?;"
        )
        return CompiledSqlQuery(template_id=resolved_id, sql=sql, params=tuple(bound))

    if resolved_id == "campaign_roas_ranking":
        where_sql, bound = _build_where_clause(raw_params)
        bound.append(limit_val)
        sql = (
            "SELECT\n"
            "  campaign_id,\n"
            "  channel,\n"
            "  COUNT(DISTINCT ad_group_id) AS ad_groups,\n"
            "  COUNT(DISTINCT date) AS active_days,\n"
            "  ROUND(SUM(spend), 2) AS total_spend,\n"
            "  SUM(clicks) AS total_clicks,\n"
            "  SUM(conversions) AS total_conversions,\n"
            "  ROUND(SUM(pipeline_value), 2) AS total_pipeline_value,\n"
            "  COALESCE(ROUND(SUM(pipeline_value) / NULLIF(SUM(spend), 0), 2), 0.0) AS roas,\n"
            "  ROUND(SUM(spend) / NULLIF(SUM(conversions), 0), 2) AS cpa\n"
            "FROM rows\n"
            f"{where_sql}"
            "GROUP BY campaign_id, channel\n"
            f"ORDER BY roas {sort_sql}, campaign_id ASC\n"
            "LIMIT ?;"
        )
        return CompiledSqlQuery(template_id=resolved_id, sql=sql, params=tuple(bound))

    if resolved_id == "daily_pacing_anomalies":
        where_sql, bound = _build_where_clause(raw_params)
        indented_where = (
            "  " + where_sql.replace("\n", "\n  ").rstrip(" ") if where_sql else ""
        )
        bound.append(limit_val)
        sql = (
            "WITH daily_channel AS (\n"
            "  SELECT\n"
            "    date,\n"
            "    channel,\n"
            "    ROUND(SUM(spend), 2) AS total_spend,\n"
            "    SUM(clicks) AS total_clicks,\n"
            "    SUM(conversions) AS total_conversions,\n"
            "    ROUND(SUM(pipeline_value), 2) AS total_pipeline_value,\n"
            "    COALESCE(ROUND(SUM(pipeline_value) / NULLIF(SUM(spend), 0), 2), 0.0) AS roas\n"
            "  FROM rows\n"
            f"{indented_where}"
            "  GROUP BY date, channel\n"
            "),\n"
            "channel_baseline AS (\n"
            "  SELECT\n"
            "    channel,\n"
            "    ROUND(AVG(total_spend), 2) AS avg_daily_spend\n"
            "  FROM daily_channel\n"
            "  GROUP BY channel\n"
            ")\n"
            "SELECT\n"
            "  d.date AS date,\n"
            "  d.channel AS channel,\n"
            "  d.total_spend AS total_spend,\n"
            "  b.avg_daily_spend AS avg_daily_spend,\n"
            "  COALESCE(ROUND(((d.total_spend - b.avg_daily_spend) / NULLIF(b.avg_daily_spend, 0)) * 100.0, 2), 0.0) AS spend_delta_pct,\n"
            "  d.total_clicks AS total_clicks,\n"
            "  d.total_conversions AS total_conversions,\n"
            "  d.total_pipeline_value AS total_pipeline_value,\n"
            "  d.roas AS roas\n"
            "FROM daily_channel AS d\n"
            "JOIN channel_baseline AS b ON d.channel = b.channel\n"
            "ORDER BY ROUND(ABS(d.total_spend - b.avg_daily_spend), 2) DESC, d.date DESC, d.channel ASC\n"
            "LIMIT ?;"
        )
        return CompiledSqlQuery(template_id=resolved_id, sql=sql, params=tuple(bound))

    where_sql, bound = _build_where_clause(raw_params)
    having_sql = "HAVING SUM(conversions) = 0\n" if zero_only else ""
    bound.append(limit_val)
    sql = (
        "SELECT\n"
        "  ad_group_id,\n"
        "  campaign_id,\n"
        "  channel,\n"
        "  ROUND(SUM(spend), 2) AS total_spend,\n"
        "  SUM(clicks) AS total_clicks,\n"
        "  SUM(conversions) AS total_conversions,\n"
        "  ROUND(SUM(pipeline_value), 2) AS total_pipeline_value,\n"
        "  COALESCE(ROUND(SUM(pipeline_value) / NULLIF(SUM(spend), 0), 2), 0.0) AS roas,\n"
        "  ROUND(SUM(spend) / NULLIF(SUM(conversions), 0), 2) AS cpa\n"
        "FROM rows\n"
        f"{where_sql}"
        "GROUP BY ad_group_id, campaign_id, channel\n"
        f"{having_sql}"
        "ORDER BY total_conversions ASC, total_spend DESC, ad_group_id ASC\n"
        "LIMIT ?;"
    )
    return CompiledSqlQuery(template_id=resolved_id, sql=sql, params=tuple(bound))
