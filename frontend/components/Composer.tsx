'use client';

import React, { useEffect, useRef } from 'react';
import type { HealthStatus } from '@/lib/types';

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
  primedTierHint?: 'fast' | 'reasoning' | null;
  health?: HealthStatus | null;
  injectFailure?: boolean;
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
          Ask Relay about paid campaigns, landing page links, UTM tracking, ROAS, budget shifts, or recurring checks
        </label>
        <textarea
          ref={textareaRef}
          id="relay-composer-input"
          className="composer-textarea"
          rows={1}
          maxLength={MAX_INPUT_CHARS}
          disabled={isStreaming}
          value={value}
          onChange={(e) =>
            onChange(sanitizeComposerInput(e.target.value, MAX_INPUT_CHARS))
          }
          onKeyDown={handleKeyDown}
          placeholder="Ask about broken landing pages, UTM tracking, channel ROAS, budget shifts, or daily checks…"
        />
        <div className="composer-controls">
          <div className="composer-meta-group">
            <span className="composer-route-preview">
              Google Ads · LinkedIn Ads · Meta Ads
            </span>
            <span className="composer-counter tabular-nums" aria-live="polite">
              {value.length.toLocaleString('en-US')} / 2,000
            </span>
          </div>
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
