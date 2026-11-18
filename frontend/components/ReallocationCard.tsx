'use client';

import React, { useState } from 'react';
import type { ReallocationToolOutput } from '@/lib/types';

const DEFAULT_BLENDED_FORMULA = 'Σ(budget_i × roas_i) / Σ(budget_i)';

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
        className="tool-card accent-blue"
        aria-busy="true"
        aria-label="Drafting budget reallocation proposal"
      >
        <div className="tool-card-eyebrow">BUDGET REALLOCATION PROPOSAL</div>
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
            <div className="tool-card-eyebrow error-eyebrow">REALLOCATION TOOL ERROR</div>
            <p className="error-card-body">
              {errorText || 'Failed to compute budget reallocation proposal.'}
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
  const formulaText = output.formula || DEFAULT_BLENDED_FORMULA;

  const handleApproveClick = async () => {
    setSubmitting(true);
    setActionError(null);
    try {
      await onApprove(output);
    } catch (err) {
      setActionError(
        err instanceof Error ? err.message : 'Unable to apply budget reallocation.',
      );
    } finally {
      setSubmitting(false);
    }
  };

  const handleDeclineClick = () => {
    setActionError(null);
    onDecline(output);
  };

  return (
    <section
      className="tool-card accent-blue"
      data-testid="reallocation-card"
      aria-label="Budget reallocation proposal"
    >
      <div className="tool-card-header">
        <div>
          <div className="tool-card-eyebrow">CLIENT-HELD BUDGET APPROVAL</div>
          <h3 className="tool-card-title">
            {`Shift $${formatBudget(output.amountPerDay)}/day from ${fromLabel} to ${toLabel}`}
          </h3>
        </div>
        <span className="pill mono-text tabular-nums">{output.proposalId}</span>
      </div>

      <div className="reallocation-grid tabular-nums">
        <div className="reallocation-panel">
          <div className="panel-heading">Before shift</div>
          <div className="comparison-row">
            <div>
              <div className="cell-primary">{fromLabel}</div>
              {output.fromChannel ? (
                <div className="cell-secondary">
                  {output.fromChannel} · {output.before.fromRoas.toFixed(2)}x ROAS
                </div>
              ) : null}
            </div>
            <strong>${formatBudget(output.before.fromDailyBudget)}/day</strong>
          </div>
          <div className="comparison-row">
            <div>
              <div className="cell-primary">{toLabel}</div>
              {output.toChannel ? (
                <div className="cell-secondary">
                  {output.toChannel} · {output.before.toRoas.toFixed(2)}x ROAS
                </div>
              ) : null}
            </div>
            <strong>${formatBudget(output.before.toDailyBudget)}/day</strong>
          </div>
          <div className="comparison-row comparison-total">
            <span>Blended return on ad spend</span>
            <strong>{output.blendedRoasBefore.toFixed(2)}x</strong>
          </div>
        </div>

        <div className="reallocation-panel reallocation-panel-after">
          <div className="panel-heading">After shift (preview)</div>
          <div className="comparison-row">
            <div>
              <div className="cell-primary">{fromLabel}</div>
              {output.fromChannel ? (
                <div className="cell-secondary">
                  {output.fromChannel} · {output.after.fromRoas.toFixed(2)}x ROAS
                </div>
              ) : null}
            </div>
            <strong>${formatBudget(output.after.fromDailyBudget)}/day</strong>
          </div>
          <div className="comparison-row">
            <div>
              <div className="cell-primary">{toLabel}</div>
              {output.toChannel ? (
                <div className="cell-secondary">
                  {output.toChannel} · {output.after.toRoas.toFixed(2)}x ROAS
                </div>
              ) : null}
            </div>
            <strong>${formatBudget(output.after.toDailyBudget)}/day</strong>
          </div>
          <div className="comparison-row comparison-total">
            <span>Blended return on ad spend</span>
            <strong>{output.blendedRoasAfter.toFixed(2)}x</strong>
          </div>
        </div>
      </div>

      <details className="technical-drawer">
        <summary>Blended return formula</summary>
        <div className="formula-drawer-body">
          <code className="mono-text">{formulaText}</code>
          <p className="drawer-caption">
            Weighted across all active campaigns before and after shifting ${formatBudget(output.amountPerDay)}/day while keeping total daily budget at ${formatBudget(output.before.totalDailyBudget)}/day.
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
            Approved · mutation saved in browser
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
              Approve
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
