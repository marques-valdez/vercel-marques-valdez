'use client';

/**
 * Reusable Geist-styled backend error and warning alert card.
 *
 * Translates FastAPI HTTP errors (422, 429, 500, 502, 503, 504), interrupted
 * SSE streams, unanswered chat turns, and background Neon Postgres sync
 * failures into plain-English alerts with 1-click Retry and Dismiss controls.
 * Surfaces exact technical status details only when Architect X-Ray is enabled.
 */

import React from 'react';
import type { BackendAlert } from '@/lib/types';

export function buildHttpErrorAlert(
  status: number,
  rawBodyText: string,
): BackendAlert {
  let detailMessage = '';
  const trimmed = rawBodyText.trim();
  if (trimmed) {
    try {
      const parsed = JSON.parse(trimmed) as { detail?: unknown; error?: unknown };
      if (typeof parsed.detail === 'string' && parsed.detail.trim()) {
        detailMessage = parsed.detail.trim();
      } else if (Array.isArray(parsed.detail) && parsed.detail.length > 0) {
        const first = parsed.detail[0] as { msg?: unknown };
        if (typeof first?.msg === 'string' && first.msg.trim()) {
          detailMessage = first.msg.trim();
        }
      } else if (typeof parsed.error === 'string' && parsed.error.trim()) {
        detailMessage = parsed.error.trim();
      }
    } catch {
      // Non-JSON response (e.g. HTML 504 gateway timeout page)
    }
  }

  const id = `http-${status}-${Date.now()}`;
  const technicalDetail = detailMessage
    ? `HTTP ${status}: ${detailMessage}`
    : `HTTP ${status}`;

  if (status === 429) {
    return {
      id,
      severity: 'warning',
      title: 'RATE LIMIT REACHED',
      message:
        'Too many requests in a short window. Wait a few seconds and click Retry.',
      technicalDetail,
      retryable: true,
    };
  }
  if (status === 422) {
    return {
      id,
      severity: 'error',
      title: 'REQUEST COULD NOT BE PROCESSED',
      message:
        detailMessage ||
        'The backend rejected the request payload. Adjust your prompt or click Retry.',
      technicalDetail,
      retryable: true,
    };
  }
  if (status === 504 || status === 502 || status === 503) {
    return {
      id,
      severity: 'error',
      title: 'SERVICE TEMPORARILY UNAVAILABLE',
      message:
        'The campaign assistant timed out or lost connection to the model gateway. Click Retry to run it again.',
      technicalDetail,
      retryable: true,
    };
  }
  return {
    id,
    severity: 'error',
    title: 'BACKEND PROCESSING ERROR',
    message:
      detailMessage ||
      'Something went wrong while processing your request on the backend. Click Retry to try again.',
    technicalDetail,
    retryable: true,
  };
}

interface BackendAlertBannerProps {
  alert: BackendAlert;
  architectMode?: boolean;
  onRetry?: () => void;
  onDismiss?: () => void;
  testId?: string;
}

export function BackendAlertBanner({
  alert,
  architectMode = false,
  onRetry,
  onDismiss,
  testId = 'backend-alert-banner',
}: BackendAlertBannerProps) {
  const isWarning = alert.severity === 'warning';
  return (
    <section
      className={isWarning ? 'error-card backend-alert-warning' : 'error-card'}
      role="alert"
      aria-live={isWarning ? 'polite' : 'assertive'}
      data-testid={testId}
    >
      <div className="error-card-row">
        <div>
          <div
            className={
              isWarning
                ? 'tool-card-eyebrow warning-eyebrow'
                : 'tool-card-eyebrow error-eyebrow'
            }
          >
            {alert.title}
          </div>
          <p className="error-card-body">{alert.message}</p>
          {architectMode && alert.technicalDetail ? (
            <p className="backend-alert-tech mono-text">{alert.technicalDetail}</p>
          ) : null}
        </div>
        <div className="card-actions-inline">
          {alert.retryable && onRetry ? (
            <button
              type="button"
              className="btn btn-secondary"
              onClick={onRetry}
              data-testid="backend-alert-retry-button"
            >
              Retry
            </button>
          ) : null}
          {onDismiss ? (
            <button
              type="button"
              className="btn btn-secondary"
              onClick={onDismiss}
              aria-label="Dismiss alert"
              data-testid="backend-alert-dismiss-button"
            >
              Dismiss
            </button>
          ) : null}
        </div>
      </div>
    </section>
  );
}
