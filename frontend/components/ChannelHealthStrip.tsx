'use client';

import React from 'react';
import type { ChannelDelta, DerivedTwinState } from '@/lib/types';

interface ChannelHealthStripProps {
  twinState: DerivedTwinState | null;
  errorText: string | null;
  deltas?: Record<string, ChannelDelta>;
  onRetry: () => void;
  onReset: () => void;
}

function formatBudgetAmount(value: number): string {
  const hasFraction = Math.abs(value - Math.round(value)) >= 0.005;
  return value.toLocaleString('en-US', {
    minimumFractionDigits: hasFraction ? 2 : 0,
    maximumFractionDigits: 2,
  });
}

export function ChannelHealthStrip({
  twinState,
  errorText,
  deltas,
  onRetry,
  onReset,
}: ChannelHealthStripProps) {
  if (errorText) {
    return (
      <section
        className="error-card"
        aria-label="Channel health error"
        role="alert"
      >
        <div className="error-card-row">
          <div>
            <strong className="error-card-title">Unable to load Digital Twin state</strong>
            <p className="error-card-body">{errorText}</p>
          </div>
          <div className="card-actions-inline">
            <button type="button" className="btn btn-secondary" onClick={onRetry}>
              Retry
            </button>
            <button type="button" className="btn btn-secondary" onClick={onReset}>
              Reset demo
            </button>
          </div>
        </div>
      </section>
    );
  }

  if (!twinState) {
    return (
      <section
        className="health-strip"
        aria-label="Channel health loading"
        data-testid="channel-health-strip"
      >
        {['channel-a', 'channel-b', 'channel-c', 'totals'].map((slot) => (
          <div key={slot} className="health-item skeleton-card">
            <div className="skeleton-line skeleton-short" />
            <div className="skeleton-line skeleton-medium" />
            <div className="skeleton-line skeleton-wide" />
          </div>
        ))}
      </section>
    );
  }

  const { channels, totals } = twinState;
  const monthlyK = Math.round(totals.monthlyBudget / 1000);

  return (
    <section
      className="health-strip"
      aria-label="Channel health summary"
      data-testid="channel-health-strip"
    >
      {channels.map((ch) => {
        const hasIssues = ch.brokenCreatives > 0 || ch.utmViolations > 0;
        const delta = deltas?.[ch.channelId];
        const hasBudgetDelta = Boolean(
          delta && Math.abs(delta.dailyBudgetDelta) >= 0.01,
        );
        const hasHygieneDelta = Boolean(
          delta &&
            (delta.brokenCreativesDelta !== 0 || delta.utmViolationsDelta !== 0),
        );
        return (
          <article
            key={ch.channelId}
            className={`health-item${hasBudgetDelta || hasHygieneDelta ? ' health-item-changed' : ''}`}
            data-channel-id={ch.channelId}
          >
            <div className="health-item-header">
              <span className="health-channel-name">{ch.channel}</span>
              <span className="health-budget tabular-nums">
                {`$${formatBudgetAmount(ch.dailyBudget)}/day`}
              </span>
            </div>
            <div className="health-metrics tabular-nums">
              <span>{`${ch.campaignCount.toLocaleString('en-US')} campaigns`}</span>
              <span aria-hidden="true">·</span>
              <span className={ch.brokenCreatives > 0 ? 'status-text-danger' : 'status-text-ok'}>
                {`${ch.brokenCreatives.toLocaleString('en-US')} broken URLs`}
              </span>
              <span aria-hidden="true">·</span>
              <span className={hasIssues && ch.utmViolations > 0 ? 'status-text-warn' : 'status-text-ok'}>
                {`${ch.utmViolations.toLocaleString('en-US')} UTM issues`}
              </span>
            </div>
            {hasBudgetDelta || hasHygieneDelta ? (
              <div
                className="health-delta-row tabular-nums mono-text"
                data-testid={`channel-delta-${ch.channelId}`}
              >
                {hasBudgetDelta && delta ? (
                  <span
                    className={
                      delta.dailyBudgetDelta > 0
                        ? 'delta-pill delta-pill-positive'
                        : 'delta-pill delta-pill-negative'
                    }
                  >
                    {`${delta.dailyBudgetDelta > 0 ? '+' : '-'}$${formatBudgetAmount(Math.abs(delta.dailyBudgetDelta))}/day`}
                  </span>
                ) : null}
                {delta && delta.brokenCreativesDelta < 0 ? (
                  <span className="delta-pill delta-pill-positive">
                    URLs remediated
                  </span>
                ) : null}
                {delta && delta.utmViolationsDelta < 0 ? (
                  <span className="delta-pill delta-pill-positive">
                    UTMs normalized
                  </span>
                ) : null}
              </div>
            ) : null}
          </article>
        );
      })}

      <article className="health-item" data-channel-id="dataset_totals">
        <div className="health-item-header">
          <span className="health-channel-name">Performance dataset</span>
          <span className="health-budget tabular-nums">
            {`$${formatBudgetAmount(totals.dailyBudget)}/day`}
          </span>
        </div>
        <div className="health-metrics tabular-nums">
          <span>{`${totals.rowCount.toLocaleString('en-US')} daily rows`}</span>
          <span aria-hidden="true">·</span>
          <span>{`about $${monthlyK.toLocaleString('en-US')}K per month`}</span>
        </div>
      </article>
    </section>
  );
}
