"""Guardrail backtest over the daily performance rows.

Answers one question for a compiled workflow: on how many past days would its alert
have fired? The metric is computed only from daily rows:

    share of a day's spend that went to ad groups with zero conversions
    over the previous 14 days

A landing page that returns 404 produces exactly this signature, so the metric is the
daily-row counterpart of the broken-link check. It also flags low-volume ad groups
that went two weeks without a conversion by chance, and it needs 14 days of history
before it can flag anything, so a page that breaks today is first counted 14 days
later. Both properties are stated in the API response and shown in the UI.

The same SQL text runs on Neon Postgres and on in-process SQLite (window functions
exist in both), so the fallback path and the database path cannot drift. Only fixed
constants are formatted into the SQL; channels and the day limit are bound parameters.
"""

from __future__ import annotations

import time
from typing import Any, Final, Literal, Sequence

import anyio
from pydantic import BaseModel, ConfigDict

from app.db import run_backtest_query
from app.sandbox_runner import run_sqlite_job
from app.twin import CHANNEL_ID_TO_NAME, ChannelId, get_rows_csv_text, load_base_twin
from app.workflow import NormalizedWorkflowConfig

BACKTEST_METRIC: Final[str] = "zero_conversion_spend_share"
BACKTEST_WINDOW_DAYS: Final[int] = 14
BACKTEST_MIN_DAYS: Final[int] = 30
BACKTEST_MAX_DAYS: Final[int] = 90

BacktestMode = Literal["neon-postgres", "in-process"]
_SqlDialect = Literal["sqlite", "postgres"]

_TABLE_BY_DIALECT: Final[dict[str, str]] = {
    "sqlite": "rows",
    "postgres": "relay_daily_performance",
}
_PLACEHOLDER_BY_DIALECT: Final[dict[str, str]] = {"sqlite": "?", "postgres": "%s"}


class BacktestPoint(BaseModel):
    """One day of the backtest series."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    date: str
    spend: float
    atRiskSpend: float
    atRiskPct: float


class BacktestEvent(BaseModel):
    """A dated landing-page breakage inside the selected channels."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    date: str
    brokenLinks: int


class BacktestSummary(BaseModel):
    """Alert statistics for one threshold over the returned series."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    alertDays: int
    alertRatePct: float
    longestStreakDays: int
    firstAlertDate: str | None
    flaggedSpend: float
    minPct: float
    medianPct: float
    maxPct: float


class BacktestResult(BaseModel):
    """Response contract for POST /api/agent/workflows/backtest."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    metric: str
    windowDays: int
    days: int
    mode: BacktestMode
    ms: float
    thresholdPct: int
    channels: list[ChannelId]
    points: list[BacktestPoint]
    events: list[BacktestEvent]
    summary: BacktestSummary


def compile_backtest_sql(channel_count: int, dialect: _SqlDialect) -> str:
    """Build the backtest SQL for 1..3 bound channel names plus a bound day limit."""
    if dialect not in _TABLE_BY_DIALECT:
        raise ValueError(f"Unsupported SQL dialect {dialect!r}")
    if isinstance(channel_count, bool) or not isinstance(channel_count, int):
        raise ValueError("channel_count must be an integer")
    if channel_count < 1 or channel_count > len(CHANNEL_ID_TO_NAME):
        raise ValueError("channel_count must be between 1 and 3")

    table = _TABLE_BY_DIALECT[dialect]
    mark = _PLACEHOLDER_BY_DIALECT[dialect]
    channel_marks = ", ".join([mark] * channel_count)
    window = BACKTEST_WINDOW_DAYS
    return (
        "WITH ag AS (\n"
        "  SELECT date, ad_group_id, SUM(spend) AS spend, SUM(conversions) AS conversions\n"
        f"  FROM {table}\n"
        f"  WHERE channel IN ({channel_marks})\n"
        "  GROUP BY date, ad_group_id\n"
        "), scored AS (\n"
        "  SELECT date, spend,\n"
        "    SUM(conversions) OVER prior AS prior_conversions,\n"
        "    COUNT(*) OVER prior AS prior_days\n"
        "  FROM ag\n"
        "  WINDOW prior AS (\n"
        "    PARTITION BY ad_group_id ORDER BY date\n"
        f"    ROWS BETWEEN {window} PRECEDING AND 1 PRECEDING\n"
        "  )\n"
        ")\n"
        "SELECT CAST(date AS TEXT) AS day,\n"
        "  SUM(spend) AS spend,\n"
        "  SUM(CASE WHEN prior_conversions = 0 THEN spend ELSE 0 END) AS at_risk_spend\n"
        "FROM scored\n"
        f"WHERE prior_days = {window}\n"
        "GROUP BY date\n"
        "ORDER BY date DESC\n"
        f"LIMIT {mark}"
    )


