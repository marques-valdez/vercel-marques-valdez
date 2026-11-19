'use client';

/**
 * Floating chat input composer with UTF-16 surrogate sanitization and bounded length.
 *
 * `sanitizeComposerInput()` strips lone UTF-16 surrogates before slicing to
 * `MAX_INPUT_CHARS` (2,000) so emoji boundaries never produce invalid JSON
 * that the FastAPI boundary rejects. Styled as a centered floating card with a
 * circular send button and focus glow; in default mode shows connected ad
 * channels and in `architectMode` shows a live pre-send AI Gateway tier preview.
 */

import React, { useEffect, useRef, useState } from 'react';
import { previewGatewayRoute } from '@/lib/gateway-preview';
import type { HealthStatus } from '@/lib/types';

export const MAX_INPUT_CHARS = 2000;
const COUNTER_REVEAL_THRESHOLD = 1500;

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
  architectMode?: boolean;
  hasConversation?: boolean;
  onChange: (nextValue: string) => void;
  onSubmit: () => void;
  onStop: () => void;
}

export function Composer({
  value,
  isStreaming,
  primedTierHint = null,
  health = null,
  injectFailure = false,
  architectMode = false,
  hasConversation = false,
  onChange,
  onSubmit,
  onStop,
}: ComposerProps) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [hasFocusedOnce, setHasFocusedOnce] = useState(false);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) {
      return;
    }
    el.style.height = 'auto';
    const maxHeightPx = 160;
    const nextHeight = Math.min(el.scrollHeight, maxHeightPx);
    el.style.height = `${Math.max(56, nextHeight)}px`;
  }, [value]);

  const trimmedLength = value.trim().length;
  const canSend = !isStreaming && trimmedLength > 0 && value.length <= MAX_INPUT_CHARS;
  const showIdlePulse = !hasConversation && !hasFocusedOnce && !isStreaming && trimmedLength === 0;
  const showCounter = value.length >= COUNTER_REVEAL_THRESHOLD;

  const routePreview = architectMode
    ? previewGatewayRoute(value, primedTierHint, health)
    : null;
  const routeReason = routePreview
    ? routePreview.routedBy === 'card'
      ? 'card hint'
      : routePreview.matchedKeyword
        ? `keyword "${routePreview.matchedKeyword}"`
        : 'default fast'
    : '';

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
      <form
        className={`composer-form${showIdlePulse ? ' composer-form-idle' : ''}`}
        onSubmit={handleFormSubmit}
        data-testid="composer-form"
      >
        <div className="composer-input-row">
          <span className="composer-leading-icon" aria-hidden="true">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
              <path
                d="M12 3L14.2 8.8L20 11L14.2 13.2L12 19L9.8 13.2L4 11L9.8 8.8L12 3Z"
                fill="currentColor"
              />
            </svg>
          </span>

          <label htmlFor="relay-composer-input" className="sr-only">
            Ask Relay about your campaigns
          </label>
          <textarea
            ref={textareaRef}
            id="relay-composer-input"
            className="composer-textarea"
            rows={1}
            maxLength={MAX_INPUT_CHARS}
            disabled={isStreaming}
            value={value}
            onFocus={() => setHasFocusedOnce(true)}
            onChange={(e) =>
              onChange(sanitizeComposerInput(e.target.value, MAX_INPUT_CHARS))
            }
            onKeyDown={handleKeyDown}
            placeholder="Ask Relay about your campaigns…"
          />

          <div className="composer-action-slot">
            {isStreaming ? (
              <button
                type="button"
                className="composer-stop-btn"
                aria-label="Stop generating"
                data-testid="composer-stop-button"
                onClick={onStop}
              >
                Stop
              </button>
            ) : (
              <button
                type="submit"
                className={`composer-send-btn${canSend ? ' composer-send-btn-ready' : ''}`}
                disabled={!canSend}
                aria-label="Send message"
                data-testid="composer-send-button"
              >
                <svg
                  width="18"
                  height="18"
                  viewBox="0 0 20 20"
                  fill="none"
                  aria-hidden="true"
                >
                  <path
                    d="M10 15.5V4.5M10 4.5L5.5 9M10 4.5L14.5 9"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
                <span className="sr-only">Send</span>
              </button>
            )}
          </div>
        </div>

        <div className="composer-controls">
          <div className="composer-meta-group">
            {architectMode && routePreview ? (
              <span
                className="composer-route-preview mono-text tabular-nums"
                data-testid="composer-route-preview"
              >
                <span
                  className={
                    routePreview.tier === 'reasoning'
                      ? 'arch-dot arch-dot-amber'
                      : 'arch-dot arch-dot-blue'
                  }
                  aria-hidden="true"
                />
                <span>
                  {`AI Gateway -> ${routePreview.tier.toUpperCase()} (${routeReason}) · ${routePreview.primaryModel}`}
                </span>
                {routePreview.fallbackModels.length > 0 ? (
                  <span className="composer-route-muted">
                    {` +${routePreview.fallbackModels.length} fallback`}
                  </span>
                ) : null}
                {injectFailure ? (
                  <span className="composer-route-armed"> · 503 armed</span>
                ) : null}
              </span>
            ) : (
              <span className="composer-route-preview">
                <span className="composer-channel-dots" aria-hidden="true">
                  <span className="channel-dot channel-dot-google" />
                  <span className="channel-dot channel-dot-linkedin" />
                  <span className="channel-dot channel-dot-meta" />
                </span>
                <span>Google Ads · LinkedIn Ads · Meta Ads</span>
              </span>
            )}
          </div>

          <div className="composer-hints-right">
            {showCounter ? (
              <span
                className={`composer-counter tabular-nums${
                  value.length >= MAX_INPUT_CHARS
                    ? ' composer-counter-danger'
                    : value.length >= 1850
                      ? ' composer-counter-warn'
                      : ''
                }`}
                aria-live="polite"
                data-testid="composer-counter"
              >
                {value.length.toLocaleString('en-US')} / 2,000
              </span>
            ) : null}
            <span className="composer-kbd-hint">
              Enter to send · Shift+Enter for new line
            </span>
          </div>
        </div>
      </form>
    </div>
  );
}
