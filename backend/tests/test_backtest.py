"""Tests for the guardrail backtest, the dated dataset scenarios, and the gated Neon reseed."""

from __future__ import annotations

import csv
import hashlib
import io
import importlib.util
from pathlib import Path
from typing import Any

from fastapi.testclient import TestClient
import pytest

from app import db
from app.backtest import (
    BACKTEST_WINDOW_DAYS,
    BacktestPoint,
    compile_backtest_sql,
    summarize_backtest,
)
from app.main import app, reset_rate_limiter
from app.twin import get_rows_csv_text, load_base_twin

REPO_ROOT = Path(__file__).resolve().parents[2]


def _reference_series(channel_names: set[str]) -> list[tuple[str, float, float]]:
    """Recompute the backtest series in plain Python, independent of the SQL."""
    by_ag: dict[str, dict[str, tuple[float, int]]] = {}
    for row in csv.DictReader(io.StringIO(get_rows_csv_text())):
        if row["channel"] not in channel_names:
            continue
        by_ag.setdefault(row["ad_group_id"], {})[row["date"]] = (
            float(row["spend"]),
            int(row["conversions"]),
        )
    dates = sorted({day for series in by_ag.values() for day in series})
    out: list[tuple[str, float, float]] = []
    for idx, day in enumerate(dates):
        if idx < BACKTEST_WINDOW_DAYS:
            continue
        window = dates[idx - BACKTEST_WINDOW_DAYS : idx]
        spend = 0.0
        at_risk = 0.0
        for series in by_ag.values():
            spend += series[day][0]
            if sum(series[w][1] for w in window) == 0:
                at_risk += series[day][0]
        out.append((day, spend, at_risk))
    return out


@pytest.fixture(autouse=True)
def _isolated(monkeypatch: pytest.MonkeyPatch) -> None:
    for key in ("DATABASE_URL", "POSTGRES_URL", "POSTGRES_PRISMA_URL"):
        monkeypatch.delenv(key, raising=False)
    reset_rate_limiter()


def test_backtest_sql_matches_pure_python_recomputation() -> None:
    client = TestClient(app)
    res = client.post(
        "/api/agent/workflows/backtest",
        json={"workflow": {"template": "daily-pacing-guardrail", "threshold": 15}},
    )
    assert res.status_code == 200
    body = res.json()
    assert body["metric"] == "zero_conversion_spend_share"
    assert body["windowDays"] == 14
    assert body["mode"] == "in-process"
    assert body["thresholdPct"] == 15

    expected = _reference_series({"Google Ads", "LinkedIn Ads", "Meta Ads"})
    assert body["days"] == len(expected) == 86
    assert [p["date"] for p in body["points"]] == [day for day, _s, _r in expected]
    for point, (_day, spend, at_risk) in zip(body["points"], expected):
        assert point["spend"] == pytest.approx(spend, abs=0.01)
        assert point["atRiskSpend"] == pytest.approx(at_risk, abs=0.01)
        assert 0.0 <= point["atRiskPct"] <= 100.0

    expected_alert_days = sum(
        1 for _day, spend, at_risk in expected if round(at_risk / spend * 100.0, 2) >= 15
    )
    assert body["summary"]["alertDays"] == expected_alert_days
    # The scripted site migration on 2026-10-27 is what pushes the series over 15%.
    assert 0 < expected_alert_days < len(expected) / 2
    assert body["summary"]["firstAlertDate"] > "2026-10-27"
    assert body["events"] == [
        {"date": "2026-10-27", "brokenLinks": 8},
        {"date": "2026-11-12", "brokenLinks": 3},
    ]


def test_backtest_channel_filter_day_bounds_and_validation() -> None:
    client = TestClient(app)
    res = client.post(
        "/api/agent/workflows/backtest",
        json={"workflow": {"channels": ["meta_ads"], "threshold": 20}, "days": 30},
    )
    assert res.status_code == 200
    body = res.json()
    assert body["channels"] == ["meta_ads"]
    assert body["days"] == 30
    expected = _reference_series({"Meta Ads"})[-30:]
    assert [p["date"] for p in body["points"]] == [day for day, _s, _r in expected]
    assert body["points"][-1]["spend"] == pytest.approx(expected[-1][1], abs=0.01)
    assert sum(e["brokenLinks"] for e in body["events"]) == 3

    assert client.post("/api/agent/workflows/backtest", json={"days": 29}).status_code == 422
    assert client.post("/api/agent/workflows/backtest", json={"days": 91}).status_code == 422
    assert (
        client.post(
            "/api/agent/workflows/backtest", json={"workflow": {"threshold": 500}}
        ).status_code
        == 422
    )
    assert (
        client.post(
            "/api/agent/workflows/backtest",
            json={"workflow": {"channels": ["x'; DROP TABLE rows; --"]}},
        ).status_code
        == 422
    )
    assert client.post("/api/agent/workflows/backtest", json={}).status_code == 200


