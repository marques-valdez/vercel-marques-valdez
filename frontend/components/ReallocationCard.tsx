'use client';

/**
 * Human-in-the-loop approval card for `propose_budget_reallocation`.
 *
 * Enforces the read-only proposal invariant: renders server-computed before
 * and after daily budgets and blended ROAS deltas, and mutates Digital Twin
 * state only when the operator explicitly clicks Approve (decision state is
 * isolated per `toolCallId` in `WorkspaceClient`).
 */

import React, { useState } from 'react';
import type { ReallocationToolOutput } from '@/lib/types';
import {
  BarRow,
  BeforeAfterBars,
  RangeBar,
  getChannelColorVar,
} from './charts';

interface ReallocationCardProps {
  state: 'skeleton' | 'completed' | 'error';
  output?: ReallocationToolOutput;
  errorText?: string;
  decision: 'approved' | 'declined' | null;
  disabled: boolean;
  onApprove: (output: ReallocationToolOutput) => Promise<void>;
  onDecline: (output: ReallocationToolOutput) => void;
  onRetry: () => void;
}

function formatBudget(amount: number): string {
  const hasFraction = Math.abs(amount - Math.round(amount)) >= 0.005;
  return amount.toLocaleString('en-US', {
    minimumFractionDigits: hasFraction ? 2 : 0,
    maximumFractionDigits: 2,
  });
}

function formatSignedCurrency(amount: number): string {
  const sign = amount > 0 ? '+' : amount < 0 ? '-' : '';
  const abs = Math.abs(amount);
  return `${sign}$${abs.toLocaleString('en-US', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  })}`;
}

