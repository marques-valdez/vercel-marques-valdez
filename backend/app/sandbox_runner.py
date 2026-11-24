"""Vercel Sandbox compute runner (SQL analytics + 2,000-trial Monte Carlo simulator).

Architecture role:
    1. Row-level analytics (`run_sandbox_query` & `compute_channel_daily_trends`):
       Queries indexed `relay_daily_performance` in Neon Serverless Postgres when
       `DATABASE_URL` is configured (`mode="neon-postgres"`), or offloads 10,400
       CSV rows into an isolated Firecracker microVM (`@vercel/sandbox`) / stdlib
       SQLite fallback—returning compact 3-20 row JSON summaries (~140K+ prompt
       tokens avoided per turn).
    2. Statistical simulation (`run_monte_carlo_reallocation_in_sandbox`):
       Executes CPU-bound 2,000-trial bootstrap Monte Carlo + Hill diminishing-
       returns budget simulations inside `@vercel/sandbox` microVMs outside
       FastAPI worker RAM, returning P10/P50/P90 30-day pipeline lift intervals.

Security & cost invariants:
    - `network_policy=NetworkPolicy.deny_all()`: blocks all outbound network
      access (also means zero `pip install` inside the microVM, so `job.py`
      uses Python stdlib `csv` + `sqlite3` only).
    - `persistent=False`: opts out of automatic filesystem snapshots on stop so
      one-off analytics runs never accrue snapshot storage charges.
    - `MAX_SANDBOXES_PER_REQUEST = 1` (tracked via `ContextVar`) plus a 30s
      timeout caps runaway microVM spend; if OIDC credentials are unavailable
      locally, execution falls back transparently to in-process SQLite and
      badges `mode="in-process"` honestly in telemetry.
"""

from __future__ import annotations

import contextlib
from contextvars import ContextVar, Token
import csv
from dataclasses import dataclass
import io
import json
import math
import os
from pathlib import Path
import random
import sqlite3
import time
from typing import Any, Final, Literal, Mapping, Sequence

import anyio
from pydantic import BaseModel, ConfigDict
from vercel import sandbox
from vercel.oidc.credentials import get_credentials
from vercel.sandbox import NetworkPolicy

from app.db import (
    fetch_channel_daily_trends,
    is_database_configured,
    run_postgres_analytics_query,
)
from app.sql_templates import TemplateId, compile_sql_template
from app.twin import (
    CANONICAL_CHANNEL_ORDER,
    CHANNEL_ID_TO_NAME,
    CHANNEL_LABELS,
    EXPECTED_CSV_COLUMNS,
    ChannelId,
    get_rows_csv_text,
)

SANDBOX_TIMEOUT_SECONDS: Final[int] = 30
SANDBOX_KILL_AFTER_SECONDS: Final[int] = 25
MAX_SANDBOXES_PER_REQUEST: Final[int] = 1
CHARS_PER_ESTIMATED_TOKEN: Final[int] = 4

SandboxMode = Literal["neon-postgres", "sandbox", "in-process"]

@dataclass
class _RequestSandboxBudget:
    """Mutable per-HTTP-request sandbox counter shared across child task contexts."""

    count: int = 0


_request_sandbox_budget: ContextVar[_RequestSandboxBudget | None] = ContextVar(
    "relay_request_sandbox_budget", default=None
)


