"""Inbound AI SDK UIMessage validation and conversion to LangChain messages."""

from __future__ import annotations

import json
import re
from typing import Any, Final, Mapping, NamedTuple, Sequence

from langchain_core.messages import (
    AIMessage,
    BaseMessage,
    HumanMessage,
    SystemMessage,
    ToolCall,
    ToolMessage,
)

MAX_MESSAGES: Final[int] = 30
MAX_USER_MESSAGE_CHARS: Final[int] = 2000

VALID_ROLES: Final[frozenset[str]] = frozenset({"user", "assistant", "system"})

STREAM_TOOL_CHUNK_TYPES: Final[frozenset[str]] = frozenset(
    {
        "tool-input-start",
        "tool-input-delta",
        "tool-input-available",
        "tool-output-available",
        "tool-output-error",
        "tool-output-denied",
        "tool-approval-request",
        "tool-approval-response",
    }
)

_LONE_SURROGATE_RE: Final[re.Pattern[str]] = re.compile(r"[\ud800-\udfff]")


class ConvertedConversation(NamedTuple):
    """Validated LangChain message history paired with the newest user prompt text."""

    langchain_messages: list[BaseMessage]
    latest_user_text: str


def contains_lone_surrogate(value: object) -> bool:
    """Iteratively check strings, keys, mappings, and sequences for UTF-16 surrogates."""
    stack: list[object] = [value]
    seen_ids: set[int] = set()
    seen_refs: list[object] = []

    while stack:
        curr = stack.pop()
        if isinstance(curr, str):
            if _LONE_SURROGATE_RE.search(curr):
                return True
        elif isinstance(curr, Mapping):
            obj_id = id(curr)
            if obj_id in seen_ids:
                continue
            seen_ids.add(obj_id)
            seen_refs.append(curr)
            for k, v in curr.items():
                stack.append(k)
                stack.append(v)
        elif isinstance(curr, (list, tuple, set, frozenset)):
            obj_id = id(curr)
            if obj_id in seen_ids:
                continue
            seen_ids.add(obj_id)
            seen_refs.append(curr)
            stack.extend(curr)
    return False


def _extract_text_segments(msg: Mapping[str, Any]) -> list[str]:
    parts = msg.get("parts")
    if isinstance(parts, list) and len(parts) > 0:
        segments: list[str] = []
        for part in parts:
            if not isinstance(part, Mapping):
                raise ValueError("Each message part must be an object")
            if part.get("type") == "text":
                txt = part.get("text")
                if not isinstance(txt, str):
                    raise ValueError("Text part 'text' field must be a string")
                segments.append(txt)
        return segments

    content = msg.get("content")
    if isinstance(content, str):
        return [content]
    if isinstance(content, list):
        out: list[str] = []
        for item in content:
            if isinstance(item, str):
                out.append(item)
            elif isinstance(item, Mapping) and item.get("type") == "text":
                txt = item.get("text")
                if not isinstance(txt, str):
                    raise ValueError("Content text block must contain a string")
                out.append(txt)
        return out
    if content is None and isinstance(parts, list):
        return []
    if content is not None:
        raise ValueError("Message content must be a string or list of content parts")
    return []


def _serialize_tool_output(output: Any) -> str:
    if isinstance(output, str):
        return output
    return json.dumps(
        output,
        ensure_ascii=False,
        allow_nan=False,
        separators=(",", ":"),
    )


