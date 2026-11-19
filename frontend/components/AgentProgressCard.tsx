'use client';

/**
 * Live step-checklist and elapsed-timer progress card for assistant turns.
 *
 * Driven by reconciled Vercel AI SDK 7 `data-agent-status` parts (`id:
 * "turn-progress"`): expands automatically while streaming to display live
 * `in_progress` (animated 4-dot spinner), `pending` (hollow ring), `done`
 * (green check), and `failed` (red mark) steps, then collapses into a 1-line
 * clickable summary footer with frozen elapsed time once the turn settles.
 */

import React, { useEffect, useRef, useState } from 'react';
import type { AgentProgressStep } from '@/lib/types';

export const OPTIMISTIC_SUBMIT_STEPS: AgentProgressStep[] = [
  {
    id: 'plan',
    title: 'Review request & live campaigns',
    status: 'in_progress',
  },
  {
    id: 'synthesize',
    title: 'Summarize findings & next steps',
    status: 'pending',
  },
];

export function finalizeProgressSteps(
  steps: ReadonlyArray<AgentProgressStep>,
  isStreaming: boolean,
  hasError: boolean = false,
): AgentProgressStep[] {
  if (isStreaming) {
    return steps.map((step) => ({ ...step }));
  }
  return steps.map((step) => {
    if (step.status === 'failed') {
      return { ...step };
    }
    if (hasError && step.status === 'in_progress') {
      return { ...step, status: 'failed' };
    }
    if (!hasError && (step.status === 'in_progress' || step.status === 'pending')) {
      return { ...step, status: 'done' };
    }
    return { ...step };
  });
}

export function formatElapsedSeconds(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) {
    return '0s';
  }
  const whole = Math.floor(totalSeconds);
  if (whole < 60) {
    return `${whole}s`;
  }
  const mins = Math.floor(whole / 60);
  const secs = whole % 60;
  return `${mins}m ${String(secs).padStart(2, '0')}s`;
}

export function splitFocusHeadline(text: string): { lead: string; rest: string } {
  const clean = text.trim().replace(/…+$/, '');
  const spaceIdx = clean.indexOf(' ');
  if (spaceIdx === -1) {
    return { lead: clean, rest: '' };
  }
  return {
    lead: clean.slice(0, spaceIdx),
    rest: clean.slice(spaceIdx),
  };
}

export interface AgentProgressCardProps {
  steps: AgentProgressStep[];
  focus: string;
  isStreaming: boolean;
  hasError?: boolean;
  startedAtMs?: number | null;
  completedDurationMs?: number | null;
  testId?: string;
}