class SandboxQueryResult(BaseModel):
    """Structured analytics output returned to analyze_in_sandbox and WorkflowCard."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    templateId: TemplateId
    mode: SandboxMode
    sandboxMs: float
    rowsScanned: int
    rowsReturned: int
    sql: str
    table: list[dict[str, Any]]
    estTokensAvoided: int


def reset_request_sandbox_budget() -> Token[_RequestSandboxBudget | None]:
    """Allocate a fresh per-HTTP-request microVM creation budget."""
    return _request_sandbox_budget.set(_RequestSandboxBudget(count=0))


def restore_request_sandbox_budget(
    token: Token[_RequestSandboxBudget | None],
) -> None:
    """Restore a prior ContextVar token on request exit."""
    with contextlib.suppress(ValueError):
        _request_sandbox_budget.reset(token)


def get_request_sandbox_count() -> int:
    """Return how many sandbox microVMs the current request has attempted."""
    return (
        budget.count
        if (budget := _request_sandbox_budget.get()) is not None
        else 0
    )


def is_sandbox_disabled() -> bool:
    """Return True when SANDBOX_DISABLED explicitly forces the in-process fallback."""
    return os.getenv("SANDBOX_DISABLED", "").strip().lower() in {"1", "true", "yes"}


def is_sandbox_available() -> bool:
    """Synchronously inspect environment/OIDC credentials without network calls."""
    if is_sandbox_disabled():
        return False
    try:
        creds = get_credentials()
        return bool(creds and creds.token and creds.project_id and creds.team_id)
    except Exception:
        return False


def _normalize_cell(value: Any) -> Any:
    if isinstance(value, float) and not isinstance(value, bool):
        return 0.0 if value == 0.0 else value
    return value


def run_sqlite_job(
    csv_text: str,
    sql: str,
    params: Sequence[Any] = (),
) -> dict[str, Any]:
    """Execute parameterized SQLite aggregation over CSV text in stdlib memory."""
    reader = csv.reader(io.StringIO(csv_text, newline=""))
    header = next(reader, None)
    if header is None or tuple(header) != EXPECTED_CSV_COLUMNS:
        raise ValueError(
            f"Unexpected rows.csv header {header!r}; expected {list(EXPECTED_CSV_COLUMNS)!r}"
        )

    records = [
        (
            row[0],
            row[1],
            row[2],
            row[3],
            float(row[4]),
            int(row[5]),
            int(row[6]),
            float(row[7]),
        )
        for row in reader
        if row
    ]
    rows_scanned = len(records)

    conn = sqlite3.connect(":memory:")
    try:
        conn.execute(
            "CREATE TABLE rows ("
            "date TEXT, "
            "channel TEXT, "
            "campaign_id TEXT, "
            "ad_group_id TEXT, "
            "spend REAL, "
            "clicks INTEGER, "
            "conversions INTEGER, "
            "pipeline_value REAL"
            ")"
        )
        conn.executemany(
            "INSERT INTO rows VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            records,
        )
        cursor = conn.execute(sql, tuple(params))
        columns = [col[0] for col in (cursor.description or ())]
        raw_rows = cursor.fetchall()
    finally:
        conn.close()

    table = [
        {col: _normalize_cell(val) for col, val in zip(columns, raw_row, strict=True)}
        for raw_row in raw_rows
    ]
    return {
        "rowsScanned": rows_scanned,
        "rowsReturned": len(table),
        "table": table,
    }


def build_job_script(sql: str, params: Sequence[Any] = ()) -> str:
    """Build self-contained Python stdlib job.py source executed inside Vercel Sandbox."""
    spec_json = json.dumps(
        {
            "expectedHeader": list(EXPECTED_CSV_COLUMNS),
            "sql": sql,
            "params": list(params),
        },
        separators=(",", ":"),
        allow_nan=False,
    )
    return (
        "import csv\n"
        "import io\n"
        "import json\n"
        "from pathlib import Path\n"
        "import sqlite3\n\n"
        f"SPEC = json.loads({spec_json!r})\n\n"
        "def _norm(val):\n"
        "    if isinstance(val, float) and not isinstance(val, bool):\n"
        "        return 0.0 if val == 0.0 else val\n"
        "    return val\n\n"
        "def main() -> None:\n"
        "    with Path('rows.csv').open('r', encoding='utf-8', newline='') as f:\n"
        "        reader = csv.reader(f)\n"
        "        header = next(reader, None)\n"
        "        if header is None or list(header) != SPEC['expectedHeader']:\n"
        "            raise ValueError(f'Unexpected CSV header: {header!r}')\n"
        "        records = [\n"
        "            (r[0], r[1], r[2], r[3], float(r[4]), int(r[5]), int(r[6]), float(r[7]))\n"
        "            for r in reader\n"
        "            if r\n"
        "        ]\n"
        "    conn = sqlite3.connect(':memory:')\n"
        "    try:\n"
        "        conn.execute(\n"
        "            'CREATE TABLE rows ('\n"
        "            'date TEXT, channel TEXT, campaign_id TEXT, ad_group_id TEXT, '\n"
        "            'spend REAL, clicks INTEGER, conversions INTEGER, pipeline_value REAL)'\n"
        "        )\n"
        "        conn.executemany('INSERT INTO rows VALUES (?, ?, ?, ?, ?, ?, ?, ?)', records)\n"
        "        cur = conn.execute(SPEC['sql'], tuple(SPEC['params']))\n"
        "        cols = [c[0] for c in (cur.description or ())] \n"
        "        fetched = cur.fetchall()\n"
        "    finally:\n"
        "        conn.close()\n"
        "    table = [\n"
        "        {col: _norm(val) for col, val in zip(cols, row, strict=True)}\n"
        "        for row in fetched\n"
        "    ]\n"
        "    out = {\n"
        "        'rowsScanned': len(records),\n"
        "        'rowsReturned': len(table),\n"
        "        'table': table,\n"
        "    }\n"
        "    print(json.dumps(out, separators=(',', ':'), allow_nan=False))\n\n"
        "if __name__ == '__main__':\n"
        "    main()\n"
    )


def compute_estimated_tokens_avoided(
    csv_text: str,
    table: Sequence[Mapping[str, Any]],
) -> int:
    """Estimate prompt tokens avoided by summarizing CSV rows in SQLite."""
    json_summary = json.dumps(list(table), separators=(",", ":"), allow_nan=False)
    return max(
        0,
        int(
            len(csv_text) / CHARS_PER_ESTIMATED_TOKEN
            - len(json_summary) / CHARS_PER_ESTIMATED_TOKEN
        ),
    )


class MonteCarloSimulationResult(BaseModel):
    """Structured output of the 2,000-trial Monte Carlo budget shift simulator."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    mode: Literal["sandbox", "in-process"]
    trials: int
    horizonDays: int
    sandboxMs: float
    incrementalPipelineP10: float
    incrementalPipelineP50: float
    incrementalPipelineP90: float
    blendedRoasP10: float
    blendedRoasP50: float
    blendedRoasP90: float
    probabilityOfPositiveLiftPct: float
    targetSaturationDragPct: float


