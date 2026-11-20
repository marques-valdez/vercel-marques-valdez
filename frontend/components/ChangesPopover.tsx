'use client';

/**
 * Applied campaign changes popover & granular Undo ledger.
 *
 * Summarizes net session KPI lift (Baseline vs. Current Blended ROAS and
 * daily spend at risk) and lets the Marketing Manager undo individual mutations
 * or revert campaign changes without losing their active chat or workflows.
 */

import React, { useEffect } from 'react';
import type { CampaignSummary, Mutation, TwinTotals } from '@/lib/types';

interface ChangesPopoverProps {
  isOpen: boolean;
  mutations: Mutation[];
  baselineTotals: TwinTotals | null;
  currentTotals: TwinTotals | null;
  campaigns?: CampaignSummary[];
  busy?: boolean;
  onUndoAt: (index: number) => void;
  onRevertAllMutations: () => void;
  onResetFullWorkspace: () => void;
  onClose: () => void;
}

function formatMoneyAmount(value: number): string {
  const hasFraction = Math.abs(value - Math.round(value)) >= 0.005;
  return value.toLocaleString('en-US', {
    minimumFractionDigits: hasFraction ? 2 : 0,
    maximumFractionDigits: 2,
  });
}

export function describeMutation(
  mutation: Mutation,
  campaigns?: CampaignSummary[],
): { title: string; subtitle: string; badge: string } {
  if (mutation.type === 'pause_broken_creatives') {
    return {
      title: 'Paused broken 404 landing page ads',
      subtitle: 'Stopped paid traffic to dead destination URLs',
      badge: 'Ad status',
    };
  }
  if (mutation.type === 'fix_utm_taxonomy') {
    return {
      title: 'Repaired UTM tracking tags',
      subtitle: 'Standardized utm_source, utm_medium, and utm_campaign',
      badge: 'Attribution',
    };
  }
  const fromName =
    campaigns?.find((c) => c.campaignId === mutation.from_campaign)?.name ??
    mutation.from_campaign;
  const toName =
    campaigns?.find((c) => c.campaignId === mutation.to_campaign)?.name ??
    mutation.to_campaign;
  return {
    title: `Shifted $${formatMoneyAmount(mutation.amount_per_day)}/day`,
    subtitle: `${fromName} → ${toName}`,
    badge: 'Budget shift',
  };
}

export function ChangesPopover({
  isOpen,
  mutations,
  baselineTotals,
  currentTotals,
  campaigns,
  busy = false,
  onUndoAt,
  onRevertAllMutations,
  onResetFullWorkspace,
  onClose,
}: ChangesPopoverProps) {
  useEffect(() => {
    if (!isOpen) {
      return;
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) {
    return null;
  }

  const roasDelta =
    baselineTotals && currentTotals
      ? Number((currentTotals.blendedRoas - baselineTotals.blendedRoas).toFixed(2))
      : 0;
  const riskProtected =
    baselineTotals && currentTotals
      ? Number(
          Math.max(
            0,
            baselineTotals.spendAtRiskPerDay - currentTotals.spendAtRiskPerDay,
          ).toFixed(2),
        )
      : 0;

  return (
    <div
      className="modal-backdrop changes-backdrop"
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          onClose();
        }
      }}
    >
      <section
        id="changes-popover"
        className="changes-popover"
        role="dialog"
        aria-modal="true"
        aria-label="Applied campaign changes"
        data-testid="changes-popover"
      >
        <div className="changes-popover-header">
          <div>
            <div className="tool-card-eyebrow">SESSION AUDIT LOG</div>
            <h2 className="changes-popover-title">
              {`Applied campaign changes (${mutations.length})`}
            </h2>
          </div>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={onClose}
            aria-label="Close applied changes"
          >
            Close
          </button>
        </div>

        {baselineTotals && currentTotals ? (
          <div className="changes-kpi-grid tabular-nums" data-testid="changes-kpi-grid">
            <div className="changes-kpi-box">
              <span className="changes-kpi-label">Blended ROAS</span>
              <strong className="changes-kpi-value">
                {`${baselineTotals.blendedRoas.toFixed(2)}x → ${currentTotals.blendedRoas.toFixed(2)}x`}
              </strong>
              <span
                className={
                  roasDelta > 0
                    ? 'pill pill-green'
                    : roasDelta < 0
                      ? 'pill pill-amber'
                      : 'pill'
                }
              >
                {`${roasDelta >= 0 ? '+' : ''}${roasDelta.toFixed(2)}x net`}
              </span>
            </div>

            <div className="changes-kpi-box">
              <span className="changes-kpi-label">Daily spend at risk</span>
              <strong className="changes-kpi-value">
                {`$${formatMoneyAmount(baselineTotals.spendAtRiskPerDay)}/d → $${formatMoneyAmount(currentTotals.spendAtRiskPerDay)}/d`}
              </strong>
              <span className={riskProtected > 0 ? 'pill pill-green' : 'pill'}>
                {riskProtected > 0
                  ? `$${formatMoneyAmount(riskProtected)}/day protected`
                  : 'Unchanged'}
              </span>
            </div>
          </div>
        ) : null}

        {mutations.length > 0 ? (
          <ol className="changes-mutation-list" data-testid="changes-mutation-list">
            {mutations.map((item, idx) => {
              const desc = describeMutation(item, campaigns);
              return (
                <li key={`${item.type}-${idx}`} className="changes-mutation-row">
                  <div className="changes-mutation-meta">
                    <div className="changes-mutation-top">
                      <span className="pill">{desc.badge}</span>
                      <strong className="changes-mutation-title tabular-nums">
                        {desc.title}
                      </strong>
                    </div>
                    <div className="changes-mutation-sub">{desc.subtitle}</div>
                  </div>
                  <button
                    type="button"
                    className="btn btn-secondary changes-undo-btn"
                    disabled={busy}
                    onClick={() => onUndoAt(idx)}
                    data-testid={`undo-mutation-${idx}`}
                  >
                    Undo
                  </button>
                </li>
              );
            })}
          </ol>
        ) : (
          <p className="card-empty-note">
            No active campaign changes in this session.
          </p>
        )}

        <div className="changes-popover-footer">
          <button
            type="button"
            className="btn btn-secondary"
            disabled={busy || mutations.length === 0}
            onClick={onRevertAllMutations}
            data-testid="revert-campaign-changes-btn"
          >
            Revert campaign changes
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            disabled={busy}
            onClick={onResetFullWorkspace}
            data-testid="changes-reset-full-btn"
          >
            Reset full workspace
          </button>
        </div>
      </section>
    </div>
  );
}
