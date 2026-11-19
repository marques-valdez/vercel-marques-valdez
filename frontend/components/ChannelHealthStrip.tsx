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
import type {
  ChannelDelta,
  ChannelId,
  ChannelSummary,
  ChannelTrendSeries,
  DerivedTwinState,
} from '@/lib/types';
import { useAnimatedNumber } from '@/lib/use-animated-number';
import {
  BarRow,
  StackedShareBar,
  TrendSparkline,
  getChannelColorVar,
  resolveChannelTone,
} from './charts';

interface ChannelHealthStripProps {
  twinState: DerivedTwinState | null;
  errorText: string | null;
  deltas?: Record<string, ChannelDelta>;
  trends?: Partial<Record<ChannelId, ChannelTrendSeries>>;
  disabled?: boolean;
  onRetry: () => void;
  onReset: () => void;
  onInspectChannel?: (
    channelName: string,
    focus: 'overview' | 'broken_404' | 'utm_violation',
  ) => void;
  onOptimizePortfolio?: () => void;
}

function formatBudgetAmount(value: number): string {
  const hasFraction = Math.abs(value - Math.round(value)) >= 0.005;
  return value.toLocaleString('en-US', {
    minimumFractionDigits: hasFraction ? 2 : 0,
    maximumFractionDigits: 2,
  });
}

interface ChannelCardItemProps {
  channel: ChannelSummary;
  maxChannelRoas: number;
  delta?: ChannelDelta;
  trend?: ChannelTrendSeries;
  disabled?: boolean;
  onInspectChannel?: (
    channelName: string,
    focus: 'overview' | 'broken_404' | 'utm_violation',
  ) => void;
}