export function ReallocationCard({
  state,
  output,
  errorText,
  decision,
  disabled,
  onApprove,
  onDecline,
  onRetry,
}: ReallocationCardProps) {
  const [submitting, setSubmitting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  if (state === 'skeleton') {
    return (
      <section
        className="tool-card accent-amber"
        aria-busy="true"
        aria-label="Drafting budget shift proposal"
      >
        <div className="tool-card-eyebrow">BUDGET SHIFT PROPOSAL</div>
        <div className="skeleton-line skeleton-medium" />
        <div className="skeleton-line skeleton-wide" />
        <div className="skeleton-line skeleton-wide" />
      </section>
    );
  }

  if (state === 'error' || !output) {
    return (
      <section className="tool-card error-card" role="alert">
        <div className="error-card-row">
          <div>
            <div className="tool-card-eyebrow error-eyebrow">PROPOSAL ERROR</div>
            <p className="error-card-body">
              {errorText || 'Unable to draft the daily budget shift proposal.'}
            </p>
          </div>
          <button type="button" className="btn btn-secondary" onClick={onRetry}>
            Retry
          </button>
        </div>
      </section>
    );
  }

  const fromLabel = output.fromCampaignName || output.fromCampaign;
  const toLabel = output.toCampaignName || output.toCampaign;

  const handleApproveClick = async () => {
    setSubmitting(true);
    setActionError(null);
    try {
      await onApprove(output);
    } catch (err) {
      setActionError(
        err instanceof Error ? err.message : 'Unable to apply budget shift.',
      );
    } finally {
      setSubmitting(false);
    }
  };

  const handleDeclineClick = () => {
    setActionError(null);
    onDecline(output);
  };

  const roasLift = output.blendedRoasAfter - output.blendedRoasBefore;
  const maxRoasScale = Math.max(
    output.blendedRoasBefore,
    output.blendedRoasAfter,
    1,
  );

  return (
    <section
      className="tool-card accent-amber"
      data-testid="reallocation-card"
      aria-label="Budget reallocation proposal"
    >
      <div className="tool-card-header">
        <div>
          <div className="tool-card-eyebrow">BUDGET SHIFT FOR APPROVAL</div>
          <h3 className="tool-card-title">
            {`Shift $${formatBudget(output.amountPerDay)}/day from ${fromLabel} to ${toLabel}`}
          </h3>
        </div>
        <span
          className={`pill tabular-nums ${
            roasLift >= 0 ? 'pill-green' : 'pill-amber'
          }`}
        >
          {`Projected ROAS: ${output.blendedRoasBefore.toFixed(2)}x → ${output.blendedRoasAfter.toFixed(2)}x`}
        </span>
      </div>

      <div className="reallocation-chart-panel" data-testid="reallocation-budget-chart">
        <BeforeAfterBars
          ariaLabel={`Daily budget shift of $${formatBudget(output.amountPerDay)} per day from ${fromLabel} to ${toLabel}`}
          items={[
            {
              id: `from-${output.fromCampaign}`,
              label: fromLabel,
              sublabel: output.fromChannel
                ? `${output.fromChannel} · ${output.before.fromRoas.toFixed(2)}x ROAS`
                : `${output.before.fromRoas.toFixed(2)}x ROAS`,
              beforeValue: output.before.fromDailyBudget,
              afterValue: output.after.fromDailyBudget,
              beforeText: `$${formatBudget(output.before.fromDailyBudget)}/day`,
              afterText: `$${formatBudget(output.after.fromDailyBudget)}/day`,
              deltaText: `-$${formatBudget(output.amountPerDay)}/day`,
              deltaTone: 'negative',
              color: getChannelColorVar(output.fromChannel || output.fromCampaign),
            },
            {
              id: `to-${output.toCampaign}`,
              label: toLabel,
              sublabel: output.toChannel
                ? `${output.toChannel} · ${output.before.toRoas.toFixed(2)}x ROAS`
                : `${output.before.toRoas.toFixed(2)}x ROAS`,
              beforeValue: output.before.toDailyBudget,
              afterValue: output.after.toDailyBudget,
              beforeText: `$${formatBudget(output.before.toDailyBudget)}/day`,
              afterText: `$${formatBudget(output.after.toDailyBudget)}/day`,
              deltaText: `+$${formatBudget(output.amountPerDay)}/day`,
              deltaTone: 'positive',
              color: getChannelColorVar(output.toChannel || output.toCampaign),
            },
          ]}
        />

        <div className="reallocation-roas-compare">
          <div className="chart-section-label">Portfolio blended ROAS impact</div>
          <div className="chart-bar-stack">
            <BarRow
              label="Current blended ROAS"
              value={output.blendedRoasBefore}
              maxValue={maxRoasScale}
              valueText={`${output.blendedRoasBefore.toFixed(2)}x`}
              color="#94A3B8"
              compact
            />
            <BarRow
              label="Projected blended ROAS"
              value={output.blendedRoasAfter}
              maxValue={maxRoasScale}
              valueText={`${output.blendedRoasAfter.toFixed(2)}x (${roasLift >= 0 ? '+' : ''}${roasLift.toFixed(2)}x)`}
              color={roasLift >= 0 ? 'var(--accent-green)' : 'var(--accent-amber)'}
              compact
            />
          </div>
        </div>
      </div>

      {output.simulation ? (
        <div
          className="forecast-band tabular-nums"
          data-testid="reallocation-forecast-band"
        >
          <div className="forecast-band-header">
            <div>
              <div className="panel-heading">
                {`${output.simulation.horizonDays}-day pipeline forecast (with diminishing returns)`}
              </div>
              <div className="cell-secondary">
                {`${output.simulation.trials.toLocaleString('en-US')}-trial Monte Carlo simulation calibrated from historical daily variance`}
              </div>
            </div>
            <span className="pill pill-green" data-testid="forecast-lift-probability">
              {`${Math.round(output.simulation.probabilityOfPositiveLiftPct)}% chance of positive lift`}
            </span>
          </div>

          <RangeBar
            p10={output.simulation.incrementalPipelineP10}
            p50={output.simulation.incrementalPipelineP50}
            p90={output.simulation.incrementalPipelineP90}
            p10Text={formatSignedCurrency(output.simulation.incrementalPipelineP10)}
            p50Text={formatSignedCurrency(output.simulation.incrementalPipelineP50)}
            p90Text={formatSignedCurrency(output.simulation.incrementalPipelineP90)}
            p10Sub={`${output.simulation.blendedRoasP10.toFixed(2)}x blended ROAS`}
            p50Sub={`${output.simulation.blendedRoasP50.toFixed(2)}x blended ROAS`}
            p90Sub={`${output.simulation.blendedRoasP90.toFixed(2)}x blended ROAS`}
            testId="reallocation-range-bar"
          />

          {output.simulation.targetSaturationDragPct > 0 ? (
            <p className="forecast-note">
              {`Accounts for an estimated ${output.simulation.targetSaturationDragPct.toFixed(1)}% marginal ROAS compression as ${toLabel} scales budget.`}
            </p>
          ) : null}
        </div>
      ) : null}

      <details className="technical-drawer">
        <summary>How projected ROAS is calculated</summary>
        <div className="formula-drawer-body">
          <p className="drawer-caption">
            Projected blended ROAS weights each active campaign&apos;s historical return by
            its updated daily budget while keeping your total daily budget unchanged at $
            {formatBudget(output.before.totalDailyBudget)}/day.
          </p>
        </div>
      </details>

      {actionError ? (
        <p className="inline-validation-error" role="alert">
          {actionError}
        </p>
      ) : null}

      <div className="tool-card-footer">
        {decision === 'approved' ? (
          <span className="pill badge-green" data-testid="reallocation-decision-pill">
            Approved · daily budgets updated
          </span>
        ) : decision === 'declined' ? (
          <span className="pill" data-testid="reallocation-decision-pill">
            Declined · budgets unchanged
          </span>
        ) : (
          <div className="card-actions-inline">
            <button
              type="button"
              className="btn btn-primary"
              disabled={disabled || submitting}
              onClick={() => void handleApproveClick()}
              data-testid="reallocation-approve-button"
            >
              Approve budget shift
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              disabled={disabled || submitting}
              onClick={handleDeclineClick}
              data-testid="reallocation-decline-button"
            >
              Decline
            </button>
          </div>
        )}
      </div>
    </section>
  );
}
