'use client';

import React from 'react';
import type { DerivedTwinState, TelemetryData } from '@/lib/types';

interface HeaderBarProps {
  twinState: DerivedTwinState | null;
  telemetryEntries: TelemetryData[];
  inspectorOpen: boolean;
  onOpenShare: () => void;
  onToggleInspector: () => void;
}

export function HeaderBar({
  twinState,
  telemetryEntries,
  inspectorOpen,
  onOpenShare,
  onToggleInspector,
}: HeaderBarProps) {
  const totalCostUsd = telemetryEntries.reduce((sum, item) => sum + item.costUsd, 0);
  const totalBaselineUsd = telemetryEntries.reduce(
    (sum, item) => sum + item.baselineCostUsd,
    0,
  );
  const savingsPercent =
    totalBaselineUsd > 0
      ? Math.max(0, Math.round(((totalBaselineUsd - totalCostUsd) / totalBaselineUsd) * 100))
      : 0;

  const formattedCostUsd =
    totalCostUsd > 0 && totalCostUsd < 0.01
      ? totalCostUsd.toFixed(4)
      : totalCostUsd.toFixed(2);

  const sessionPillText =
    telemetryEntries.length === 0
      ? 'Session: $0.00'
      : `Session: $${formattedCostUsd} · ${savingsPercent}% less than every turn on the reasoning model`;

  const datasetPillText = twinState
    ? `${twinState.totals.campaignCount.toLocaleString('en-US')} campaigns · ${twinState.totals.rowCount.toLocaleString('en-US')} rows`
    : 'Loading dataset…';

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
            {datasetPillText}
          </span>
        </div>

        <div className="header-right">
          <span
            className="pill session-pill tabular-nums"
            data-testid="session-spend-pill"
          >
            {sessionPillText}
          </span>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={onOpenShare}
          >
            Share playbook
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            aria-expanded={inspectorOpen}
            aria-controls="inspector-drawer"
            onClick={onToggleInspector}
          >
            Inspector
          </button>
        </div>
      </div>
    </header>
  );
}
