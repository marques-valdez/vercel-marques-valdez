"""Vercel Sandbox SQLite runner with deterministic in-process stdlib fallback.

Architecture role:
    Offloads heavy row-level aggregations (10,400 daily performance rows) out of
    application pod RAM and out of the LLM context window by running a small
    stdlib Python + SQLite script inside an isolated Firecracker microVM. Only
    the compact aggregated JSON table (3-20 rows) returns to the model, avoiding
    ~140K+ prompt tokens per turn.

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
import os
from pathlib import Path
import sqlite3
import time
from typing import Any, Final, Literal, Mapping, Sequence

import anyio
from pydantic import BaseModel, ConfigDict
from vercel import sandbox
from vercel.oidc.credentials import get_credentials
from vercel.sandbox import NetworkPolicy

from app.sql_templates import TemplateId, compile_sql_template
from app.twin import EXPECTED_CSV_COLUMNS, get_rows_csv_text

SANDBOX_TIMEOUT_SECONDS: Final[int] = 30
SANDBOX_KILL_AFTER_SECONDS: Final[int] = 25
MAX_SANDBOXES_PER_REQUEST: Final[int] = 1
CHARS_PER_ESTIMATED_TOKEN: Final[int] = 4

SandboxMode = Literal["sandbox", "in-process"]

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


async def run_sandbox_query(
    template_id: str = "channel_roas_summary",
    params: Mapping[str, Any] | None = None,
    *,
    data_dir: Path | None = None,
    prefer_in_process: bool = False,
) -> SandboxQueryResult:
    """Run parameterized SQLite analytics in Vercel Sandbox with in-process fallback."""
    compiled = compile_sql_template(template_id, params)
    csv_text = get_rows_csv_text(data_dir)
    job_source = build_job_script(compiled.sql, compiled.params)

    t0 = time.perf_counter()
    parsed: Mapping[str, Any] | None = None
    mode: SandboxMode = "in-process"

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
