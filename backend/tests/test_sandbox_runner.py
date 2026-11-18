"""Tests for parameterized SQL templates and Vercel Sandbox vs in-process SQLite parity."""

from __future__ import annotations

import contextlib
import io
import json
from pathlib import Path
from typing import Any

import anyio
import httpx
import pytest
from vercel import sandbox
from vercel.sandbox import (
    CompletedCommand,
    NetworkPolicy,
    SandboxApiError,
    SandboxCredentialsError,
    SandboxTimeoutError,
)

from app.sandbox_runner import (
    SANDBOX_KILL_AFTER_SECONDS,
    SANDBOX_TIMEOUT_SECONDS,
    build_job_script,
    compute_estimated_tokens_avoided,
    get_request_sandbox_count,
    is_sandbox_available,
    is_sandbox_disabled,
    reset_request_sandbox_budget,
    restore_request_sandbox_budget,
    run_sandbox_query,
    run_sqlite_job,
)
from app.sql_templates import TEMPLATE_IDS, compile_sql_template, normalize_channel_filter
from app.twin import clear_twin_caches


class _FakeSandboxFs:
    """In-memory async filesystem recording write_text calls inside FakeSandbox."""

    def __init__(self, files: dict[str, str]) -> None:
        self._files = files

    async def write_text(self, path: str, content: str, encoding: str = "utf-8") -> None:
        assert encoding == "utf-8"
        self._files[path] = content


class _FakeSandbox:
    """Async context-manager double executing generated job.py directly in Python."""

    def __init__(
        self,
        work_dir: Path,
        recorder: list[dict[str, Any]],
        *,
        error_to_raise: Exception | None = None,
        stdout_override: bytes | None = None,
        sleep_seconds: float = 0.0,
    ) -> None:
        self._work_dir = work_dir
        self._recorder = recorder
        self._error_to_raise = error_to_raise
        self._stdout_override = stdout_override
        self._sleep_seconds = sleep_seconds
        self.files: dict[str, str] = {}
        self.fs = _FakeSandboxFs(self.files)
        self.closed = False

    async def __aenter__(self) -> _FakeSandbox:
        if self._error_to_raise is not None:
            raise self._error_to_raise
        return self

    async def __aexit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        tb: Any,
    ) -> bool:
        self.closed = True
        self._recorder[-1]["closed"] = True
        return False

    async def run_command(
        self,
        cmd: str,
        args: list[str] | None = None,
        *,
        capture_output: bool = False,
        check: bool = False,
        kill_after: int | float | None = None,
    ) -> CompletedCommand:
        assert cmd == "python"
        assert args == ["job.py"]
        assert capture_output is True
        assert check is True
        assert kill_after == SANDBOX_KILL_AFTER_SECONDS
        assert "rows.csv" in self.files
        assert "job.py" in self.files

        self._recorder[-1]["command"] = {
            "cmd": cmd,
            "args": list(args or ()),
            "capture_output": capture_output,
            "check": check,
            "kill_after": kill_after,
        }

        if self._sleep_seconds > 0:
            await anyio.sleep(self._sleep_seconds)

        if self._stdout_override is not None:
            raw_stdout = self._stdout_override
        else:
            run_dir = self._work_dir / f"box_{len(self._recorder)}"
            run_dir.mkdir(parents=True, exist_ok=True)
            (run_dir / "rows.csv").write_text(self.files["rows.csv"], encoding="utf-8")

            prev_cwd = Path.cwd()
            stdout_buf = io.StringIO()
            ns: dict[str, Any] = {"__name__": "__main__"}
            import os

            os.chdir(run_dir)
            try:
                with contextlib.redirect_stdout(stdout_buf):
                    exec(compile(self.files["job.py"], "job.py", "exec"), ns)
            finally:
                os.chdir(prev_cwd)
            raw_stdout = stdout_buf.getvalue().encode("utf-8")

        return CompletedCommand(
            id="cmd_test_01",
            name=cmd,
            args=tuple(args or ()),
            cwd="/vercel/sandbox",
            session_id="sess_test_01",
            started_at=1,
            returncode=0,
            stdout=raw_stdout,
            stderr=b"",
        )


