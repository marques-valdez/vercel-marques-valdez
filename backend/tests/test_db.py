"""Tests for Neon Serverless Postgres persistence and /api/agent/workspace endpoints."""

from __future__ import annotations

from fastapi.testclient import TestClient
import pytest

from app import db
from app.main import app


def test_normalize_workspace_id_and_env_detection(monkeypatch: pytest.MonkeyPatch) -> None:
    assert db.normalize_workspace_id("ws_12345678") == "ws_12345678"
    assert db.normalize_workspace_id("  ws-valid_id_01  ") == "ws-valid_id_01"
    assert db.normalize_workspace_id("short") is None
    assert db.normalize_workspace_id("bad/slash/id") is None
    assert db.normalize_workspace_id(None) is None

    for key in ("DATABASE_URL", "POSTGRES_URL", "POSTGRES_PRISMA_URL"):
        monkeypatch.delenv(key, raising=False)
    assert db.is_database_configured() is False

    monkeypatch.setenv("POSTGRES_URL", "postgres://user:pass@ep-demo-pooler.us-east-1.aws.neon.tech/neondb?sslmode=require")
    assert db.is_database_configured() is True
    assert db.get_database_url() is not None


def test_workspace_endpoints_graceful_fallback_without_db(monkeypatch: pytest.MonkeyPatch) -> None:
    for key in ("DATABASE_URL", "POSTGRES_URL", "POSTGRES_PRISMA_URL"):
        monkeypatch.delenv(key, raising=False)

    client = TestClient(app)

    health = client.get("/api/agent/health")
    assert health.status_code == 200
    body = health.json()
    assert body["databaseConnected"] is False
    assert body["databaseProvider"] == "browser-local"

    missing_hdr = client.get("/api/agent/workspace")
    assert missing_hdr.status_code == 422

    ws_headers = {"X-Relay-Workspace": "ws_test_session_01"}
    get_res = client.get("/api/agent/workspace", headers=ws_headers)
    assert get_res.status_code == 200
    snap = get_res.json()
    assert snap["workspaceId"] == "ws_test_session_01"
    assert snap["databaseConnected"] is False
    assert snap["mutations"] == []
    assert snap["workflows"] == []
    assert snap["messages"] == []

    put_mut = client.put(
        "/api/agent/workspace/mutations",
        headers=ws_headers,
        json={"mutations": [{"type": "pause_broken_creatives"}]},
    )
    assert put_mut.status_code == 200
    assert put_mut.json()["totals"]["brokenCreatives"] == 0

    put_wf = client.put(
        "/api/agent/workspace/workflows",
        headers=ws_headers,
        json={"workflows": []},
    )
    assert put_wf.status_code == 200
    assert put_wf.json() == {"ok": True, "persisted": False}

    put_msg = client.put(
        "/api/agent/workspace/messages",
        headers=ws_headers,
        json={"messages": [{"id": "u1", "role": "user", "parts": [{"type": "text", "text": "hi"}]}]},
    )
    assert put_msg.status_code == 200
    assert put_msg.json() == {"ok": True, "persisted": False}

    del_res = client.delete("/api/agent/workspace", headers=ws_headers)
    assert del_res.status_code == 200
    assert del_res.json() == {"ok": True, "persisted": False}
