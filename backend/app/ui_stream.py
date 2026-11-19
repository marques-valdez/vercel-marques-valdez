"""AI SDK UI Message Stream Protocol v1 adapter for Relay Studio's LangGraph agent.

Architecture role:
    Bridges Python (`LangGraph` custom stream events) directly into Vercel's
    frontend `@ai-sdk/react` `useChat()` hook (`ai@7`) without rewriting the
    agent in TypeScript. Setting `x-vercel-ai-ui-message-stream: v1` tells
    `DefaultChatTransport` to parse `start`, `text-delta`, `tool-input-available`,
    `tool-output-available`, `data-telemetry`, `data-sandbox-status`, and
    `finish` frames natively into typed React tool cards.

Safety invariants:
    - `TURN_TIMEOUT_SECONDS = 55.0` keeps turns inside serverless execution
      limits and guarantees a clean terminal `error` + `finish` + `[DONE]` sequence.
    - `sanitize_error_text()` strips local filesystem paths and API credentials
      (provider keys and bearer tokens) before any exception reaches the browser stream.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
from typing import Any, AsyncIterator, Final, Mapping
from uuid import uuid4

UI_MESSAGE_STREAM_HEADERS: Final[dict[str, str]] = {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    "x-vercel-ai-ui-message-stream": "v1",
}

NO_GATEWAY_CREDENTIAL_ERROR: Final[str] = (
    'No AI Gateway credential. Run "vercel env pull" or set AI_GATEWAY_API_KEY.'
)

TURN_TIMEOUT_SECONDS: Final[float] = 55.0
DONE_SSE: Final[str] = "data: [DONE]\n\n"

_PATH_LEAK_RE: Final[re.Pattern[str]] = re.compile(
    r"/(?:usr|var|tmp|home|etc|opt|Users|Volumes|private)(?:/[A-Za-z0-9._\-]+)+"
)
_SECRET_LEAK_RE: Final[re.Pattern[str]] = re.compile(
    r"\b(?:sk-[A-Za-z0-9_\-]{8,}|vck_[A-Za-z0-9_\-]{8,}|gh[po]_[A-Za-z0-9]{8,})\b"
)
_SURROGATE_RE: Final[re.Pattern[str]] = re.compile(r"[\ud800-\udfff]")


def get_gateway_credential() -> str | None:
    """Return the active AI Gateway credential or None when unconfigured."""
    for env_name in ("AI_GATEWAY_API_KEY", "VERCEL_OIDC_TOKEN"):
        value = os.getenv(env_name)
        if value and value.strip():
            return value.strip()
    return None


def format_sse(payload: Mapping[str, Any]) -> str:
    """Encode one UI Message Stream JSON frame as Server-Sent Events data."""
    body = json.dumps(
        payload,
        ensure_ascii=False,
        allow_nan=False,
        separators=(",", ":"),
    )
    return f"data: {body}\n\n"


def sanitize_error_text(error: BaseException | str) -> str:
    """Redact local filesystem paths, secret tokens, and surrogates from error messages."""
    raw = str(error).strip() or "Agent execution failed."
    cleaned = _SURROGATE_RE.sub("\ufffd", raw)
    cleaned = _PATH_LEAK_RE.sub("<redacted-path>", cleaned)
    cleaned = _SECRET_LEAK_RE.sub("<redacted-credential>", cleaned)
    return cleaned[:300]


async def stream_missing_credential_sse(
    *,
    message_id: str | None = None,
) -> AsyncIterator[str]:
    """Emit the exact setup error frame sequence when no AI Gateway key is present."""
    msg_id = message_id or f"msg_{uuid4().hex[:10]}"
    yield format_sse({"type": "start", "messageId": msg_id})
    yield format_sse({"type": "error", "errorText": NO_GATEWAY_CREDENTIAL_ERROR})
    yield format_sse({"type": "finish"})
    yield DONE_SSE


async def stream_langgraph_to_sse(
    graph: Any,
    initial_state: Mapping[str, Any],
    *,
    message_id: str | None = None,
    timeout_seconds: float = TURN_TIMEOUT_SECONDS,
) -> AsyncIterator[str]:
    """Stream LangGraph step events into x-vercel-ai-ui-message-stream: v1 frames."""
    msg_id = message_id or f"msg_{uuid4().hex[:10]}"
    yield format_sse({"type": "start", "messageId": msg_id})

    step_open = False
    text_id: str | None = None

    try:
        async with asyncio.timeout(timeout_seconds):
            async for event in graph.astream(
                dict(initial_state),
                stream_mode="custom",
                config={"recursion_limit": 24},
            ):
                if not isinstance(event, Mapping):
                    continue
                kind = event.get("kind")

                if kind == "step_start":
                    if not step_open:
                        step_open = True
                        yield format_sse({"type": "start-step"})

                elif kind == "text_delta":
                    delta = event.get("delta")
                    if isinstance(delta, str) and delta:
                        if not step_open:
                            step_open = True
                            yield format_sse({"type": "start-step"})
                        if text_id is None:
                            text_id = f"txt_{uuid4().hex[:10]}"
                            yield format_sse({"type": "text-start", "id": text_id})
                        yield format_sse(
                            {"type": "text-delta", "id": text_id, "delta": delta}
                        )

                elif kind == "tool_input":
                    if text_id is not None:
                        yield format_sse({"type": "text-end", "id": text_id})
                        text_id = None
                    yield format_sse(
                        {
                            "type": "tool-input-available",
                            "toolCallId": str(event["toolCallId"]),
                            "toolName": str(event["toolName"]),
                            "input": dict(event.get("input") or {}),
                        }
                    )

                elif kind == "sandbox_status":
                    yield format_sse(
                        {"type": "data-sandbox-status", "data": event["data"]}
                    )

                elif kind == "agent_status":
                    yield format_sse(
                        {"type": "data-agent-status", "data": event["data"]}
                    )

                elif kind == "tool_output":
                    yield format_sse(
                        {
                            "type": "tool-output-available",
                            "toolCallId": str(event["toolCallId"]),
                            "output": event.get("output"),
                        }
                    )

                elif kind == "tool_error":
                    yield format_sse(
                        {
                            "type": "tool-output-error",
                            "toolCallId": str(event["toolCallId"]),
                            "errorText": sanitize_error_text(
                                str(event.get("errorText") or "Tool execution failed.")
                            ),
                        }
                    )

                elif kind == "telemetry":
                    if text_id is not None:
                        yield format_sse({"type": "text-end", "id": text_id})
                        text_id = None
                    yield format_sse({"type": "data-telemetry", "data": event["data"]})

                elif kind == "step_finish":
                    if text_id is not None:
                        yield format_sse({"type": "text-end", "id": text_id})
                        text_id = None
                    if step_open:
                        yield format_sse({"type": "finish-step"})
                        step_open = False

                elif kind == "error":
                    if text_id is not None:
                        yield format_sse({"type": "text-end", "id": text_id})
                        text_id = None
                    if step_open:
                        yield format_sse({"type": "finish-step"})
                        step_open = False
                    yield format_sse(
                        {
                            "type": "error",
                            "errorText": sanitize_error_text(
                                str(event.get("errorText") or "Agent execution failed.")
                            ),
                        }
                    )

        if text_id is not None:
            yield format_sse({"type": "text-end", "id": text_id})
            text_id = None
        if step_open:
            yield format_sse({"type": "finish-step"})
            step_open = False

    except asyncio.CancelledError:
        raise
    except TimeoutError:
        if text_id is not None:
            yield format_sse({"type": "text-end", "id": text_id})
        if step_open:
            yield format_sse({"type": "finish-step"})
        limit_label = (
            str(int(timeout_seconds))
            if float(timeout_seconds).is_integer()
            else f"{timeout_seconds:g}"
        )
        yield format_sse(
            {
                "type": "error",
                "errorText": f"Agent turn exceeded the {limit_label}-second time limit.",
            }
        )
    except Exception as exc:
        if text_id is not None:
            yield format_sse({"type": "text-end", "id": text_id})
        if step_open:
            yield format_sse({"type": "finish-step"})
        yield format_sse({"type": "error", "errorText": sanitize_error_text(exc)})

    yield format_sse({"type": "finish"})
    yield DONE_SSE
