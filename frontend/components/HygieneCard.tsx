'use client';

/**
 * Typed tool card for `audit_campaign_hygiene`.
 *
 * Displays flagged 404 landing pages and UTM tracking gaps grouped by channel
 * and offers a 1-click remediation action that appends deterministic fixes to
 * the visitor's Digital Twin mutation log without requiring an extra LLM turn.
 */

import React, { useEffect, useState } from 'react';
import type { DerivedTwinState, HygieneIssue, HygieneToolOutput } from '@/lib/types';
import {
  BarRow,
  StackedShareBar,
  getChannelColorVar,
  resolveChannelTone,
} from './charts';

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
  const [issueFilter, setIssueFilter] = useState<
    'all' | 'broken_404' | 'utm_violation'
  >('all');
  const [showAllRows, setShowAllRows] = useState(false);

  const hasOpenTwinIssues = Boolean(
    twinState &&
      output &&
      (Math.min(output.brokenCount, twinState.totals.brokenCreatives) > 0 ||
        Math.min(output.utmCount, twinState.totals.utmViolations) > 0),
  );

  useEffect(() => {
    if (hasOpenTwinIssues && appliedLocal) {
      setAppliedLocal(false);
    }
  }, [hasOpenTwinIssues, appliedLocal]);

  if (state === 'skeleton') {
    return (
      <section
        className="tool-card accent-blue"
        aria-busy="true"
        aria-label="Checking landing pages and UTM tracking"
      >
        <div className="tool-card-eyebrow">AD &amp; TRACKING QA</div>
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
            <div className="tool-card-eyebrow error-eyebrow">AUDIT ERROR</div>
            <p className="error-card-body">
              {errorText || 'Unable to complete the ad link and UTM audit.'}
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

  let brokenSpend = 0;
  let utmSpend = 0;
  const channelRiskMap = new Map<
    string,
    { channel: string; spend: number; broken: number; utm: number }
  >();
  for (const item of rawItems) {
    const risk = Number.isFinite(item.dailySpendAtRisk) ? Math.max(0, item.dailySpendAtRisk) : 0;
    const isBroken = item.issueType === 'broken_404';
    if (isBroken) {
      brokenSpend += risk;
    } else {
      utmSpend += risk;
    }
    const existing = channelRiskMap.get(item.channel) ?? {
      channel: item.channel,
      spend: 0,
      broken: 0,
      utm: 0,
    };
    existing.spend += risk;
    if (isBroken) {
      existing.broken += 1;
    } else {
      existing.utm += 1;
    }
    channelRiskMap.set(item.channel, existing);
  }
  const channelRiskRows = Array.from(channelRiskMap.values()).sort(
    (a, b) => b.spend - a.spend,
  );
  const maxChannelRisk = Math.max(...channelRiskRows.map((row) => row.spend), 1);

  const defaultVisibleRows = 5;
  const brokenItemsCount = rawItems.filter(
    (item) => item.issueType === 'broken_404',
  ).length;
  const utmItemsCount = rawItems.length - brokenItemsCount;
  const filteredItems =
    issueFilter === 'all'
      ? rawItems
      : rawItems.filter((item) => item.issueType === issueFilter);
  const hasMoreRows = filteredItems.length > defaultVisibleRows;
  const visibleItems = showAllRows
    ? filteredItems
    : filteredItems.slice(0, defaultVisibleRows);

  const handleApplyClick = async () => {
    setApplying(true);
    setApplyError(null);
    try {
      await onApplyFix();
      setAppliedLocal(true);
    } catch (err) {
      setApplyError(
        err instanceof Error ? err.message : 'Unable to apply ad and UTM fixes.',
      );
    } finally {
      setApplying(false);
    }
  };

  return (
    <section
      className="tool-card accent-blue"
      data-testid="hygiene-card"
      aria-label="Ad link and UTM tracking audit results"
    >
      <div className="tool-card-header">
        <div>
          <div className="tool-card-eyebrow">AD &amp; TRACKING QA</div>
          <h3 className="tool-card-title">Broken landing pages &amp; UTM tracking issues</h3>
        </div>
        <div className="kpi-cluster tabular-nums">
          <span
            className={
              isRemediated || output.totalSpendAtRiskPerDay <= 0
                ? 'pill pill-green'
                : 'pill pill-danger'
            }
          >
            {isRemediated
              ? output.totalSpendAtRiskPerDay > 0
                ? `✓ $${formatMoney(output.totalSpendAtRiskPerDay)}/day protected · 0 open issues`
                : '✓ 0 open link or UTM issues'
              : `$${formatMoney(output.totalSpendAtRiskPerDay)}/day wasted or untagged`}
          </span>
        </div>
      </div>

      {rawItems.length > 0 ? (
        <div className="hygiene-chart-panel" data-testid="hygiene-risk-chart">
          <StackedShareBar
            title="Daily spend impacted by issue type"
            segments={[
              {
                id: 'broken_404',
                label: 'Broken 404 links',
                value: brokenSpend,
                valueText: `$${formatMoney(brokenSpend)}/day`,
                color: 'var(--accent-red)',
              },
              {
                id: 'utm_issue',
                label: 'UTM tag issues',
                value: utmSpend,
                valueText: `$${formatMoney(utmSpend)}/day`,
                color: 'var(--accent-amber)',
              },
            ]}
          />
          {channelRiskRows.length > 0 ? (
            <div className="hygiene-channel-bars">
              <div className="chart-section-label">Spend at risk by channel</div>
              <div className="chart-bar-stack">
                {channelRiskRows.map((row) => (
                  <BarRow
                    key={row.channel}
                    label={row.channel}
                    sublabel={`${row.broken} broken · ${row.utm} UTM`}
                    value={row.spend}
                    maxValue={maxChannelRisk}
                    valueText={`$${formatMoney(row.spend)}/day`}
                    color={
                      row.broken > 0
                        ? 'var(--accent-red)'
                        : getChannelColorVar(row.channel)
                    }
                  />
                ))}
              </div>
            </div>
          ) : null}
        </div>
      ) : null}

      {rawItems.length > 0 ? (
        <>
          {brokenItemsCount > 0 && utmItemsCount > 0 ? (
            <div
              className="hygiene-filter-bar"
              role="group"
              aria-label="Filter flagged issues"
            >
              <button
                type="button"
                className={
                  issueFilter === 'all' ? 'btn-chip btn-chip-active' : 'btn-chip'
                }
                onClick={() => {
                  setIssueFilter('all');
                  setShowAllRows(false);
                }}
              >
                All ({rawItems.length})
              </button>
              <button
                type="button"
                className={
                  issueFilter === 'broken_404'
                    ? 'btn-chip btn-chip-active'
                    : 'btn-chip'
                }
                onClick={() => {
                  setIssueFilter('broken_404');
                  setShowAllRows(false);
                }}
              >
                Broken 404 ({brokenItemsCount})
              </button>
              <button
                type="button"
                className={
                  issueFilter === 'utm_violation'
                    ? 'btn-chip btn-chip-active'
                    : 'btn-chip'
                }
                onClick={() => {
                  setIssueFilter('utm_violation');
                  setShowAllRows(false);
                }}
              >
                UTM tags ({utmItemsCount})
              </button>
            </div>
          ) : null}

          <div className="table-scroll">
            <table className="data-table tabular-nums">
              <thead>
                <tr>
                  <th scope="col">Channel</th>
                  <th scope="col">Campaign &amp; ad group</th>
                  <th scope="col">Issue</th>
                  <th scope="col">Flagged URL / UTM tag</th>
                  <th scope="col" className="num">
                    Daily spend impacted
                  </th>
                </tr>
              </thead>
              <tbody>
                {visibleItems.map((item) => {
                  const tone = resolveChannelTone(item.channel);
                  const isBroken = item.issueType === 'broken_404';
                  const isRowResolved =
                    appliedLocal ||
                    (isBroken ? displayBrokenCount === 0 : displayUtmCount === 0);
                  return (
                    <tr
                      key={item.issueId}
                      className={isRowResolved ? 'hygiene-row-resolved' : undefined}
                    >
                      <td>
                        <span className="pill channel-pill">
                          <span
                            className={`channel-dot channel-dot-${tone}`}
                            aria-hidden="true"
                          />
                          <span>{item.channel}</span>
                        </span>
                      </td>
                      <td>
                        <div className="cell-primary">{item.campaignName}</div>
                        <div className="cell-secondary">{item.adGroupId}</div>
                      </td>
                      <td>
                        <span
                          className={
                            isRowResolved
                              ? 'pill pill-green'
                              : isBroken
                                ? 'pill pill-danger'
                                : 'pill pill-amber'
                          }
                        >
                          {isRowResolved
                            ? isBroken
                              ? '✓ Ad paused'
                              : '✓ UTM repaired'
                            : isBroken
                              ? 'Broken 404 link'
                              : 'UTM tag issue'}
                        </span>
                      </td>
                      <td className="mono-text cell-truncate" title={item.value}>
                        {item.value}
                      </td>
                      <td
                        className={
                          isRowResolved
                            ? 'num metric-resolved-cell'
                            : 'num metric-danger-cell'
                        }
                        title={
                          isRowResolved
                            ? `Protected $${formatMoney(item.dailySpendAtRisk)}/day`
                            : undefined
                        }
                      >
                        {isRowResolved
                          ? '$0.00'
                          : `$${formatMoney(item.dailySpendAtRisk)}`}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {hasMoreRows ? (
            <div className="table-expand-row">
              <button
                type="button"
                className="btn-link-subtle"
                onClick={() => setShowAllRows((prev) => !prev)}
                aria-expanded={showAllRows}
              >
                {showAllRows
                  ? `Show top ${defaultVisibleRows}`
                  : `Show all ${filteredItems.length} issues`}
              </button>
            </div>
          ) : null}
        </>
      ) : (
        <p className="card-empty-note">
          All active landing pages and UTM tracking tags look healthy.
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
            Fixes applied
          </button>
        ) : (
          <button
            type="button"
            className="btn btn-primary tabular-nums"
            disabled={applying}
            onClick={() => void handleApplyClick()}
            data-testid="hygiene-fix-button"
          >
            {displayUtmCount > 0 && displayBrokenCount > 0
              ? `Fix ${displayUtmCount} UTM tags & pause ${displayBrokenCount} broken ads`
              : displayBrokenCount > 0
                ? `Pause ${displayBrokenCount} broken ads`
                : `Fix ${displayUtmCount} UTM tags`}
          </button>
        )}
      </div>
    </section>
  );
}