def summarize_backtest(
    points: Sequence[BacktestPoint],
    threshold_pct: int,
) -> BacktestSummary:
    """Count alert days, the longest run of alert days, and the spend flagged on them."""
    alert_days = 0
    longest = 0
    current = 0
    flagged_spend = 0.0
    first_alert: str | None = None
    for point in points:
        if point.atRiskPct >= threshold_pct:
            alert_days += 1
            current += 1
            longest = max(longest, current)
            flagged_spend += point.atRiskSpend
            if first_alert is None:
                first_alert = point.date
        else:
            current = 0

    ordered = sorted(point.atRiskPct for point in points)
    count = len(ordered)
    if count == 0:
        median = 0.0
    elif count % 2 == 1:
        median = ordered[count // 2]
    else:
        median = (ordered[count // 2 - 1] + ordered[count // 2]) / 2.0

    return BacktestSummary(
        alertDays=alert_days,
        alertRatePct=round(alert_days / count * 100.0, 1) if count else 0.0,
        longestStreakDays=longest,
        firstAlertDate=first_alert,
        flaggedSpend=round(flagged_spend, 2),
        minPct=ordered[0] if ordered else 0.0,
        medianPct=round(median, 2),
        maxPct=ordered[-1] if ordered else 0.0,
    )


def _points_from_rows(raw_rows: Sequence[Sequence[Any]]) -> list[BacktestPoint]:
    points: list[BacktestPoint] = []
    for day, spend, at_risk in raw_rows:
        spend_val = float(spend or 0.0)
        risk_val = float(at_risk or 0.0)
        points.append(
            BacktestPoint(
                date=str(day)[:10],
                spend=round(spend_val, 2),
                atRiskSpend=round(risk_val, 2),
                atRiskPct=round(risk_val / spend_val * 100.0, 2) if spend_val > 0.0 else 0.0,
            )
        )
    points.sort(key=lambda point: point.date)
    return points


def _broken_link_events(
    channels: Sequence[ChannelId],
    first_date: str | None,
    last_date: str | None,
) -> list[BacktestEvent]:
    """Group broken-link start dates (from twin.json) that fall inside the series."""
    if first_date is None or last_date is None:
        return []
    selected = set(channels)
    counts: dict[str, int] = {}
    for issue in load_base_twin().hygieneIssues:
        if issue.issueType != "broken_404" or issue.channelId not in selected:
            continue
        since = issue.brokenSince
        if since is None or since < first_date or since > last_date:
            continue
        counts[since] = counts.get(since, 0) + 1
    return [BacktestEvent(date=day, brokenLinks=n) for day, n in sorted(counts.items())]


def _run_backtest_sync(
    channels: Sequence[ChannelId],
    days: int,
) -> tuple[list[BacktestPoint], BacktestMode]:
    channel_names = [CHANNEL_ID_TO_NAME[ch] for ch in channels]
    params: list[Any] = [*channel_names, days]

    try:
        pg_rows = run_backtest_query(
            compile_backtest_sql(len(channel_names), "postgres"),
            params,
        )
    except Exception:
        pg_rows = None
    if pg_rows is not None:
        return _points_from_rows(pg_rows), "neon-postgres"

    job = run_sqlite_job(
        get_rows_csv_text(),
        compile_backtest_sql(len(channel_names), "sqlite"),
        params,
    )
    sqlite_rows = [
        (row["day"], row["spend"], row["at_risk_spend"]) for row in job["table"]
    ]
    return _points_from_rows(sqlite_rows), "in-process"


async def run_guardrail_backtest(
    config: NormalizedWorkflowConfig,
    *,
    days: int = BACKTEST_MAX_DAYS,
) -> BacktestResult:
    """Backtest a workflow's alert threshold over the trailing daily rows."""
    if isinstance(days, bool) or not isinstance(days, int):
        raise ValueError("days must be an integer")
    if days < BACKTEST_MIN_DAYS or days > BACKTEST_MAX_DAYS:
        raise ValueError(
            f"days must be between {BACKTEST_MIN_DAYS} and {BACKTEST_MAX_DAYS}"
        )

    channels = list(config.channels)
    started = time.perf_counter()
    points, mode = await anyio.to_thread.run_sync(_run_backtest_sync, channels, days)
    elapsed_ms = round((time.perf_counter() - started) * 1000.0, 2)

    return BacktestResult(
        metric=BACKTEST_METRIC,
        windowDays=BACKTEST_WINDOW_DAYS,
        days=len(points),
        mode=mode,
        ms=elapsed_ms,
        thresholdPct=config.threshold,
        channels=channels,
        points=points,
        events=_broken_link_events(
            channels,
            points[0].date if points else None,
            points[-1].date if points else None,
        ),
        summary=summarize_backtest(points, config.threshold),
    )