export function AgentProgressCard({
  steps,
  focus,
  isStreaming,
  hasError = false,
  startedAtMs = null,
  completedDurationMs = null,
  testId = 'agent-activity-status',
}: AgentProgressCardProps) {
  const [userExpandedOverride, setUserExpandedOverride] = useState<boolean | null>(
    null,
  );
  const localStartRef = useRef<number>(startedAtMs ?? Date.now());
  const [elapsedSec, setElapsedSec] = useState<number>(() => {
    if (!isStreaming && typeof completedDurationMs === 'number' && completedDurationMs > 0) {
      return Math.max(1, Math.round(completedDurationMs / 1000));
    }
    if (startedAtMs) {
      return Math.max(0, Math.floor((Date.now() - startedAtMs) / 1000));
    }
    return 0;
  });

  useEffect(() => {
    if (startedAtMs) {
      localStartRef.current = startedAtMs;
    }
  }, [startedAtMs]);

  useEffect(() => {
    if (!isStreaming) {
      if (typeof completedDurationMs === 'number' && completedDurationMs > 0) {
        setElapsedSec(Math.max(1, Math.round(completedDurationMs / 1000)));
      } else {
        setElapsedSec((prev) =>
          prev > 0
            ? prev
            : Math.max(1, Math.round((Date.now() - localStartRef.current) / 1000)),
        );
      }
      return;
    }

    const tick = () => {
      const origin = startedAtMs ?? localStartRef.current;
      setElapsedSec(Math.max(0, Math.floor((Date.now() - origin) / 1000)));
    };
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [isStreaming, startedAtMs, completedDurationMs]);

  const effectiveSteps = finalizeProgressSteps(
    steps.length > 0 ? steps : OPTIMISTIC_SUBMIT_STEPS,
    isStreaming,
    hasError,
  );

  const expanded =
    userExpandedOverride !== null ? userExpandedOverride : isStreaming;

  const doneCount = effectiveSteps.filter((s) => s.status === 'done').length;
  const failedCount = effectiveSteps.filter((s) => s.status === 'failed').length;

  const footerText = isStreaming
    ? focus || 'Reviewing your active campaigns'
    : failedCount > 0
      ? `Completed ${doneCount} of ${effectiveSteps.length} steps (${failedCount} failed)`
      : `Completed ${effectiveSteps.length} ${effectiveSteps.length === 1 ? 'step' : 'steps'}`;

  const { lead, rest } = splitFocusHeadline(footerText);
  const showElapsed = isStreaming || elapsedSec > 0;

  return (
    <div
      className={`agent-progress-wrap${isStreaming ? ' agent-progress-live' : ''}`}
      data-testid={testId}
      aria-live={isStreaming ? 'polite' : undefined}
    >
      {expanded ? (
        <ol
          className="agent-progress-card"
          aria-label="Relay progress checklist"
          data-testid="agent-progress-steps"
        >
          {effectiveSteps.map((step) => (
            <li
              key={step.id}
              className={`agent-step-row agent-step-${step.status}`}
              data-step-status={step.status}
            >
              <span className="agent-step-icon" aria-hidden="true">
                {step.status === 'in_progress' ? (
                  <span className="agent-dots-spinner">
                    <span className="agent-dot-cell" />
                    <span className="agent-dot-cell" />
                    <span className="agent-dot-cell" />
                    <span className="agent-dot-cell" />
                  </span>
                ) : step.status === 'done' ? (
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                    <circle cx="8" cy="8" r="7" fill="#EFFAF1" stroke="#0E8A16" strokeWidth="1.4" />
                    <path
                      d="M5 8.1L7.1 10.2L11.2 5.9"
                      stroke="#0E8A16"
                      strokeWidth="1.6"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                ) : step.status === 'failed' ? (
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                    <circle cx="8" cy="8" r="7" fill="#FEF2F2" stroke="#E5484D" strokeWidth="1.4" />
                    <path
                      d="M5.6 5.6L10.4 10.4M10.4 5.6L5.6 10.4"
                      stroke="#E5484D"
                      strokeWidth="1.6"
                      strokeLinecap="round"
                    />
                  </svg>
                ) : (
                  <span className="agent-step-circle" />
                )}
              </span>
              <span className="agent-step-title">{step.title}</span>
            </li>
          ))}
        </ol>
      ) : null}

      <button
        type="button"
        className="agent-progress-toggle"
        aria-expanded={expanded}
        onClick={() => setUserExpandedOverride(!expanded)}
        data-testid="agent-progress-toggle"
      >
        <span className="agent-progress-focus">
          <strong className="agent-progress-lead">{lead}</strong>
          {rest ? <span className="agent-progress-rest">{rest}</span> : null}
        </span>
        {showElapsed ? (
          <span
            className="agent-progress-elapsed tabular-nums"
            data-testid="agent-progress-elapsed"
          >
            {formatElapsedSeconds(elapsedSec)}
          </span>
        ) : null}
        <svg
          className={`agent-progress-chevron${expanded ? ' agent-progress-chevron-open' : ''}`}
          width="14"
          height="14"
          viewBox="0 0 16 16"
          fill="none"
          aria-hidden="true"
        >
          <path
            d="M6 3.5L10.5 8L6 12.5"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
    </div>
  );
}
