'use client';

/**
 * Actionable "Recommended Next Steps" resolution panel for workflows.
 *
 * Shared by both `WorkflowCard` (inline chat) and `WorkflowsDrawer` (Saved
 * Campaign Workflows flyout) so recurring check results never dead-end on a
 * plain text brief. Surfaces contextual deep-dive and budget-shift action
 * pills that route marketers directly into the chat agent for line-by-line
 * hygiene inspection or human-approved budget reallocation with Monte Carlo
 * forecasting.
 */

import React from 'react';
import { CHANNEL_LABELS } from '@/lib/playbooks';
import type {
  ChannelId,
  DerivedTwinState,
  WorkflowChannelRoasRef,
  WorkflowDigestSummary,
} from '@/lib/types';

interface WorkflowNextStepsProps {
  channels: ChannelId[];
  digestSummary?: WorkflowDigestSummary | null;
  twinState?: DerivedTwinState | null;
  disabled?: boolean;
  compact?: boolean;
  onRunPrompt: (prompt: string, tierHint: 'fast' | 'reasoning') => void;
}

function deriveSummaryFromTwin(
  channels: ChannelId[],
  twinState: DerivedTwinState,
): WorkflowDigestSummary {
  const scopeSet = new Set(channels);
  const scoped =
    scopeSet.size > 0
      ? twinState.channels.filter((ch) => scopeSet.has(ch.channelId))
      : twinState.channels;
  const activeChannels = scoped.length > 0 ? scoped : twinState.channels;

  const brokenCreatives = activeChannels.reduce(
    (sum, ch) => sum + ch.brokenCreatives,
    0,
  );
  const utmViolations = activeChannels.reduce(
    (sum, ch) => sum + ch.utmViolations,
    0,
  );
  const spendAtRiskPerDay = Number(
    activeChannels.reduce((sum, ch) => sum + ch.spendAtRiskPerDay, 0).toFixed(2),
  );

  let lowestRoasChannel: WorkflowChannelRoasRef | null = null;
  let highestRoasChannel: WorkflowChannelRoasRef | null = null;
  if (activeChannels.length >= 2) {
    const sorted = [...activeChannels].sort((a, b) => a.roas - b.roas);
    const low = sorted[0];
    const high = sorted[sorted.length - 1];
    lowestRoasChannel = {
      channel: low.channel,
      channelId: low.channelId,
      roas: low.roas,
    };
    highestRoasChannel = {
      channel: high.channel,
      channelId: high.channelId,
      roas: high.roas,
    };
  }

  return {
    brokenCreatives,
    utmViolations,
    spendAtRiskPerDay,
    blendedRoas: twinState.totals.blendedRoas,
    lowestRoasChannel,
    highestRoasChannel,
  };
}

export function WorkflowNextSteps({
  channels,
  digestSummary = null,
  twinState = null,
  disabled = false,
  compact = false,
  onRunPrompt,
}: WorkflowNextStepsProps) {
  const resolved =
    digestSummary ?? (twinState ? deriveSummaryFromTwin(channels, twinState) : null);

  if (!resolved) {
    return null;
  }

  const broken = Math.max(0, Number(resolved.brokenCreatives || 0));
  const utms = Math.max(0, Number(resolved.utmViolations || 0));
  const spendAtRisk = Math.max(0, Number(resolved.spendAtRiskPerDay || 0));
  const hasHygieneIssues = broken > 0 || utms > 0;

  const lowCh = resolved.lowestRoasChannel ?? null;
  const highCh = resolved.highestRoasChannel ?? null;
  const hasRoasSpread = Boolean(
    lowCh && highCh && lowCh.channelId !== highCh.channelId && highCh.roas > lowCh.roas,
  );

  const channelListText =
    channels.length > 0
      ? channels.map((c) => CHANNEL_LABELS[c] ?? c).join(', ')
      : 'all active channels';

  const hygienePillLabel =
    broken > 0 && utms > 0
      ? `Inspect & fix ${broken.toLocaleString('en-US')} broken links & ${utms.toLocaleString('en-US')} UTM tags`
      : broken > 0
        ? `Inspect & pause ${broken.toLocaleString('en-US')} broken ad links`
        : `Inspect & fix ${utms.toLocaleString('en-US')} UTM tracking tags`;

  const hygienePrompt = `Audit active campaigns across ${channelListText} for broken 404 landing pages and UTM tracking issues, ranked by daily spend at risk, so I can review and fix them.`;

  const budgetShiftLabel =
    hasRoasSpread && lowCh && highCh
      ? `Shift spend from ${lowCh.channel} (${lowCh.roas.toFixed(2)}x) to ${highCh.channel} (${highCh.roas.toFixed(2)}x)`
      : null;

  const budgetShiftPrompt =
    hasRoasSpread && lowCh && highCh
      ? `Propose a budget shift from ${lowCh.channel} (${lowCh.roas.toFixed(2)}x ROAS) to ${highCh.channel} (${highCh.roas.toFixed(2)}x ROAS) with a 30-day pipeline forecast.`
      : '';

  const roasBreakdownPrompt = `Compare trailing spend, attributed pipeline, and ROAS across ${channelListText} and highlight underperforming campaigns.`;

  const riskFormatted = spendAtRisk.toLocaleString('en-US', {
    minimumFractionDigits: spendAtRisk % 1 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  });

  return (
    <div
      className={`workflow-next-steps${compact ? ' workflow-next-steps-compact' : ''}`}
      data-testid="workflow-next-steps"
      aria-label="Recommended next steps"
    >
      <div className="workflow-next-steps-header">
        <span className="workflow-next-steps-eyebrow">RECOMMENDED NEXT STEPS</span>
        {hasHygieneIssues ? (
          <span className="pill badge-amber tabular-nums">
            {`Action needed · $${riskFormatted}/day at risk`}
          </span>
        ) : (
          <span className="pill badge-green tabular-nums">
            All links &amp; UTMs healthy
          </span>
        )}
      </div>

      <div className="workflow-next-steps-pills">
        {hasHygieneIssues ? (
          <button
            type="button"
            className="next-step-pill-btn next-step-pill-primary tabular-nums"
            disabled={disabled}
            onClick={() => onRunPrompt(hygienePrompt, 'fast')}
            data-testid="next-step-hygiene-pill"
          >
            <span>{hygienePillLabel}</span>
            <span aria-hidden="true">→</span>
          </button>
        ) : null}

        {budgetShiftLabel ? (
          <button
            type="button"
            className="next-step-pill-btn tabular-nums"
            disabled={disabled}
            onClick={() => onRunPrompt(budgetShiftPrompt, 'reasoning')}
            data-testid="next-step-budget-shift-pill"
          >
            <span>{budgetShiftLabel}</span>
            <span aria-hidden="true">→</span>
          </button>
        ) : null}

        {!hasHygieneIssues ? (
          <button
            type="button"
            className="next-step-pill-btn tabular-nums"
            disabled={disabled}
            onClick={() => onRunPrompt(roasBreakdownPrompt, 'fast')}
            data-testid="next-step-roas-pill"
          >
            <span>Compare channel spend &amp; ROAS</span>
            <span aria-hidden="true">→</span>
          </button>
        ) : null}
      </div>
    </div>
  );
}
