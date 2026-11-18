'use client';

import React, { useEffect, useRef } from 'react';

export const MAX_INPUT_CHARS = 2000;

export function sanitizeComposerInput(
  raw: string,
  maxChars: number = MAX_INPUT_CHARS,
): string {
  const sliced = raw.length > maxChars ? raw.slice(0, maxChars) : raw;
  let out = '';
  for (let i = 0; i < sliced.length; i += 1) {
    const code = sliced.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = sliced.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        out += sliced[i] + sliced[i + 1];
        i += 1;
      }
    } else if (!(code >= 0xdc00 && code <= 0xdfff)) {
      out += sliced[i];
    }
  }
  return out;
}

interface ComposerProps {
  value: string;
  isStreaming: boolean;
  onChange: (nextValue: string) => void;
  onSubmit: () => void;
  onStop: () => void;
}

export function Composer({
  value,
  isStreaming,
  onChange,
  onSubmit,
  onStop,
}: ComposerProps) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) {
      return;
    }
    el.style.height = 'auto';
    const maxHeightPx = 96;
    const nextHeight = Math.min(el.scrollHeight, maxHeightPx);
    el.style.height = `${Math.max(40, nextHeight)}px`;
  }, [value]);

  const trimmedLength = value.trim().length;
  const canSend = !isStreaming && trimmedLength > 0 && value.length <= MAX_INPUT_CHARS;

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (
      event.key === 'Enter' &&
      !event.shiftKey &&
      !event.nativeEvent.isComposing
    ) {
      event.preventDefault();
      if (canSend) {
        onSubmit();
      }
    }
  };

  const handleFormSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (canSend) {
      onSubmit();
    }
  };

  return (
    <div className="composer-shell">
      <form className="composer-form" onSubmit={handleFormSubmit}>
        <label htmlFor="relay-composer-input" className="sr-only">
          Ask Relay to audit campaigns, run SQL in Sandbox, propose a budget shift, or compile a workflow
        </label>
        <textarea
          ref={textareaRef}
          id="relay-composer-input"
          className="composer-textarea"
          rows={1}
          maxLength={MAX_INPUT_CHARS}
          disabled={isStreaming}
          value={value}
          onChange={(e) => onChange(sanitizeComposerInput(e.target.value, MAX_INPUT_CHARS))}
          onKeyDown={handleKeyDown}
          placeholder="Ask Relay about creative 404s, UTM tags, channel return on ad spend, budget shifts, or daily guardrails…"
        />
        <div className="composer-controls">
          <span className="composer-counter tabular-nums" aria-live="polite">
            {value.length.toLocaleString('en-US')} / 2,000
          </span>
          <div className="composer-buttons">
            {isStreaming ? (
              <button
                type="button"
                className="btn btn-secondary"
                onClick={onStop}
              >
                Stop
              </button>
            ) : null}
            <button
              type="submit"
              className="btn btn-primary"
              disabled={!canSend}
            >
              Send
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}