def test_backtest_endpoint_is_rate_limited() -> None:
    client = TestClient(app)
    codes = [
        client.post("/api/agent/workflows/backtest", json={"days": 30}).status_code
        for _ in range(31)
    ]
    assert codes[:30] == [200] * 30
    assert codes[30] == 429


def test_compile_backtest_sql_binds_values_and_rejects_bad_input() -> None:
    sqlite_sql = compile_backtest_sql(2, "sqlite")
    pg_sql = compile_backtest_sql(2, "postgres")
    assert "FROM rows" in sqlite_sql and sqlite_sql.count("?") == 3
    assert "FROM relay_daily_performance" in pg_sql and pg_sql.count("%s") == 3
    assert "?" not in pg_sql
    assert sqlite_sql.replace("rows\n", "T\n").replace("?", "P") == pg_sql.replace(
        "relay_daily_performance\n", "T\n"
    ).replace("%s", "P")
    for bad_count in (0, 4, True, "2"):
        with pytest.raises(ValueError):
            compile_backtest_sql(bad_count, "sqlite")  # type: ignore[arg-type]
    with pytest.raises(ValueError):
        compile_backtest_sql(1, "mysql")  # type: ignore[arg-type]


def test_summarize_backtest_threshold_edges_and_streaks() -> None:
    pcts = [5.0, 20.0, 20.0, 5.0, 20.0, 20.0, 20.0]
    points = [
        BacktestPoint(date=f"2026-01-{i + 1:02d}", spend=100.0, atRiskSpend=p, atRiskPct=p)
        for i, p in enumerate(pcts)
    ]
    below = summarize_backtest(points, 4)
    assert (below.alertDays, below.longestStreakDays, below.alertRatePct) == (7, 7, 100.0)
    inside = summarize_backtest(points, 20)
    assert (inside.alertDays, inside.longestStreakDays) == (5, 3)
    assert inside.firstAlertDate == "2026-01-02"
    assert inside.flaggedSpend == 100.0
    assert (inside.minPct, inside.medianPct, inside.maxPct) == (5.0, 20.0, 20.0)
    above = summarize_backtest(points, 21)
    assert (above.alertDays, above.longestStreakDays, above.firstAlertDate) == (0, 0, None)
    empty = summarize_backtest([], 10)
    assert (empty.alertDays, empty.alertRatePct, empty.medianPct) == (0, 0.0, 0.0)


def test_generator_is_deterministic_and_matches_committed_data(tmp_path: Path) -> None:
    spec = importlib.util.spec_from_file_location(
        "generate_twin_under_test", REPO_ROOT / "scripts" / "generate_twin.py"
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)

    twin_a, rows_a = module.build_twin_artifacts()
    twin_b, rows_b = module.build_twin_artifacts()
    assert twin_a == twin_b and rows_a == rows_b
    assert rows_a == get_rows_csv_text()
    assert twin_a == (REPO_ROOT / "backend" / "data" / "twin.json").read_text(encoding="utf-8")

    outage = module.SCENARIOS["resolvedOutage"]
    dates = sorted({r["date"] for r in csv.DictReader(io.StringIO(rows_a))})
    outage_days = set(dates[outage["startOffset"] : outage["endOffset"] + 1])
    outage_ids = {f"ag_google_01_{i:02d}" for i in outage["adGroupIndices"]}
    in_outage = 0
    after_outage = 0
    for row in csv.DictReader(io.StringIO(rows_a)):
        if row["ad_group_id"] in outage_ids:
            if row["date"] in outage_days:
                in_outage += int(row["conversions"])
            elif row["date"] > max(outage_days):
                after_outage += int(row["conversions"])
    assert in_outage == 0
    assert after_outage > 0
    assert not any(
        issue.adGroupId in outage_ids for issue in load_base_twin().hygieneIssues
    )


class _FakeCopy:
    def __init__(self, log: list[Any]) -> None:
        self._log = log
        self.rows = 0

    def __enter__(self) -> "_FakeCopy":
        return self

    def __exit__(self, *exc: Any) -> None:
        self._log.append(("copy_rows", self.rows))

    def write_row(self, row: Any) -> None:
        self.rows += 1


