'use client';

import React, { useState } from 'react';
import type { DerivedTwinState, HygieneIssue, HygieneToolOutput } from '@/lib/types';

interface HygieneCardProps {
  state: 'skeleton' | 'completed' | 'error';
  output?: HygieneToolOutput;
  errorText?: string;
  twinState: DerivedTwinState | null;
  onApplyFix: () => Promise<void>;
  onRetry: () => void;
}

function formatMoney(value: number): string {
  return value.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export function HygieneCard({
  state,
  output,
  errorText,
  twinState,
  onApplyFix,
  onRetry,
}: HygieneCardProps) {
  const [appliedLocal, setAppliedLocal] = useState(false);
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);

  if (state === 'skeleton') {
    return (
      <section
        className="tool-card accent-blue"
        aria-busy="true"
        aria-label="Auditing campaign hygiene"
      >
        <div className="tool-card-eyebrow">CAMPAIGN HYGIENE AUDIT</div>
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
            <div className="tool-card-eyebrow error-eyebrow">HYGIENE TOOL ERROR</div>
            <p className="error-card-body">
              {errorText || 'Failed to complete campaign hygiene audit.'}
            </p>
          </div>
          <button type="button" className="btn btn-secondary" onClick={onRetry}>
            Retry
          </button>
        </div>
      </section>
    );
  }

  const rawItems: HygieneIssue[] = output.flaggedItems ?? output.items ?? [];
  const displayBrokenCount = twinState
    ? Math.min(output.brokenCount, twinState.totals.brokenCreatives)
    : output.brokenCount;
  const displayUtmCount = twinState
    ? Math.min(output.utmCount, twinState.totals.utmViolations)
    : output.utmCount;
  const isRemediated =
    appliedLocal || (displayBrokenCount === 0 && displayUtmCount === 0);

  const handleApplyClick = async () => {
    setApplying(true);
    setApplyError(null);
    try {
      await onApplyFix();
      setAppliedLocal(true);
    } catch (err) {
      setApplyError(
        err instanceof Error ? err.message : 'Unable to apply hygiene fixes.',
      );
    } finally {
      setApplying(false);
    }
  };

  return (
    <section
      className="tool-card accent-blue"
      data-testid="hygiene-card"
      aria-label="Campaign hygiene audit results"
    >
      <div className="tool-card-header">
        <div>
          <div className="tool-card-eyebrow">CAMPAIGN HYGIENE AUDIT</div>
          <h3 className="tool-card-title">Broken destinations and UTM drift</h3>
        </div>
        <div className="kpi-cluster tabular-nums">
          <span className="pill">
            {`$${formatMoney(output.totalSpendAtRiskPerDay)}/day at risk`}
          </span>
        </div>
      </div>

      {rawItems.length > 0 ? (
        <div className="table-scroll">
          <table className="data-table tabular-nums">
            <thead>
              <tr>
                <th scope="col">Channel</th>
                <th scope="col">Campaign &amp; ad group</th>
                <th scope="col">Issue</th>
                <th scope="col">Flagged value</th>
                <th scope="col" className="num">
                  Daily spend at risk
                </th>
              </tr>
            </thead>
            <tbody>
              {rawItems.map((item) => (
                <tr key={item.issueId}>
                  <td>
                    <span className="pill channel-pill">{item.channel}</span>
                  </td>
                  <td>
                    <div className="cell-primary">{item.campaignName}</div>
                    <div className="cell-secondary mono-text">{item.adGroupId}</div>
                  </td>
                  <td>
                    <span className="pill channel-pill">
                      {item.issueType === 'broken_404' ? '404 URL' : 'UTM schema'}
                    </span>
                  </td>
                  <td className="mono-text cell-truncate" title={item.value}>
                    {item.value}
                  </td>
                  <td className="num">${formatMoney(item.dailySpendAtRisk)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="card-empty-note">
          No active broken creative URLs or UTM schema violations remain in the current twin state.
        </p>
      )}

      {applyError ? (
        <p className="inline-validation-error" role="alert">
          {applyError}
        </p>
      ) : null}

      <div className="tool-card-footer">
        {isRemediated ? (
          <button
            type="button"
            className="btn btn-applied"
            disabled
            data-testid="hygiene-fix-button"
          >
            Applied
          </button>
        ) : (
          <button
            type="button"
            className="btn btn-primary tabular-nums"
            disabled={applying}
            onClick={() => void handleApplyClick()}
            data-testid="hygiene-fix-button"
          >
            {`Fix ${displayUtmCount} UTMs and pause ${displayBrokenCount} creatives`}
          </button>
        )}
      </div>
    </section>
  );
}
