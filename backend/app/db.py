"""Neon Serverless Postgres persistence layer for Relay Studio workspaces.

Architecture role:
    Replaces browser-only `localStorage` as the durable source of truth when
    Neon is attached via Vercel Marketplace (`DATABASE_URL` / `POSTGRES_URL`),
    giving visitors multi-reload and cross-device persistence for Digital Twin
    mutations, saved 6-step workflows, chat history, and AI Gateway FinOps logs.

Serverless & Neon invariants:
    - Uses short-lived `psycopg` v3 connections with `autocommit=True` and
      `prepare_threshold=None` so Neon's PgBouncer transaction pooler never
      hits prepared-statement collisions across pooled backends.
    - Auto-initializes the 5 normalized tables once per process via idempotent
      `CREATE TABLE IF NOT EXISTS` DDL (zero manual migration step on deploy).
    - Degrades cleanly when `DATABASE_URL` / `POSTGRES_URL` is unset (local dev
      and unit tests continue working in stateless browser-local mode).
"""

from __future__ import annotations

import csv
from decimal import Decimal
import io
import json
import os
from pathlib import Path
import re
import threading
from typing import Any, Final, Mapping, Sequence

import psycopg

from app.twin import EXPECTED_CSV_COLUMNS, get_rows_csv_text

WORKSPACE_ID_RE: Final[re.Pattern[str]] = re.compile(r"^[A-Za-z0-9_-]{8,80}$")
MAX_WORKFLOWS_PER_WORKSPACE: Final[int] = 25
MAX_STORED_MESSAGES: Final[int] = 30
CONNECT_TIMEOUT_SECONDS: Final[int] = 5

_schema_lock = threading.Lock()
_schema_initialized_dsn: str | None = None
_perf_seed_lock = threading.Lock()
_perf_seeded_dsn: str | None = None

_SCHEMA_SQL: Final[tuple[str, ...]] = (
    """
    CREATE TABLE IF NOT EXISTS relay_workspaces (
        workspace_id TEXT PRIMARY KEY,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS relay_twin_mutations (
        workspace_id TEXT PRIMARY KEY
            REFERENCES relay_workspaces(workspace_id) ON DELETE CASCADE,
        mutations_json JSONB NOT NULL DEFAULT '[]'::jsonb,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS relay_workflows (
        workspace_id TEXT NOT NULL
            REFERENCES relay_workspaces(workspace_id) ON DELETE CASCADE,
        workflow_id TEXT NOT NULL,
        workflow_json JSONB NOT NULL,
        custom_name TEXT,
        saved_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (workspace_id, workflow_id)
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS relay_chat_sessions (
        workspace_id TEXT PRIMARY KEY
            REFERENCES relay_workspaces(workspace_id) ON DELETE CASCADE,
        messages_json JSONB NOT NULL DEFAULT '[]'::jsonb,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS relay_telemetry_events (
        id BIGSERIAL PRIMARY KEY,
        workspace_id TEXT NOT NULL
            REFERENCES relay_workspaces(workspace_id) ON DELETE CASCADE,
        tier TEXT NOT NULL,
        primary_model TEXT NOT NULL,
        served_model TEXT NOT NULL,
        failover TEXT NOT NULL,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        cached_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        cost_usd DOUBLE PRECISION NOT NULL DEFAULT 0.0,
        baseline_cost_usd DOUBLE PRECISION NOT NULL DEFAULT 0.0,
        latency_ms DOUBLE PRECISION NOT NULL DEFAULT 0.0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS relay_daily_performance (
        date DATE NOT NULL,
        channel TEXT NOT NULL,
        campaign_id TEXT NOT NULL,
        ad_group_id TEXT NOT NULL,
        spend DOUBLE PRECISION NOT NULL,
        clicks INTEGER NOT NULL,
        conversions INTEGER NOT NULL,
        pipeline_value DOUBLE PRECISION NOT NULL,
        PRIMARY KEY (date, ad_group_id)
    )
    """,
    """
    CREATE INDEX IF NOT EXISTS idx_relay_perf_channel_date
        ON relay_daily_performance (channel, date)
    """,
    """
    CREATE INDEX IF NOT EXISTS idx_relay_perf_campaign_date
        ON relay_daily_performance (campaign_id, date)
    """,
)


def get_database_url() -> str | None:
    """Resolve the Neon Postgres connection string from standard Vercel env vars."""
    for env_name in ("DATABASE_URL", "POSTGRES_URL", "POSTGRES_PRISMA_URL"):
        raw = os.getenv(env_name)
        if raw and raw.strip():
            return raw.strip()
    return None


def is_database_configured() -> bool:
    """Return True when a Postgres connection string is configured in the environment."""
    return get_database_url() is not None