def _convert_assistant_message(
    msg: Mapping[str, Any],
    msg_index: int,
) -> list[BaseMessage]:
    parts = msg.get("parts")
    if not isinstance(parts, list) or len(parts) == 0:
        text = "".join(_extract_text_segments(msg))
        return [AIMessage(content=text)] if text else []

    converted: list[BaseMessage] = []
    text_buf: list[str] = []
    tool_pairs: list[tuple[ToolCall, ToolMessage]] = []

    def _flush_step() -> None:
        if tool_pairs:
            converted.append(
                AIMessage(
                    content="".join(text_buf),
                    tool_calls=[tc for tc, _ in tool_pairs],
                )
            )
            converted.extend(tm for _, tm in tool_pairs)
            text_buf.clear()
            tool_pairs.clear()

    for part_idx, part in enumerate(parts):
        if not isinstance(part, Mapping):
            raise ValueError("Assistant message part must be an object")
        part_type = part.get("type")
        if not isinstance(part_type, str) or not part_type:
            continue

        if part_type == "step-start":
            _flush_step()
            continue

        if part_type == "text":
            txt = part.get("text")
            if txt is not None and not isinstance(txt, str):
                raise ValueError("Assistant text part 'text' field must be a string")
            if isinstance(txt, str) and txt:
                if tool_pairs:
                    _flush_step()
                text_buf.append(txt)
            continue

        is_tool_part = part_type == "dynamic-tool" or (
            part_type.startswith("tool-") and part_type not in STREAM_TOOL_CHUNK_TYPES
        )
        if is_tool_part:
            if part.get("state") != "output-available":
                continue
            raw_tool_name = (
                part.get("toolName")
                if part_type == "dynamic-tool"
                else part.get("toolName") or part_type.removeprefix("tool-")
            )
            if not isinstance(raw_tool_name, str) or not raw_tool_name.strip():
                continue
            tool_name = raw_tool_name.strip()
            raw_call_id = part.get("toolCallId")
            tool_call_id = (
                raw_call_id.strip()
                if isinstance(raw_call_id, str) and raw_call_id.strip()
                else f"call_{msg_index}_{part_idx}"
            )
            raw_input = part.get("input")
            tool_args: dict[str, Any] = (
                dict(raw_input) if isinstance(raw_input, Mapping) else {}
            )
            output_str = _serialize_tool_output(part.get("output"))
            tool_pairs.append(
                (
                    ToolCall(name=tool_name, args=tool_args, id=tool_call_id),
                    ToolMessage(
                        content=output_str,
                        tool_call_id=tool_call_id,
                        name=tool_name,
                    ),
                )
            )

    if tool_pairs:
        _flush_step()
    elif text_buf:
        converted.append(AIMessage(content="".join(text_buf)))

    return converted


def convert_ui_messages(
    raw_messages: Sequence[Mapping[str, Any]],
) -> ConvertedConversation:
    """Validate message count/char caps and convert inbound UIMessage history to LangChain."""
    if not isinstance(raw_messages, Sequence) or isinstance(raw_messages, (str, bytes)):
        raise ValueError("messages must be a non-empty list")
    if len(raw_messages) < 1 or len(raw_messages) > MAX_MESSAGES:
        raise ValueError(f"messages length must be between 1 and {MAX_MESSAGES}")
    if contains_lone_surrogate(raw_messages):
        raise ValueError("messages must not contain unpaired UTF-16 surrogates")

    last_msg = raw_messages[-1]
    if not isinstance(last_msg, Mapping):
        raise ValueError("Each message must be a JSON object")
    if last_msg.get("role") != "user":
        raise ValueError("Newest message must have role 'user'")

    newest_segments = _extract_text_segments(last_msg)
    newest_raw_chars = sum(len(seg) for seg in newest_segments)
    newest_text = "".join(newest_segments)
    if len(newest_text.strip()) < 1:
        raise ValueError("Newest user message must contain non-empty text")
    if newest_raw_chars > MAX_USER_MESSAGE_CHARS:
        raise ValueError(
            f"Newest user message exceeds maximum length of {MAX_USER_MESSAGE_CHARS} characters"
        )

    langchain_messages: list[BaseMessage] = []
    for idx, msg in enumerate(raw_messages):
        if not isinstance(msg, Mapping):
            raise ValueError(f"Message at index {idx} must be a JSON object")
        role = msg.get("role")
        if not isinstance(role, str) or role not in VALID_ROLES:
            raise ValueError(f"Unsupported message role {role!r} at index {idx}")

        if role == "user":
            user_text = "".join(_extract_text_segments(msg))
            if user_text.strip():
                langchain_messages.append(HumanMessage(content=user_text))
        elif role == "system":
            sys_text = "".join(_extract_text_segments(msg))
            if sys_text.strip():
                langchain_messages.append(SystemMessage(content=sys_text))
        elif role == "assistant":
            langchain_messages.extend(_convert_assistant_message(msg, idx))

    if not langchain_messages or not isinstance(langchain_messages[-1], HumanMessage):
        raise ValueError("Conversation must end with a valid user message")

    return ConvertedConversation(
        langchain_messages=langchain_messages,
        latest_user_text=newest_text,
    )