function ChannelCardItem({
  channel: ch,
  maxChannelRoas,
  delta,
  trend,
  disabled = false,
  onInspectChannel,
}: ChannelCardItemProps) {
  const tone = resolveChannelTone(ch.channelId || ch.channel);
  const colorVar = getChannelColorVar(ch.channelId || ch.channel);
  const animatedDailyBudget = useAnimatedNumber(ch.dailyBudget, 380);
  const animatedRoas = useAnimatedNumber(ch.roas, 380);
  const hasBudgetDelta = Boolean(
    delta && Math.abs(delta.dailyBudgetDelta) >= 0.01,
  );
  const hasHygieneDelta = Boolean(
    delta && (delta.brokenCreativesDelta !== 0 || delta.utmViolationsDelta !== 0),
  );
  const hasAnyDelta = hasBudgetDelta || hasHygieneDelta;

  return (
    <article
      className={`health-item health-channel-${tone}${hasAnyDelta ? ' health-item-changed health-item-flash' : ''}`}
      data-channel-id={ch.channelId}
    >
      <div className="health-item-header">
        {onInspectChannel ? (
          <button
            type="button"
            className="health-channel-trigger"
            disabled={disabled}
            onClick={() => onInspectChannel(ch.channel, 'overview')}
            aria-label={`Inspect ${ch.channel} performance and pacing`}
            title={`Ask agent about ${ch.channel}`}
          >
            <span className={`channel-dot channel-dot-${tone}`} aria-hidden="true" />
            <span className="health-channel-name">{ch.channel}</span>
          </button>
        ) : (
          <span className="health-channel-title">
            <span className={`channel-dot channel-dot-${tone}`} aria-hidden="true" />
            <span className="health-channel-name">{ch.channel}</span>
          </span>
        )}
        <span className="health-budget tabular-nums">
          {`$${formatBudgetAmount(animatedDailyBudget)}/day`}
        </span>
      </div>

      <BarRow
        label="ROAS"
        value={animatedRoas}
        maxValue={maxChannelRoas}
        valueText={`${animatedRoas.toFixed(2)}x ROAS`}
        color={colorVar}
        compact
        ariaLabel={`${ch.channel} ROAS ${ch.roas.toFixed(2)}x`}
      />

      {trend && trend.points.length > 0 ? (
        <TrendSparkline
          series={trend}
          color={colorVar}
          testId={`trend-sparkline-${ch.channelId}`}
        />
      ) : null}

      <div className="health-chip-row tabular-nums">
        {ch.brokenCreatives > 0 && onInspectChannel ? (
          <button
            type="button"
            className="health-chip health-chip-danger health-chip-btn"
            disabled={disabled}
            onClick={() => onInspectChannel(ch.channel, 'broken_404')}
            aria-label={`Inspect ${ch.brokenCreatives} broken links on ${ch.channel}`}
            title="Click to inspect broken landing pages"
          >
            {`${ch.brokenCreatives.toLocaleString('en-US')} broken links`}
          </button>
        ) : (
          <span
            className={
              ch.brokenCreatives > 0
                ? 'health-chip health-chip-danger'
                : 'health-chip health-chip-ok'
            }
          >
            {`${ch.brokenCreatives.toLocaleString('en-US')} broken links`}
          </span>
        )}
        {ch.utmViolations > 0 && onInspectChannel ? (
          <button
            type="button"
            className="health-chip health-chip-warn health-chip-btn"
            disabled={disabled}
            onClick={() => onInspectChannel(ch.channel, 'utm_violation')}
            aria-label={`Inspect ${ch.utmViolations} UTM issues on ${ch.channel}`}
            title="Click to inspect UTM tagging issues"
          >
            {`${ch.utmViolations.toLocaleString('en-US')} UTM issues`}
          </button>
        ) : (
          <span
            className={
              ch.utmViolations > 0
                ? 'health-chip health-chip-warn'
                : 'health-chip health-chip-ok'
            }
          >
            {`${ch.utmViolations.toLocaleString('en-US')} UTM issues`}
          </span>
        )}
      </div>

      {hasAnyDelta ? (
        <div className="health-delta-row tabular-nums">
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
}

export function ChannelHealthStrip({
  twinState,
  errorText,
  deltas,
  trends,
  disabled = false,
  onRetry,
  onReset,
  onInspectChannel,
  onOptimizePortfolio,
}: ChannelHealthStripProps) {
  const animatedTotalDaily = useAnimatedNumber(twinState?.totals.dailyBudget ?? 0, 380);
  const animatedTotalMonthly = useAnimatedNumber(twinState?.totals.monthlyBudget ?? 0, 380);
  const animatedBlendedRoas = useAnimatedNumber(twinState?.totals.blendedRoas ?? 0, 380);
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
  const monthlyK = Math.round(animatedTotalMonthly / 1000);
  const maxChannelRoas = Math.max(...channels.map((ch) => ch.roas), 1);

  return (
    <section
      className="health-strip"
      aria-label="Paid media channel summary"
      data-testid="channel-health-strip"
    >
      {channels.map((ch) => (
        <ChannelCardItem
          key={ch.channelId}
          channel={ch}
          maxChannelRoas={maxChannelRoas}
          delta={deltas?.[ch.channelId]}
          trend={trends?.[ch.channelId]}
          disabled={disabled}
          onInspectChannel={onInspectChannel}
        />
      ))}

      <article className="health-item health-item-totals" data-channel-id="dataset_totals">
        <div className="health-item-header">
          <span className="health-channel-name">All Paid Channels</span>
          <span className="health-budget tabular-nums">
            {`$${formatBudgetAmount(animatedTotalDaily)}/day`}
          </span>
        </div>
        <div className="health-metrics tabular-nums">
          <span className="health-roas-highlight">{`${animatedBlendedRoas.toFixed(2)}x blended ROAS`}</span>
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
        <div className="health-totals-footer">
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
          {onOptimizePortfolio ? (
            <button
              type="button"
              className="health-optimize-btn"
              disabled={disabled}
              onClick={onOptimizePortfolio}
              data-testid="optimize-mix-btn"
            >
              Optimize mix →
            </button>
          ) : null}
        </div>
      </article>
    </section>
  );
}