def normalize_workspace_id(raw: str | None) -> str | None:
    """Validate and return a safe workspace identifier, or None if missing/invalid."""
    if not raw or not isinstance(raw, str):
        return None
    cleaned = raw.strip()
    if not WORKSPACE_ID_RE.match(cleaned):
        return None
    return cleaned


def _connect(dsn: str) -> psycopg.Connection[Any]:
    """Open a PgBouncer-safe connection to Neon Postgres."""
    return psycopg.connect(
        dsn,
        autocommit=True,
        prepare_threshold=None,
        connect_timeout=CONNECT_TIMEOUT_SECONDS,
    )


def _ensure_schema(conn: psycopg.Connection[Any], dsn: str) -> None:
    """Run idempotent table creation once per process for the active DSN."""
    global _schema_initialized_dsn
    if _schema_initialized_dsn == dsn:
        return
    with _schema_lock:
        if _schema_initialized_dsn == dsn:
            return
        with conn.cursor() as cur:
            for ddl in _SCHEMA_SQL:
                cur.execute(ddl)
        _schema_initialized_dsn = dsn


def _touch_workspace(cur: psycopg.Cursor[Any], workspace_id: str) -> None:
    cur.execute(
        """
        INSERT INTO relay_workspaces (workspace_id)
        VALUES (%s)
        ON CONFLICT (workspace_id)
        DO UPDATE SET updated_at = NOW()
        """,
        (workspace_id,),
    )


def load_workspace_snapshot(workspace_id: str) -> dict[str, Any]:
    """Load persisted mutations, workflows, messages, and telemetry count for a workspace."""
    dsn = get_database_url()
    if dsn is None:
        return {
            "workspaceId": workspace_id,
            "databaseConnected": False,
            "mutations": [],
            "workflows": [],
            "messages": [],
            "telemetryCount": 0,
        }

    with _connect(dsn) as conn:
        _ensure_schema(conn, dsn)
        with conn.cursor() as cur:
            cur.execute(
                "SELECT mutations_json FROM relay_twin_mutations WHERE workspace_id = %s",
                (workspace_id,),
            )
            mut_row = cur.fetchone()
            mutations = list(mut_row[0]) if mut_row and isinstance(mut_row[0], list) else []

            cur.execute(
                """
                SELECT workflow_json, custom_name, saved_at
                FROM relay_workflows
                WHERE workspace_id = %s
                ORDER BY saved_at DESC
                LIMIT %s
                """,
                (workspace_id, MAX_WORKFLOWS_PER_WORKSPACE),
            )
            workflows: list[dict[str, Any]] = []
            for wf_json, custom_name, saved_at in cur.fetchall():
                if not isinstance(wf_json, Mapping):
                    continue
                record: dict[str, Any] = {
                    "workflow": dict(wf_json),
                    "savedAt": saved_at.isoformat() if hasattr(saved_at, "isoformat") else str(saved_at),
                }
                if isinstance(custom_name, str) and custom_name.strip():
                    record["customName"] = custom_name.strip()
                workflows.append(record)

            cur.execute(
                "SELECT messages_json FROM relay_chat_sessions WHERE workspace_id = %s",
                (workspace_id,),
            )
            msg_row = cur.fetchone()
            messages = list(msg_row[0]) if msg_row and isinstance(msg_row[0], list) else []

            cur.execute(
                "SELECT COUNT(*) FROM relay_telemetry_events WHERE workspace_id = %s",
                (workspace_id,),
            )
            cnt_row = cur.fetchone()
            telemetry_count = int(cnt_row[0]) if cnt_row else 0

    return {
        "workspaceId": workspace_id,
        "databaseConnected": True,
        "mutations": mutations,
        "workflows": workflows,
        "messages": messages,
        "telemetryCount": telemetry_count,
    }


def save_workspace_mutations(
    workspace_id: str,
    mutations: Sequence[Mapping[str, Any]],
) -> bool:
    """Persist validated Digital Twin mutations for a workspace. Returns True if persisted."""
    dsn = get_database_url()
    if dsn is None:
        return False

    payload_json = json.dumps(list(mutations), separators=(",", ":"), allow_nan=False)
    with _connect(dsn) as conn:
        _ensure_schema(conn, dsn)
        with conn.cursor() as cur:
            _touch_workspace(cur, workspace_id)
            cur.execute(
                """
                INSERT INTO relay_twin_mutations (workspace_id, mutations_json, updated_at)
                VALUES (%s, %s::jsonb, NOW())
                ON CONFLICT (workspace_id)
                DO UPDATE SET mutations_json = EXCLUDED.mutations_json, updated_at = NOW()
                """,
                (workspace_id, payload_json),
            )
    return True