class ChannelTrendPoint(BaseModel):
    """Single day spend, pipeline, and ROAS point for one channel."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    date: str
    spend: float
    pipelineValue: float
    roas: float


class ChannelTrendSeries(BaseModel):
    """Trailing N-day trend summary and chronological series for one channel."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    channelId: ChannelId
    channel: str
    firstWindowRoas: float
    lastWindowRoas: float
    deltaPct: float
    points: list[ChannelTrendPoint]


class ChannelTrendsResponse(BaseModel):
    """Response contract for GET /api/agent/trends."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    days: int
    mode: Literal["neon-postgres", "in-process"]
    channels: dict[ChannelId, ChannelTrendSeries]


def _extract_channel_daily_trends_from_csv(
    csv_text: str,
    days: int,
) -> dict[str, list[dict[str, Any]]]:
    """Aggregate rows.csv into trailing N-day spend/pipeline points per channel."""
    totals: dict[tuple[str, str], list[float]] = {}
    dates_seen: set[str] = set()
    reader = csv.reader(io.StringIO(csv_text, newline=""))
    next(reader, None)
    for row in reader:
        if not row:
            continue
        date_str = row[0]
        channel_name = row[1]
        spend = float(row[4])
        pipeline = float(row[7])
        dates_seen.add(date_str)
        key = (channel_name, date_str)
        entry = totals.get(key)
        if entry is None:
            totals[key] = [spend, pipeline]
        else:
            entry[0] += spend
            entry[1] += pipeline

    kept_dates = set(sorted(dates_seen)[-days:])
    grouped: dict[str, list[dict[str, Any]]] = {}
    for (channel_name, date_str), (spend, pipeline) in sorted(totals.items()):
        if date_str not in kept_dates:
            continue
        grouped.setdefault(channel_name, []).append(
            {
                "date": date_str,
                "spend": spend,
                "pipeline_value": pipeline,
            }
        )
    return grouped


def compute_channel_daily_trends(
    days: int = 30,
    *,
    data_dir: Path | None = None,
) -> ChannelTrendsResponse:
    """Compute trailing N-day per-channel ROAS time series and 7d-vs-7d delta."""
    clamped_days = max(7, min(90, int(days)))
    grouped: dict[str, list[dict[str, Any]]] | None = None
    mode: Literal["neon-postgres", "in-process"] = "in-process"

    if is_database_configured():
        try:
            grouped = fetch_channel_daily_trends(clamped_days, data_dir=data_dir)
            if grouped is not None:
                mode = "neon-postgres"
        except Exception:
            grouped = None
            mode = "in-process"

    if grouped is None:
        csv_text = get_rows_csv_text(data_dir)
        grouped = _extract_channel_daily_trends_from_csv(csv_text, clamped_days)
        mode = "in-process"

    channels_out: dict[ChannelId, ChannelTrendSeries] = {}
    for ch_id in CANONICAL_CHANNEL_ORDER:
        ch_name = CHANNEL_ID_TO_NAME[ch_id]
        raw_pts = sorted(grouped.get(ch_name, []), key=lambda item: str(item["date"]))
        points = [
            ChannelTrendPoint(
                date=str(pt["date"]),
                spend=round(float(pt["spend"]), 2),
                pipelineValue=round(float(pt["pipeline_value"]), 2),
                roas=round(
                    float(pt["pipeline_value"]) / float(pt["spend"]), 2
                )
                if float(pt["spend"]) > 0.0
                else 0.0,
            )
            for pt in raw_pts
        ]
        win = min(7, len(points))
        first_spend = sum(p.spend for p in points[:win])
        first_pipe = sum(p.pipelineValue for p in points[:win])
        last_spend = sum(p.spend for p in points[-win:]) if win > 0 else 0.0
        last_pipe = sum(p.pipelineValue for p in points[-win:]) if win > 0 else 0.0
        first_roas = round(first_pipe / first_spend, 2) if first_spend > 0.0 else 0.0
        last_roas = round(last_pipe / last_spend, 2) if last_spend > 0.0 else 0.0
        delta_pct = (
            round(((last_roas - first_roas) / first_roas) * 100.0, 1)
            if first_roas > 0.0
            else 0.0
        )
        channels_out[ch_id] = ChannelTrendSeries(
            channelId=ch_id,
            channel=CHANNEL_LABELS[ch_id],
            firstWindowRoas=first_roas,
            lastWindowRoas=last_roas,
            deltaPct=0.0 if delta_pct == 0.0 else delta_pct,
            points=points,
        )

    return ChannelTrendsResponse(days=clamped_days, mode=mode, channels=channels_out)


async def run_sandbox_query(
    template_id: str = "channel_roas_summary",
    params: Mapping[str, Any] | None = None,
    *,
    data_dir: Path | None = None,
    prefer_in_process: bool = False,
) -> SandboxQueryResult:
    """Run parameterized analytics directly on Neon Postgres when configured, else Sandbox/SQLite."""
    csv_text = get_rows_csv_text(data_dir)
    t0 = time.perf_counter()
    parsed: Mapping[str, Any] | None = None
    mode: SandboxMode = "in-process"

    if not prefer_in_process and is_database_configured():
        compiled_pg = compile_sql_template(template_id, params, dialect="postgres")
        try:
            parsed = await anyio.to_thread.run_sync(
                lambda: run_postgres_analytics_query(
                    compiled_pg.sql,
                    compiled_pg.params,
                    data_dir=data_dir,
                )
            )
            compiled = compiled_pg
            mode = "neon-postgres"
        except Exception:
            parsed = None
            compiled = compile_sql_template(template_id, params, dialect="sqlite")
    else:
        compiled = compile_sql_template(template_id, params, dialect="sqlite")

    if parsed is None:
        job_source = build_job_script(compiled.sql, compiled.params)
        # Enforce a hard cap of 1 microVM per HTTP request via ContextVar so a
        # multi-step LLM loop cannot spawn runaway Sandboxes in a single turn.
        can_launch_sandbox = False
        if not prefer_in_process and not is_sandbox_disabled():
            budget = _request_sandbox_budget.get()
            if budget is None:
                budget = _RequestSandboxBudget()
                _request_sandbox_budget.set(budget)
            if budget.count < MAX_SANDBOXES_PER_REQUEST:
                budget.count += 1
                can_launch_sandbox = True

        if can_launch_sandbox:
            try:
                with anyio.fail_after(SANDBOX_TIMEOUT_SECONDS):
                    async with sandbox.create_sandbox(
                        network_policy=NetworkPolicy.deny_all(),
                        execution_time_limit=SANDBOX_TIMEOUT_SECONDS,
                        persistent=False,
                    ) as box:
                        await box.fs.write_text("rows.csv", csv_text)
                        await box.fs.write_text("job.py", job_source)
                        result = await box.run_command(
                            "python",
                            ["job.py"],
                            capture_output=True,
                            check=True,
                            kill_after=SANDBOX_KILL_AFTER_SECONDS,
                        )
                        raw_out = result.stdout
                        out_text = (
                            raw_out.decode("utf-8")
                            if isinstance(raw_out, (bytes, bytearray))
                            else str(raw_out or "")
                        )
                        candidate = json.loads(out_text)
                        if (
                            not isinstance(candidate, Mapping)
                            or not isinstance(candidate.get("table"), list)
                            or isinstance(candidate.get("rowsScanned"), bool)
                            or not isinstance(candidate.get("rowsScanned"), int)
                        ):
                            raise ValueError("Invalid JSON summary returned from sandbox")
                        parsed = candidate
                        mode = "sandbox"
            except Exception:
                parsed = None
                mode = "in-process"

    if parsed is None:
        parsed = run_sqlite_job(csv_text, compiled.sql, compiled.params)
        mode = "in-process"

    elapsed_ms = round((time.perf_counter() - t0) * 1000.0, 2)
    table_rows: list[dict[str, Any]] = [dict(item) for item in parsed["table"]]
    rows_scanned = int(parsed["rowsScanned"])
    est_avoided = compute_estimated_tokens_avoided(csv_text, table_rows)

    return SandboxQueryResult(
        templateId=compiled.template_id,
        mode=mode,
        sandboxMs=elapsed_ms,
        rowsScanned=rows_scanned,
        rowsReturned=len(table_rows),
        sql=compiled.sql,
        table=table_rows,
        estTokensAvoided=est_avoided,
    )


def _extract_campaign_series_from_csv(
    csv_text: str,
    campaign_ids: Sequence[str],
) -> dict[str, list[dict[str, Any]]]:
    """Aggregate local rows.csv into daily spend/pipeline series per campaign."""
    wanted = set(campaign_ids)
    buckets: dict[tuple[str, str], list[float]] = {}
    reader = csv.reader(io.StringIO(csv_text, newline=""))
    next(reader, None)
    for row in reader:
        if not row or row[2] not in wanted:
            continue
        key = (row[2], row[0])
        entry = buckets.get(key)
        if entry is None:
            buckets[key] = [float(row[4]), float(row[7])]
        else:
            entry[0] += float(row[4])
            entry[1] += float(row[7])

    grouped: dict[str, list[dict[str, Any]]] = {cid: [] for cid in campaign_ids}
    for (cid, date_str), (spend, pipeline) in sorted(buckets.items()):
        grouped[cid].append({"date": date_str, "spend": spend, "pipeline_value": pipeline})
    return grouped


def run_monte_carlo_in_process(spec: Mapping[str, Any]) -> dict[str, Any]:
    """Deterministic Python stdlib Monte Carlo simulator with Hill diminishing returns."""
    from_budget = float(spec["fromDailyBudget"])
    to_budget = float(spec["toDailyBudget"])
    shift = float(spec["amountPerDay"])
    portfolio_budget = float(spec["portfolioDailyBudget"])
    portfolio_roas = float(spec["portfolioBlendedRoas"])
    from_mean_roas = max(0.05, float(spec["fromRoas"]))
    to_mean_roas = max(0.05, float(spec["toRoas"]))
    trials = int(spec.get("trials", 2000))
    horizon_days = int(spec.get("horizonDays", 30))
    seed = int(spec.get("seed", 42))

    def _estimate_log_sigma(series: Sequence[Mapping[str, Any]], fallback_roas: float) -> float:
        ratios = [
            float(pt["pipeline_value"]) / float(pt["spend"])
            for pt in series
            if float(pt.get("spend", 0.0)) > 0.0 and float(pt.get("pipeline_value", 0.0)) > 0.0
        ]
        if len(ratios) < 3:
            return 0.18
        logs = [math.log(max(0.05, r)) for r in ratios]
        mean_log = sum(logs) / len(logs)
        var = sum((x - mean_log) ** 2 for x in logs) / max(1, len(logs) - 1)
        return max(0.05, min(0.45, math.sqrt(var)))

    from_sigma = _estimate_log_sigma(spec.get("fromSeries") or (), from_mean_roas)
    to_sigma = _estimate_log_sigma(spec.get("toSeries") or (), to_mean_roas)

    # Hill diminishing-returns saturation on the destination campaign's budget expansion.
    budget_ratio = (to_budget + shift) / max(to_budget, 1.0)
    alpha = 0.22
    gamma = 1.35
    saturation_factor = 1.0 / (1.0 + alpha * (max(0.0, budget_ratio - 1.0) ** gamma))
    target_saturation_drag_pct = round((1.0 - saturation_factor) * 100.0, 1)

    other_daily_pipeline = max(
        0.0,
        portfolio_budget * portfolio_roas
        - (from_budget * from_mean_roas + to_budget * to_mean_roas),
    )

    rng = random.Random(seed)
    from_mu = math.log(from_mean_roas) - 0.5 * (from_sigma ** 2)
    to_mu = math.log(to_mean_roas) - 0.5 * (to_sigma ** 2)
    horizon_scale = 1.0 / math.sqrt(max(1, horizon_days))
    eff_from_sigma = from_sigma * horizon_scale
    eff_to_sigma = to_sigma * horizon_scale
    eff_from_mu = math.log(from_mean_roas) - 0.5 * (eff_from_sigma ** 2)
    eff_to_mu = math.log(to_mean_roas) - 0.5 * (eff_to_sigma ** 2)
    _ = (from_mu, to_mu)

    deltas: list[float] = []
    roas_samples: list[float] = []
    positive_count = 0

    for _i in range(trials):
        r_from = math.exp(rng.gauss(eff_from_mu, eff_from_sigma))
        r_to = math.exp(rng.gauss(eff_to_mu, eff_to_sigma))

        base_daily = from_budget * r_from + to_budget * r_to
        after_daily = (
            max(0.0, from_budget - shift) * r_from
            + to_budget * r_to
            + shift * r_to * saturation_factor
        )
        delta_30d = (after_daily - base_daily) * horizon_days
        if delta_30d > 0.0:
            positive_count += 1
        deltas.append(delta_30d)
        total_after_daily = other_daily_pipeline + after_daily
        roas_samples.append(total_after_daily / max(portfolio_budget, 1.0))

    deltas.sort()
    roas_samples.sort()

    def _pct(sorted_vals: list[float], p: float) -> float:
        idx = min(len(sorted_vals) - 1, max(0, int(round(p * (len(sorted_vals) - 1)))))
        return sorted_vals[idx]

    return {
        "trials": trials,
        "horizonDays": horizon_days,
        "incrementalPipelineP10": round(_pct(deltas, 0.10), 2),
        "incrementalPipelineP50": round(_pct(deltas, 0.50), 2),
        "incrementalPipelineP90": round(_pct(deltas, 0.90), 2),
        "blendedRoasP10": round(_pct(roas_samples, 0.10), 2),
        "blendedRoasP50": round(_pct(roas_samples, 0.50), 2),
        "blendedRoasP90": round(_pct(roas_samples, 0.90), 2),
        "probabilityOfPositiveLiftPct": round((positive_count / max(1, trials)) * 100.0, 1),
        "targetSaturationDragPct": target_saturation_drag_pct,
    }


def build_monte_carlo_script(spec: Mapping[str, Any]) -> str:
    """Build self-contained Python stdlib Monte Carlo job for Vercel Sandbox."""
    spec_json = json.dumps(dict(spec), separators=(",", ":"), allow_nan=False)
    return (
        "import json, math, random\n\n"
        f"SPEC = json.loads({spec_json!r})\n\n"
        "def _estimate_sigma(series):\n"
        "    ratios = [float(p['pipeline_value']) / float(p['spend']) for p in series "
        "if float(p.get('spend', 0.0)) > 0.0 and float(p.get('pipeline_value', 0.0)) > 0.0]\n"
        "    if len(ratios) < 3:\n"
        "        return 0.18\n"
        "    logs = [math.log(max(0.05, r)) for r in ratios]\n"
        "    mean_log = sum(logs) / len(logs)\n"
        "    var = sum((x - mean_log) ** 2 for x in logs) / max(1, len(logs) - 1)\n"
        "    return max(0.05, min(0.45, math.sqrt(var)))\n\n"
        "def main():\n"
        "    fb = float(SPEC['fromDailyBudget'])\n"
        "    tb = float(SPEC['toDailyBudget'])\n"
        "    sh = float(SPEC['amountPerDay'])\n"
        "    pb = float(SPEC['portfolioDailyBudget'])\n"
        "    pr = float(SPEC['portfolioBlendedRoas'])\n"
        "    fr = max(0.05, float(SPEC['fromRoas']))\n"
        "    tr = max(0.05, float(SPEC['toRoas']))\n"
        "    trials = int(SPEC.get('trials', 2000))\n"
        "    days = int(SPEC.get('horizonDays', 30))\n"
        "    seed = int(SPEC.get('seed', 42))\n"
        "    fs = _estimate_sigma(SPEC.get('fromSeries') or [])\n"
        "    ts = _estimate_sigma(SPEC.get('toSeries') or [])\n"
        "    ratio = (tb + sh) / max(tb, 1.0)\n"
        "    sat = 1.0 / (1.0 + 0.22 * (max(0.0, ratio - 1.0) ** 1.35))\n"
        "    drag = round((1.0 - sat) * 100.0, 1)\n"
        "    other = max(0.0, pb * pr - (fb * fr + tb * tr))\n"
        "    rng = random.Random(seed)\n"
        "    scale = 1.0 / math.sqrt(max(1, days))\n"
        "    efs, ets = fs * scale, ts * scale\n"
        "    efm = math.log(fr) - 0.5 * (efs ** 2)\n"
        "    etm = math.log(tr) - 0.5 * (ets ** 2)\n"
        "    deltas, roas_list, pos = [], [], 0\n"
        "    for _ in range(trials):\n"
        "        rf = math.exp(rng.gauss(efm, efs))\n"
        "        rt = math.exp(rng.gauss(etm, ets))\n"
        "        base_d = fb * rf + tb * rt\n"
        "        after_d = max(0.0, fb - sh) * rf + tb * rt + sh * rt * sat\n"
        "        d30 = (after_d - base_d) * days\n"
        "        if d30 > 0.0:\n"
        "            pos += 1\n"
        "        deltas.append(d30)\n"
        "        roas_list.append((other + after_d) / max(pb, 1.0))\n"
        "    deltas.sort()\n"
        "    roas_list.sort()\n"
        "    def pct(arr, p):\n"
        "        return arr[min(len(arr) - 1, max(0, int(round(p * (len(arr) - 1)))))]\n"
        "    print(json.dumps({\n"
        "        'trials': trials,\n"
        "        'horizonDays': days,\n"
        "        'incrementalPipelineP10': round(pct(deltas, 0.10), 2),\n"
        "        'incrementalPipelineP50': round(pct(deltas, 0.50), 2),\n"
        "        'incrementalPipelineP90': round(pct(deltas, 0.90), 2),\n"
        "        'blendedRoasP10': round(pct(roas_list, 0.10), 2),\n"
        "        'blendedRoasP50': round(pct(roas_list, 0.50), 2),\n"
        "        'blendedRoasP90': round(pct(roas_list, 0.90), 2),\n"
        "        'probabilityOfPositiveLiftPct': round((pos / max(1, trials)) * 100.0, 1),\n"
        "        'targetSaturationDragPct': drag,\n"
        "    }, separators=(',', ':'), allow_nan=False))\n\n"
        "if __name__ == '__main__':\n"
        "    main()\n"
    )


async def run_monte_carlo_reallocation_in_sandbox(
    *,
    from_campaign: str,
    to_campaign: str,
    from_daily_budget: float,
    to_daily_budget: float,
    from_roas: float,
    to_roas: float,
    amount_per_day: float,
    portfolio_daily_budget: float,
    portfolio_blended_roas: float,
    campaign_series: Mapping[str, Sequence[Mapping[str, Any]]] | None = None,
    data_dir: Path | None = None,
    trials: int = 2000,
    horizon_days: int = 30,
    seed: int = 42,
    prefer_in_process: bool = False,
) -> MonteCarloSimulationResult:
    """Run a 2,000-trial Monte Carlo budget reallocation simulation in @vercel/sandbox."""
    if campaign_series is None:
        csv_text = get_rows_csv_text(data_dir)
        series_map = _extract_campaign_series_from_csv(csv_text, [from_campaign, to_campaign])
    else:
        series_map = {k: list(v) for k, v in campaign_series.items()}

    spec = {
        "fromCampaign": from_campaign,
        "toCampaign": to_campaign,
        "fromDailyBudget": from_daily_budget,
        "toDailyBudget": to_daily_budget,
        "fromRoas": from_roas,
        "toRoas": to_roas,
        "amountPerDay": amount_per_day,
        "portfolioDailyBudget": portfolio_daily_budget,
        "portfolioBlendedRoas": portfolio_blended_roas,
        "fromSeries": series_map.get(from_campaign, []),
        "toSeries": series_map.get(to_campaign, []),
        "trials": trials,
        "horizonDays": horizon_days,
        "seed": seed,
    }

    t0 = time.perf_counter()
    parsed: Mapping[str, Any] | None = None
    mode: Literal["sandbox", "in-process"] = "in-process"

    can_launch_sandbox = False
    if not prefer_in_process and not is_sandbox_disabled():
        budget = _request_sandbox_budget.get()
        if budget is None:
            budget = _RequestSandboxBudget()
            _request_sandbox_budget.set(budget)
        if budget.count < MAX_SANDBOXES_PER_REQUEST:
            budget.count += 1
            can_launch_sandbox = True

    if can_launch_sandbox:
        try:
            job_source = build_monte_carlo_script(spec)
            with anyio.fail_after(SANDBOX_TIMEOUT_SECONDS):
                async with sandbox.create_sandbox(
                    network_policy=NetworkPolicy.deny_all(),
                    execution_time_limit=SANDBOX_TIMEOUT_SECONDS,
                    persistent=False,
                ) as box:
                    await box.fs.write_text("simulate.py", job_source)
                    result = await box.run_command(
                        "python",
                        ["simulate.py"],
                        capture_output=True,
                        check=True,
                        kill_after=SANDBOX_KILL_AFTER_SECONDS,
                    )
                    raw_out = result.stdout
                    out_text = (
                        raw_out.decode("utf-8")
                        if isinstance(raw_out, (bytes, bytearray))
                        else str(raw_out or "")
                    )
                    candidate = json.loads(out_text)
                    if isinstance(candidate, Mapping) and "incrementalPipelineP50" in candidate:
                        parsed = candidate
                        mode = "sandbox"
        except Exception:
            parsed = None
            mode = "in-process"

    if parsed is None:
        parsed = run_monte_carlo_in_process(spec)
        mode = "in-process"

    elapsed_ms = round((time.perf_counter() - t0) * 1000.0, 2)
    return MonteCarloSimulationResult(
        mode=mode,
        trials=int(parsed["trials"]),
        horizonDays=int(parsed["horizonDays"]),
        sandboxMs=elapsed_ms,
        incrementalPipelineP10=float(parsed["incrementalPipelineP10"]),
        incrementalPipelineP50=float(parsed["incrementalPipelineP50"]),
        incrementalPipelineP90=float(parsed["incrementalPipelineP90"]),
        blendedRoasP10=float(parsed["blendedRoasP10"]),
        blendedRoasP50=float(parsed["blendedRoasP50"]),
        blendedRoasP90=float(parsed["blendedRoasP90"]),
        probabilityOfPositiveLiftPct=float(parsed["probabilityOfPositiveLiftPct"]),
        targetSaturationDragPct=float(parsed["targetSaturationDragPct"]),
    )


async def run_portfolio_simulation_in_sandbox(
    spec: Mapping[str, Any],
    *,
    prefer_in_process: bool = False,
) -> tuple[dict[str, Any], Literal["sandbox", "in-process"], float]:
    """Score several portfolio plans in one microVM, or in-process when unavailable.

    Uploads `app/portfolio_sim.py` unchanged plus a `spec.json` file, so the sandbox
    and the in-process fallback execute the same source. Returns the parsed result,
    the mode that actually ran, and elapsed milliseconds.
    """
    from app import portfolio_sim

    t0 = time.perf_counter()
    parsed: dict[str, Any] | None = None
    mode: Literal["sandbox", "in-process"] = "in-process"

    can_launch_sandbox = False
    if not prefer_in_process and not is_sandbox_disabled():
        budget = _request_sandbox_budget.get()
        if budget is None:
            budget = _RequestSandboxBudget()
            _request_sandbox_budget.set(budget)
        if budget.count < MAX_SANDBOXES_PER_REQUEST:
            budget.count += 1
            can_launch_sandbox = True

    if can_launch_sandbox:
        try:
            job_source = Path(portfolio_sim.__file__).read_text(encoding="utf-8")
            spec_json = json.dumps(dict(spec), separators=(",", ":"), allow_nan=False)
            with anyio.fail_after(SANDBOX_TIMEOUT_SECONDS):
                async with sandbox.create_sandbox(
                    network_policy=NetworkPolicy.deny_all(),
                    execution_time_limit=SANDBOX_TIMEOUT_SECONDS,
                    persistent=False,
                ) as box:
                    await box.fs.write_text("portfolio_sim.py", job_source)
                    await box.fs.write_text("spec.json", spec_json)
                    result = await box.run_command(
                        "python",
                        ["portfolio_sim.py"],
                        capture_output=True,
                        check=True,
                        kill_after=SANDBOX_KILL_AFTER_SECONDS,
                    )
                    raw_out = result.stdout
                    out_text = (
                        raw_out.decode("utf-8")
                        if isinstance(raw_out, (bytes, bytearray))
                        else str(raw_out or "")
                    )
                    candidate = json.loads(out_text)
                    if (
                        isinstance(candidate, dict)
                        and isinstance(candidate.get("plans"), list)
                        and len(candidate["plans"]) == len(spec["plans"])
                    ):
                        parsed = candidate
                        mode = "sandbox"
        except Exception:
            parsed = None
            mode = "in-process"

    if parsed is None:
        parsed = portfolio_sim.simulate(spec)
        mode = "in-process"

    elapsed_ms = round((time.perf_counter() - t0) * 1000.0, 2)
    return parsed, mode, elapsed_ms
