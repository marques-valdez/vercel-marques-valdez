'use client';

/**
 * Live Digital Twin KPI strip across paid channels.
 *
 * Renders server-recomputed budgets, broken landing page counts, and UTM
 * tracking gaps from `POST /api/agent/twin/state`. Highlights live session
 * deltas (budget shifts and remediated issues) immediately after the user
 * approves a reallocation or applies a 1-click hygiene fix.
 */

import React from 'react';
import type { ChannelDelta, DerivedTwinState } from '@/lib/types';
import {
  BarRow,
  StackedShareBar,
  getChannelColorVar,
  resolveChannelTone,
} from './charts';

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
        aria-label="Channel summary error"
        role="alert"
      >
        <div className="error-card-row">
          <div>
            <strong className="error-card-title">Unable to load campaign summary</strong>
            <p className="error-card-body">{errorText}</p>
          </div>
          <div className="card-actions-inline">
            <button type="button" className="btn btn-secondary" onClick={onRetry}>
              Retry
            </button>
            <button type="button" className="btn btn-secondary" onClick={onReset}>
              Reset workspace
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
        aria-label="Channel summary loading"
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
  const maxChannelRoas = Math.max(...channels.map((ch) => ch.roas), 1);

  return (
    <section
      className="health-strip"
      aria-label="Paid media channel summary"
      data-testid="channel-health-strip"
    >
      {channels.map((ch) => {
        const tone = resolveChannelTone(ch.channelId || ch.channel);
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
            className={`health-item health-channel-${tone}${hasBudgetDelta || hasHygieneDelta ? ' health-item-changed' : ''}`}
            data-channel-id={ch.channelId}
          >
            <div className="health-item-header">
              <span className="health-channel-title">
                <span
                  className={`channel-dot channel-dot-${tone}`}
                  aria-hidden="true"
                />
                <span className="health-channel-name">{ch.channel}</span>
              </span>
              <span className="health-budget tabular-nums">
                {`$${formatBudgetAmount(ch.dailyBudget)}/day`}
              </span>
            </div>

            <BarRow
              label="ROAS"
              value={ch.roas}
              maxValue={maxChannelRoas}
              valueText={`${ch.roas.toFixed(2)}x ROAS`}
              color={getChannelColorVar(ch.channelId || ch.channel)}
              compact
              ariaLabel={`${ch.channel} ROAS ${ch.roas.toFixed(2)}x`}
            />

            <div className="health-chip-row tabular-nums">
              <span
                className={
                  ch.brokenCreatives > 0
                    ? 'health-chip health-chip-danger'
                    : 'health-chip health-chip-ok'
                }
              >
                {`${ch.brokenCreatives.toLocaleString('en-US')} broken links`}
              </span>
              <span
                className={
                  ch.utmViolations > 0
                    ? 'health-chip health-chip-warn'
                    : 'health-chip health-chip-ok'
                }
              >
                {`${ch.utmViolations.toLocaleString('en-US')} UTM issues`}
              </span>
            </div>
            {hasBudgetDelta || hasHygieneDelta ? (
              <div
                className="health-delta-row tabular-nums"
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
                    Broken ads paused
                  </span>
                ) : null}
                {delta && delta.utmViolationsDelta < 0 ? (
                  <span className="delta-pill delta-pill-positive">
                    UTMs fixed
                  </span>
                ) : null}
              </div>
            ) : null}
          </article>
        );
      })}

      <article className="health-item health-item-totals" data-channel-id="dataset_totals">
        <div className="health-item-header">
          <span className="health-channel-name">All Paid Channels</span>
          <span className="health-budget tabular-nums">
            {`$${formatBudgetAmount(totals.dailyBudget)}/day`}
          </span>
        </div>
        <div className="health-metrics tabular-nums">
          <span className="health-roas-highlight">{`${totals.blendedRoas.toFixed(2)}x blended ROAS`}</span>
          <span aria-hidden="true">·</span>
          <span>{`~$${monthlyK.toLocaleString('en-US')}K/mo budget`}</span>
        </div>
        <StackedShareBar
          compact
          showLegend={false}
          segments={channels.map((ch) => ({
            id: ch.channelId,
            label: ch.channel,
            value: ch.dailyBudget,
            valueText: `$${formatBudgetAmount(ch.dailyBudget)}/day`,
            color: getChannelColorVar(ch.channelId || ch.channel),
          }))}
          ariaLabel={`Daily budget split across ${channels.length} channels`}
          testId="channel-budget-share-bar"
        />
        <div className="health-share-caption tabular-nums">
          {channels.map((ch) => {
            const sharePct =
              totals.dailyBudget > 0
                ? Math.round((ch.dailyBudget / totals.dailyBudget) * 100)
                : 0;
            const tone = resolveChannelTone(ch.channelId || ch.channel);
            return (
              <span key={ch.channelId} className="health-share-item">
                <span
                  className={`channel-dot channel-dot-${tone}`}
                  aria-hidden="true"
                />
                <span>{`${ch.channel.replace(' Ads', '')} ${sharePct}%`}</span>
              </span>
            );
          })}
        </div>
      </article>
    </section>
  );
}