def save_workspace_workflows(
    workspace_id: str,
    records: Sequence[Mapping[str, Any]],
) -> bool:
    """Replace the saved workflow list for a workspace in Neon Postgres."""
    dsn = get_database_url()
    if dsn is None:
        return False

    bounded = list(records)[:MAX_WORKFLOWS_PER_WORKSPACE]
    with _connect(dsn) as conn:
        _ensure_schema(conn, dsn)
        with conn.cursor() as cur:
            _touch_workspace(cur, workspace_id)
            cur.execute(
                "DELETE FROM relay_workflows WHERE workspace_id = %s",
                (workspace_id,),
            )
            for item in bounded:
                wf = item.get("workflow")
                if not isinstance(wf, Mapping):
                    continue
                wf_id = wf.get("workflowId")
                if not isinstance(wf_id, str) or not wf_id.strip():
                    continue
                custom_name = item.get("customName")
                clean_custom = (
                    custom_name.strip()[:120]
                    if isinstance(custom_name, str) and custom_name.strip()
                    else None
                )
                saved_at = item.get("savedAt")
                wf_json = json.dumps(dict(wf), separators=(",", ":"), allow_nan=False)
                if isinstance(saved_at, str) and saved_at.strip():
                    cur.execute(
                        """
                        INSERT INTO relay_workflows
                            (workspace_id, workflow_id, workflow_json, custom_name, saved_at)
                        VALUES (%s, %s, %s::jsonb, %s, %s::timestamptz)
                        ON CONFLICT (workspace_id, workflow_id)
                        DO UPDATE SET
                            workflow_json = EXCLUDED.workflow_json,
                            custom_name = EXCLUDED.custom_name,
                            saved_at = EXCLUDED.saved_at
                        """,
                        (workspace_id, wf_id.strip(), wf_json, clean_custom, saved_at.strip()),
                    )
                else:
                    cur.execute(
                        """
                        INSERT INTO relay_workflows
                            (workspace_id, workflow_id, workflow_json, custom_name, saved_at)
                        VALUES (%s, %s, %s::jsonb, %s, NOW())
                        ON CONFLICT (workspace_id, workflow_id)
                        DO UPDATE SET
                            workflow_json = EXCLUDED.workflow_json,
                            custom_name = EXCLUDED.custom_name,
                            saved_at = NOW()
                        """,
                        (workspace_id, wf_id.strip(), wf_json, clean_custom),
                    )
    return True


def save_workspace_messages(
    workspace_id: str,
    messages: Sequence[Mapping[str, Any]],
) -> bool:
    """Persist bounded UIMessage chat history for a workspace."""
    dsn = get_database_url()
    if dsn is None:
        return False

    bounded = list(messages)[-MAX_STORED_MESSAGES:]
    payload_json = json.dumps(bounded, separators=(",", ":"), allow_nan=False)
    with _connect(dsn) as conn:
        _ensure_schema(conn, dsn)
        with conn.cursor() as cur:
            _touch_workspace(cur, workspace_id)
            cur.execute(
                """
                INSERT INTO relay_chat_sessions (workspace_id, messages_json, updated_at)
                VALUES (%s, %s::jsonb, NOW())
                ON CONFLICT (workspace_id)
                DO UPDATE SET messages_json = EXCLUDED.messages_json, updated_at = NOW()
                """,
                (workspace_id, payload_json),
            )
    return True


def record_telemetry_event(
    workspace_id: str,
    telemetry: Mapping[str, Any],
) -> bool:
    """Append one AI Gateway telemetry observation to the workspace FinOps audit log."""
    dsn = get_database_url()
    if dsn is None:
        return False

    with _connect(dsn) as conn:
        _ensure_schema(conn, dsn)
        with conn.cursor() as cur:
            _touch_workspace(cur, workspace_id)
            cur.execute(
                """
                INSERT INTO relay_telemetry_events (
                    workspace_id,
                    tier,
                    primary_model,
                    served_model,
                    failover,
                    input_tokens,
                    cached_tokens,
                    output_tokens,
                    cost_usd,
                    baseline_cost_usd,
                    latency_ms
                )
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                """,
                (
                    workspace_id,
                    str(telemetry.get("tier") or "fast"),
                    str(telemetry.get("primaryModel") or ""),
                    str(telemetry.get("servedModel") or ""),
                    str(telemetry.get("failover") or "none"),
                    int(telemetry.get("inputTokens") or 0),
                    int(telemetry.get("cachedTokens") or 0),
                    int(telemetry.get("outputTokens") or 0),
                    float(telemetry.get("costUsd") or 0.0),
                    float(telemetry.get("baselineCostUsd") or 0.0),
                    float(telemetry.get("latencyMs") or 0.0),
                ),
            )
    return True


def reset_workspace_data(workspace_id: str) -> bool:
    """Delete a workspace row (cascading to mutations, workflows, messages, telemetry)."""
    dsn = get_database_url()
    if dsn is None:
        return False

    with _connect(dsn) as conn:
        _ensure_schema(conn, dsn)
        with conn.cursor() as cur:
            cur.execute(
                "DELETE FROM relay_workspaces WHERE workspace_id = %s",
                (workspace_id,),
            )
    return True