def _install_fake_sandbox(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    recorder: list[dict[str, Any]],
    *,
    error_to_raise: Exception | None = None,
    stdout_override: bytes | None = None,
    sleep_seconds: float = 0.0,
) -> None:
    def _fake_create_sandbox(
        *,
        network_policy: NetworkPolicy | None = None,
        execution_time_limit: int | float | None = None,
        persistent: bool | None = None,
        **kwargs: Any,
    ) -> _FakeSandbox:
        import app.sandbox_runner as sr

        assert network_policy == NetworkPolicy.deny_all()
        assert execution_time_limit == sr.SANDBOX_TIMEOUT_SECONDS
        assert persistent is False
        recorder.append(
            {
                "network_policy": network_policy,
                "execution_time_limit": execution_time_limit,
                "persistent": persistent,
                "kwargs": kwargs,
                "closed": False,
            }
        )
        return _FakeSandbox(
            tmp_path,
            recorder,
            error_to_raise=error_to_raise,
            stdout_override=stdout_override,
            sleep_seconds=sleep_seconds,
        )

    monkeypatch.setattr(sandbox, "create_sandbox", _fake_create_sandbox)


@pytest.mark.parametrize("template_id", TEMPLATE_IDS)
async def test_sandbox_and_in_process_table_parity_across_all_templates(
    template_id: str,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    recorder: list[dict[str, Any]] = []
    _install_fake_sandbox(monkeypatch, tmp_path, recorder)

    monkeypatch.setenv("SANDBOX_DISABLED", "0")
    token = reset_request_sandbox_budget()
    try:
        sandbox_res = await run_sandbox_query(template_id)
    finally:
        restore_request_sandbox_budget(token)

    monkeypatch.setenv("SANDBOX_DISABLED", "1")
    token_disabled = reset_request_sandbox_budget()
    try:
        fallback_res = await run_sandbox_query(template_id)
    finally:
        restore_request_sandbox_budget(token_disabled)

    assert len(recorder) == 1
    assert recorder[0]["closed"] is True
    assert sandbox_res.mode == "sandbox"
    assert fallback_res.mode == "in-process"
    assert sandbox_res.templateId == template_id
    assert fallback_res.templateId == template_id
    assert sandbox_res.rowsScanned == 10400
    assert fallback_res.rowsScanned == 10400
    assert sandbox_res.rowsReturned == fallback_res.rowsReturned
    assert sandbox_res.rowsReturned >= 1
    assert sandbox_res.sql == fallback_res.sql
    assert sandbox_res.table == fallback_res.table
    assert sandbox_res.estTokensAvoided == fallback_res.estTokensAvoided
    assert sandbox_res.estTokensAvoided > 100_000


async def test_channel_slug_and_display_name_normalization_and_aliases(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("SANDBOX_DISABLED", "1")

    assert normalize_channel_filter(None) is None
    assert normalize_channel_filter("all") is None
    assert normalize_channel_filter("google_ads") == "Google Ads"
    assert normalize_channel_filter("Google Ads") == "Google Ads"
    assert normalize_channel_filter("linkedin") == "LinkedIn Ads"
    assert normalize_channel_filter("meta_ads") == "Meta Ads"

    with pytest.raises(ValueError):
        normalize_channel_filter("tiktok_ads")

    by_slug = await run_sandbox_query("channel_summary", {"channel": "google_ads"})
    by_label = await run_sandbox_query("channel_roas_summary", {"channel": "Google Ads"})
    assert by_slug.templateId == "channel_roas_summary"
    assert by_slug.rowsScanned == 10400
    assert by_slug.rowsReturned == 1
    assert by_slug.table == by_label.table
    assert by_slug.table[0]["channel"] == "Google Ads"
    assert by_slug.table[0]["campaigns"] == 5
    assert by_slug.table[0]["ad_groups"] == 50

    campaigns_google = await run_sandbox_query(
        "campaign_roas", {"channel": "google_ads", "sort_order": "desc"}
    )
    assert campaigns_google.templateId == "campaign_roas_ranking"
    assert campaigns_google.rowsScanned == 10400
    assert campaigns_google.rowsReturned == 5
    assert campaigns_google.table[0]["campaign_id"] == "cmp_google_01"

    ad_groups_zero = await run_sandbox_query(
        "ad_group_outliers",
        {"zero_conversions_only": True, "limit": 10},
    )
    assert ad_groups_zero.templateId == "ad_group_efficiency"
    assert ad_groups_zero.rowsReturned == 10
    assert all(row["total_conversions"] == 0 for row in ad_groups_zero.table)


async def test_sql_templates_reject_raw_sql_and_invalid_parameters() -> None:
    for bad_template in ("SELECT * FROM rows", "drop_table", "unknown_template"):
        with pytest.raises(ValueError):
            compile_sql_template(bad_template)

    for bad_params in (
        {"start_date": "2026/11/01"},
        {"end_date": "2026-11-17; DROP TABLE rows;"},
        {"campaign_id": "cmp_google_01' OR '1'='1"},
        {"sort_order": "DESC; DROP TABLE rows"},
        {"limit": 0},
        {"limit": 999},
        {"limit": True},
        {"days": 0},
        {"days": True},
        {"zero_conversions_only": "yes"},
    ):
        with pytest.raises(ValueError):
            compile_sql_template("ad_group_efficiency", bad_params)


@pytest.mark.parametrize(
    "injected_fault",
    [
        SandboxCredentialsError("Missing sandbox OIDC token"),
        SandboxApiError(httpx.Response(503), "Sandbox microVM capacity exhausted"),
        SandboxTimeoutError("Sandbox creation timed out"),
        RuntimeError("Simulated non-zero python exit status"),
    ],
)
async def test_sandbox_errors_fall_back_cleanly_to_in_process(
    injected_fault: Exception,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    recorder: list[dict[str, Any]] = []
    _install_fake_sandbox(
        monkeypatch, tmp_path, recorder, error_to_raise=injected_fault
    )
    monkeypatch.setenv("SANDBOX_DISABLED", "0")

    token = reset_request_sandbox_budget()
    try:
        res = await run_sandbox_query("channel_roas_summary")
    finally:
        restore_request_sandbox_budget(token)

    assert len(recorder) == 1
    assert res.mode == "in-process"
    assert res.rowsScanned == 10400
    assert res.rowsReturned == 3


async def test_malformed_stdout_and_timeout_fall_back_to_in_process(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    recorder_bad_json: list[dict[str, Any]] = []
    _install_fake_sandbox(
        monkeypatch,
        tmp_path,
        recorder_bad_json,
        stdout_override=b"not-valid-json",
    )
    monkeypatch.setenv("SANDBOX_DISABLED", "0")

    token = reset_request_sandbox_budget()
    try:
        bad_json_res = await run_sandbox_query("channel_roas_summary")
    finally:
        restore_request_sandbox_budget(token)
    assert bad_json_res.mode == "in-process"
    assert bad_json_res.rowsReturned == 3

    # Also test timeout inside anyio.fail_after converting to TimeoutError -> fallback.
    import app.sandbox_runner as sr

    monkeypatch.setattr(sr, "SANDBOX_TIMEOUT_SECONDS", 0.05)
    recorder_timeout: list[dict[str, Any]] = []
    _install_fake_sandbox(
        monkeypatch,
        tmp_path,
        recorder_timeout,
        sleep_seconds=0.5,
    )
    token_timeout = reset_request_sandbox_budget()
    try:
        timeout_res = await run_sandbox_query("channel_roas_summary")
    finally:
        restore_request_sandbox_budget(token_timeout)
    assert timeout_res.mode == "in-process"
    assert timeout_res.rowsReturned == 3
    assert recorder_timeout[0]["closed"] is True


async def test_per_request_single_sandbox_cap_and_reset(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    recorder: list[dict[str, Any]] = []
    _install_fake_sandbox(monkeypatch, tmp_path, recorder)
    monkeypatch.setenv("SANDBOX_DISABLED", "0")

    token = reset_request_sandbox_budget()
    try:
        assert get_request_sandbox_count() == 0
        first = await run_sandbox_query("channel_roas_summary")
        assert get_request_sandbox_count() == 1
        second = await run_sandbox_query("campaign_roas_ranking")
        assert get_request_sandbox_count() == 1
    finally:
        restore_request_sandbox_budget(token)

    assert len(recorder) == 1
    assert first.mode == "sandbox"
    assert second.mode == "in-process"

    # Next HTTP request resets the budget and gets a fresh sandbox slot.
    token_next = reset_request_sandbox_budget()
    try:
        third = await run_sandbox_query("channel_roas_summary")
    finally:
        restore_request_sandbox_budget(token_next)
    assert len(recorder) == 2
    assert third.mode == "sandbox"


def test_is_sandbox_available_zero_network_credentials_check(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    for var in (
        "SANDBOX_DISABLED",
        "VERCEL_OIDC_TOKEN",
        "VERCEL_OIDC_TOKEN_FILE",
        "VERCEL_TOKEN",
        "VERCEL_PROJECT_ID",
        "VERCEL_TEAM_ID",
    ):
        monkeypatch.delenv(var, raising=False)

    assert is_sandbox_disabled() is False
    assert is_sandbox_available() is False

    monkeypatch.setenv("VERCEL_TOKEN", "tok_local")
    monkeypatch.setenv("VERCEL_PROJECT_ID", "prj_demo")
    monkeypatch.setenv("VERCEL_TEAM_ID", "team_demo")
    assert is_sandbox_available() is True

    monkeypatch.setenv("SANDBOX_DISABLED", "1")
    assert is_sandbox_disabled() is True
    assert is_sandbox_available() is False


async def test_dynamic_unseen_synthetic_dataset_computation(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    csv_lines = [
        "date,channel,campaign_id,ad_group_id,spend,clicks,conversions,pipeline_value",
        "2026-11-15,Google Ads,cmp_g1,ag_g1,100.00,50,5,600.00",
        "2026-11-16,Google Ads,cmp_g1,ag_g1,150.00,75,6,900.00",
        "2026-11-16,LinkedIn Ads,cmp_l1,ag_l1,200.00,40,1,160.00",
    ]
    csv_text = "\n".join(csv_lines) + "\n"
    (tmp_path / "rows.csv").write_text(csv_text, encoding="utf-8")
    clear_twin_caches()

    recorder: list[dict[str, Any]] = []
    _install_fake_sandbox(monkeypatch, tmp_path, recorder)
    monkeypatch.setenv("SANDBOX_DISABLED", "0")

    token = reset_request_sandbox_budget()
    try:
        res_sbx = await run_sandbox_query("channel_roas_summary", data_dir=tmp_path)
    finally:
        restore_request_sandbox_budget(token)

    monkeypatch.setenv("SANDBOX_DISABLED", "1")
    res_mem = await run_sandbox_query("channel_roas_summary", data_dir=tmp_path)

    assert res_sbx.mode == "sandbox"
    assert res_mem.mode == "in-process"
    assert res_sbx.rowsScanned == 3
    assert res_sbx.rowsReturned == 2
    assert res_sbx.table == res_mem.table
    assert res_sbx.table[0]["channel"] == "Google Ads"
    assert res_sbx.table[0]["total_spend"] == 250.0
    assert res_sbx.table[0]["total_pipeline_value"] == 1500.0
    assert res_sbx.table[0]["roas"] == 6.0
    assert res_sbx.table[1]["channel"] == "LinkedIn Ads"
    assert res_sbx.table[1]["roas"] == 0.8

    # Also verify build_job_script & run_sqlite_job helper parity directly.
    compiled = compile_sql_template("channel_roas_summary", {"days": 1})
    assert "LIMIT ?" in compiled.sql
    direct = run_sqlite_job(csv_text, compiled.sql, compiled.params)
    assert direct["rowsScanned"] == 3
    assert direct["rowsReturned"] == 2
    assert compute_estimated_tokens_avoided("x", direct["table"]) == 0
    assert "SPEC = json.loads" in build_job_script(compiled.sql, compiled.params)


async def test_multiline_quoted_and_unicode_u2028_csv_byte_exact_parity(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import csv as stdlib_csv

    csv_buf = io.StringIO()
    writer = stdlib_csv.writer(csv_buf, lineterminator="\n")
    writer.writerow(
        [
            "date",
            "channel",
            "campaign_id",
            "ad_group_id",
            "spend",
            "clicks",
            "conversions",
            "pipeline_value",
        ]
    )
    writer.writerow(
        [
            "2026-11-15",
            "Google Ads",
            "cmp_1\ncmp_2",
            "ag_1,\nag_2",
            "120.00",
            "40",
            "4",
            "600.00",
        ]
    )
    writer.writerow(
        [
            "2026-11-16",
            "LinkedIn Ads",
            "cmp_\u2028x",
            "ag_\u2028y",
            "80.00",
            "20",
            "1",
            "240.00",
        ]
    )
    csv_dir = tmp_path / "special_csv"
    csv_dir.mkdir(parents=True, exist_ok=True)
    (csv_dir / "rows.csv").write_text(csv_buf.getvalue(), encoding="utf-8")
    clear_twin_caches()

    sbx_work_dir = tmp_path / "sbx_work"
    sbx_work_dir.mkdir(parents=True, exist_ok=True)
    recorder: list[dict[str, Any]] = []
    _install_fake_sandbox(monkeypatch, sbx_work_dir, recorder)

    monkeypatch.setenv("SANDBOX_DISABLED", "0")
    token = reset_request_sandbox_budget()
    try:
        res_sbx = await run_sandbox_query("campaign_roas_ranking", data_dir=csv_dir)
    finally:
        restore_request_sandbox_budget(token)

    monkeypatch.setenv("SANDBOX_DISABLED", "1")
    res_mem = await run_sandbox_query("campaign_roas_ranking", data_dir=csv_dir)

    assert len(recorder) == 1
    assert res_sbx.mode == "sandbox"
    assert res_mem.mode == "in-process"
    assert res_sbx.rowsScanned == 2
    assert res_mem.rowsScanned == 2
    assert res_sbx.rowsReturned == 2
    assert res_mem.rowsReturned == 2
    assert json.dumps(
        res_sbx.table, separators=(",", ":"), allow_nan=False
    ) == json.dumps(
        res_mem.table, separators=(",", ":"), allow_nan=False
    )
    assert [row["campaign_id"] for row in res_sbx.table] == [
        "cmp_1\ncmp_2",
        "cmp_\u2028x",
    ]


async def test_channel_roas_summary_explicit_limit_and_default_parity(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    recorder: list[dict[str, Any]] = []
    _install_fake_sandbox(monkeypatch, tmp_path, recorder)

    for params, expected_rows in (
        ({"limit": 1}, 1),
        ({"limit": 2}, 2),
        (None, 3),
    ):
        monkeypatch.setenv("SANDBOX_DISABLED", "0")
        token = reset_request_sandbox_budget()
        try:
            sbx_res = await run_sandbox_query("channel_roas_summary", params)
        finally:
            restore_request_sandbox_budget(token)

        monkeypatch.setenv("SANDBOX_DISABLED", "1")
        mem_res = await run_sandbox_query("channel_roas_summary", params)

        assert sbx_res.mode == "sandbox"
        assert mem_res.mode == "in-process"
        assert sbx_res.rowsScanned == 10400
        assert mem_res.rowsScanned == 10400
        assert sbx_res.rowsReturned == expected_rows
        assert mem_res.rowsReturned == expected_rows
        assert sbx_res.sql == mem_res.sql
        assert sbx_res.table == mem_res.table
        assert sbx_res.estTokensAvoided == mem_res.estTokensAvoided

    top_one = await run_sandbox_query("channel_roas_summary", {"limit": 1})
    assert top_one.table[0]["channel"] == "Google Ads"

