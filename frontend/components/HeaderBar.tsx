'use client';

/**
 * Sticky 56px workspace header bar.
 *
 * Keeps the default Marketing Manager chrome minimal (portfolio summary pill,
 * conditional `Reset changes`, `Workflows` flyout counter, `Share playbook`,
 * and the compact `X-Ray` toggle). The `Inspector` button only appears when
 * `architectMode` is explicitly turned on.
 */

import React from 'react';
import type { DerivedTwinState, TelemetryData } from '@/lib/types';

interface HeaderBarProps {
  twinState: DerivedTwinState | null;
  telemetryEntries?: TelemetryData[];
  inspectorOpen?: boolean;
  architectMode?: boolean;
  hasConversation?: boolean;
  workflowCount?: number;
  workflowsOpen?: boolean;
  onOpenShare: () => void;
  onToggleWorkflows?: () => void;
  onToggleInspector?: () => void;
  onToggleArchitectMode?: () => void;
  onResetWorkspace?: () => void;
}

export function HeaderBar({
  twinState,
  inspectorOpen = false,
  architectMode = false,
  hasConversation = false,
  workflowCount = 0,
  workflowsOpen = false,
  onOpenShare,
  onToggleWorkflows,
  onToggleInspector,
  onToggleArchitectMode,
  onResetWorkspace,
}: HeaderBarProps) {
  const portfolioPillText = twinState
    ? `${twinState.totals.campaignCount.toLocaleString('en-US')} active campaigns · $${Math.round(
        twinState.totals.dailyBudget,
      ).toLocaleString('en-US')}/day`
    : 'Loading campaigns…';

  const hasChanges = Boolean(
    hasConversation || (twinState && twinState.totals.appliedMutations > 0),
  );

  return (
    <header className="header-bar" role="banner">
      <div className="header-inner">
        <div className="header-left">
          <span className="brand-mark" aria-hidden="true">
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
              <rect
                x="2"
                y="2"
                width="16"
                height="16"
                rx="4"
                stroke="#171717"
                strokeWidth="1.5"
              />
              <path
                d="M6 10H10M10 10L13 6M10 10L13 15"
                stroke="#171717"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </span>
          <span className="brand-title">Fieldstone / Relay Studio</span>
          <span className="pill tabular-nums" data-testid="header-dataset-pill">
            {portfolioPillText}
          </span>
        </div>

        <div className="header-right">
          {hasChanges && onResetWorkspace ? (
            <button
              type="button"
              className="btn btn-secondary"
              onClick={onResetWorkspace}
              data-testid="header-reset-button"
            >
              Reset changes
            </button>
          ) : null}
          <button
            type="button"
            className="btn btn-secondary tabular-nums"
            aria-expanded={workflowsOpen}
            aria-controls="workflows-drawer"
            onClick={() => onToggleWorkflows?.()}
            data-testid="header-workflows-button"
          >
            {workflowCount > 0 ? `Workflows (${workflowCount})` : 'Workflows'}
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={onOpenShare}
          >
            Share playbook
          </button>
          {architectMode && onToggleInspector ? (
            <button
              type="button"
              className="btn btn-secondary"
              aria-expanded={inspectorOpen}
              aria-controls="inspector-drawer"
              onClick={onToggleInspector}
              data-testid="header-inspector-button"
            >
              Inspector
            </button>
          ) : null}
          {onToggleArchitectMode ? (
            <button
              type="button"
              className={architectMode ? 'btn-chip btn-chip-active' : 'btn-chip'}
              aria-pressed={architectMode}
              onClick={onToggleArchitectMode}
              title="Toggle Vercel Services, AI Gateway, and SSE protocol X-Ray"
              data-testid="header-xray-toggle"
            >
              {architectMode ? 'X-Ray: On' : 'X-Ray'}
            </button>
          ) : null}
        </div>
      </div>
    </header>
  );
}