def _normalize_pg_scalar(value: Any) -> Any:
    """Convert psycopg return types (Decimal, date, -0.0) into clean JSON scalars."""
    if isinstance(value, Decimal):
        f = float(value)
        return 0.0 if f == 0.0 else f
    if isinstance(value, float) and not isinstance(value, bool):
        return 0.0 if value == 0.0 else value
    if hasattr(value, "isoformat") and not isinstance(value, str):
        return value.isoformat()
    return value


def _ensure_performance_seeded(
    conn: psycopg.Connection[Any],
    dsn: str,
    data_dir: Path | None = None,
) -> int:
    """Seed relay_daily_performance once per Neon branch via fast COPY FROM STDIN."""
    global _perf_seeded_dsn
    if _perf_seeded_dsn == dsn:
        with conn.cursor() as cur:
            cur.execute("SELECT COUNT(*) FROM relay_daily_performance")
            row = cur.fetchone()
            return int(row[0]) if row else 0

    with _perf_seed_lock:
        with conn.cursor() as cur:
            cur.execute("SELECT COUNT(*) FROM relay_daily_performance")
            existing = cur.fetchone()
            existing_count = int(existing[0]) if existing else 0
            if existing_count > 0:
                _perf_seeded_dsn = dsn
                return existing_count

            csv_text = get_rows_csv_text(data_dir)
            reader = csv.reader(io.StringIO(csv_text, newline=""))
            header = next(reader, None)
            if header is None or tuple(header) != EXPECTED_CSV_COLUMNS:
                raise ValueError(f"Unexpected rows.csv header {header!r}")

            copy_sql = (
                "COPY relay_daily_performance "
                "(date, channel, campaign_id, ad_group_id, spend, clicks, conversions, pipeline_value) "
                "FROM STDIN"
            )
            inserted = 0
            with cur.copy(copy_sql) as copy:
                for row in reader:
                    if not row:
                        continue
                    copy.write_row(
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
                    )
                    inserted += 1
            _perf_seeded_dsn = dsn
            return inserted


def run_postgres_analytics_query(
    pg_sql: str,
    params: Sequence[Any] = (),
    *,
    data_dir: Path | None = None,
) -> dict[str, Any]:
    """Execute a parameterized analytics template directly against Neon Postgres."""
    dsn = get_database_url()
    if dsn is None:
        raise RuntimeError("Neon Postgres DATABASE_URL is not configured.")

    with _connect(dsn) as conn:
        _ensure_schema(conn, dsn)
        rows_scanned = _ensure_performance_seeded(conn, dsn, data_dir=data_dir)
        with conn.cursor() as cur:
            cur.execute(pg_sql, tuple(params))
            columns = [desc.name for desc in (cur.description or ())]
            raw_rows = cur.fetchall()

    table = [
        {col: _normalize_pg_scalar(val) for col, val in zip(columns, raw_row, strict=True)}
        for raw_row in raw_rows
    ]
    return {
        "rowsScanned": rows_scanned,
        "rowsReturned": len(table),
        "table": table,
    }


def fetch_campaign_daily_series(
    campaign_ids: Sequence[str],
    *,
    data_dir: Path | None = None,
) -> dict[str, list[dict[str, Any]]] | None:
    """Fetch compact daily spend/pipeline history per campaign from Neon Postgres.

    Returns None when DATABASE_URL is unset so callers can fall back to local CSV.
    """
    dsn = get_database_url()
    if dsn is None or not campaign_ids:
        return None

    unique_ids = list(dict.fromkeys(cid.strip() for cid in campaign_ids if cid and cid.strip()))
    if not unique_ids:
        return None

    with _connect(dsn) as conn:
        _ensure_schema(conn, dsn)
        _ensure_performance_seeded(conn, dsn, data_dir=data_dir)
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT
                    campaign_id,
                    date::text AS date,
                    SUM(spend)::double precision AS spend,
                    SUM(pipeline_value)::double precision AS pipeline_value,
                    SUM(conversions)::integer AS conversions
                FROM relay_daily_performance
                WHERE campaign_id = ANY(%s)
                GROUP BY campaign_id, date
                ORDER BY campaign_id ASC, date ASC
                """,
                (unique_ids,),
            )
            grouped: dict[str, list[dict[str, Any]]] = {cid: [] for cid in unique_ids}
            for cid, date_str, spend, pipeline_val, conv in cur.fetchall():
                grouped.setdefault(str(cid), []).append(
                    {
                        "date": str(date_str),
                        "spend": float(_normalize_pg_scalar(spend)),
                        "pipeline_value": float(_normalize_pg_scalar(pipeline_val)),
                        "conversions": int(conv),
                    }
                )
    return grouped