class _FakeCursor:
    def __init__(self, conn: "_FakeConn") -> None:
        self._conn = conn
        self._result: Any = None

    def __enter__(self) -> "_FakeCursor":
        return self

    def __exit__(self, *exc: Any) -> None:
        return None

    def execute(self, sql: str, params: Any = ()) -> None:
        text = " ".join(sql.split())
        self._conn.log.append(("sql", text))
        if text.startswith("SELECT COUNT(*)"):
            self._result = (self._conn.row_count,)
        elif text.startswith("SELECT rows_sha256"):
            self._result = (self._conn.stored_sha,) if self._conn.stored_sha else None
        elif text.startswith("INSERT INTO relay_dataset_meta"):
            self._conn.stored_sha = params[0]

    def fetchone(self) -> Any:
        return self._result

    def copy(self, sql: str) -> _FakeCopy:
        self._conn.log.append(("sql", " ".join(sql.split())))
        return _FakeCopy(self._conn.log)


class _FakeTransaction:
    def __init__(self, log: list[Any]) -> None:
        self._log = log

    def __enter__(self) -> None:
        self._log.append(("begin",))

    def __exit__(self, *exc: Any) -> None:
        self._log.append(("commit",))


class _FakeConn:
    def __init__(self, row_count: int, stored_sha: str | None) -> None:
        self.row_count = row_count
        self.stored_sha = stored_sha
        self.log: list[Any] = []

    def cursor(self) -> _FakeCursor:
        return _FakeCursor(self)

    def transaction(self) -> _FakeTransaction:
        return _FakeTransaction(self.log)


def _statements(conn: _FakeConn) -> list[str]:
    return [entry[1] for entry in conn.log if entry[0] == "sql"]


@pytest.fixture()
def _fresh_seed_state(monkeypatch: pytest.MonkeyPatch) -> str:
    monkeypatch.setattr(db, "_perf_seeded_dsn", None)
    monkeypatch.setattr(db, "_dataset_in_sync_by_dsn", {})
    monkeypatch.delenv(db.DATASET_RESEED_ENV, raising=False)
    return hashlib.sha256(get_rows_csv_text().encode("utf-8")).hexdigest()


def test_stale_shared_database_is_left_untouched_without_opt_in(
    _fresh_seed_state: str,
) -> None:
    conn = _FakeConn(row_count=10400, stored_sha=None)
    assert db._ensure_performance_seeded(conn, "dsn-a") == 10400  # type: ignore[arg-type]
    statements = _statements(conn)
    assert not any(s.startswith(("TRUNCATE", "COPY", "INSERT")) for s in statements)
    assert ("begin",) not in conn.log
    assert db._dataset_in_sync_by_dsn["dsn-a"] is False

    mismatched = _FakeConn(row_count=10400, stored_sha="0" * 64)
    assert db._ensure_performance_seeded(mismatched, "dsn-b") == 10400  # type: ignore[arg-type]
    assert not any(s.startswith(("TRUNCATE", "COPY")) for s in _statements(mismatched))
    assert db._dataset_in_sync_by_dsn["dsn-b"] is False


def test_opt_in_reseed_replaces_rows_in_one_transaction(
    _fresh_seed_state: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv(db.DATASET_RESEED_ENV, "1")
    conn = _FakeConn(row_count=10400, stored_sha="0" * 64)
    assert db._ensure_performance_seeded(conn, "dsn-c") == 10400  # type: ignore[arg-type]

    begin = conn.log.index(("begin",))
    commit = conn.log.index(("commit",))
    inside = [e[1] for e in conn.log[begin:commit] if e[0] == "sql"]
    assert inside[0] == "TRUNCATE relay_daily_performance"
    assert inside[1].startswith("COPY relay_daily_performance")
    assert inside[2].startswith("INSERT INTO relay_dataset_meta")
    assert ("copy_rows", 10400) in conn.log[begin:commit]
    assert conn.stored_sha == _fresh_seed_state
    assert db._dataset_in_sync_by_dsn["dsn-c"] is True


def test_matching_hash_and_empty_table_paths(
    _fresh_seed_state: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv(db.DATASET_RESEED_ENV, "1")
    in_sync = _FakeConn(row_count=10400, stored_sha=_fresh_seed_state)
    assert db._ensure_performance_seeded(in_sync, "dsn-d") == 10400  # type: ignore[arg-type]
    assert not any(s.startswith(("TRUNCATE", "COPY")) for s in _statements(in_sync))
    assert db._dataset_in_sync_by_dsn["dsn-d"] is True

    monkeypatch.delenv(db.DATASET_RESEED_ENV, raising=False)
    monkeypatch.setattr(db, "_perf_seeded_dsn", None)
    empty = _FakeConn(row_count=0, stored_sha=None)
    assert db._ensure_performance_seeded(empty, "dsn-e") == 10400  # type: ignore[arg-type]
    statements = _statements(empty)
    assert not any(s.startswith("TRUNCATE") for s in statements)
    assert any(s.startswith("COPY relay_daily_performance") for s in statements)
    assert empty.stored_sha == _fresh_seed_state
    assert db._dataset_in_sync_by_dsn["dsn-e"] is True
