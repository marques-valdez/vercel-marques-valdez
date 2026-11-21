'use client';

/**
 * Typed tool card for `analyze_in_sandbox` + interactive SQL workbench.
 *
 * Syncs progressive Top-6 comparison bars and table rows (or renders the signed
 * chronological `DailyAnomalyChart` on `daily_pacing_anomalies`) and lets
 * operators re-slice across all four allowlisted SQL templates via
 * `POST /api/agent/sandbox/query` with zero extra LLM calls.
 */

import React, { useState } from 'react';
import type { SandboxStatusData, SandboxToolOutput } from '@/lib/types';
import {
  DailyAnomalyChart,
  getChannelColorVar,
  resolveChannelTone,
} from './charts';

interface SandboxCardProps {
  state: 'skeleton' | 'completed' | 'error';
  output?: SandboxToolOutput;
  sandboxStatus?: SandboxStatusData | null;
  errorText?: string;
  onRetry: () => void;
}

interface PerformanceViewOption {
  id:
    | 'channel_roas_summary'
    | 'campaign_roas_ranking'
    | 'daily_pacing_anomalies'
    | 'ad_group_efficiency';
  label: string;
  zeroConversionsOnly?: boolean;
}

const PERFORMANCE_VIEWS: PerformanceViewOption[] = [
  { id: 'channel_roas_summary', label: 'By channel' },
  { id: 'campaign_roas_ranking', label: 'Top & bottom campaigns' },
  { id: 'daily_pacing_anomalies', label: 'Daily spend spikes' },
  {
    id: 'ad_group_efficiency',
    label: 'Zero-conversion spend',
    zeroConversionsOnly: true,
  },
];

const CHANNEL_FILTERS: Array<{ id: string | null; label: string }> = [
  { id: null, label: 'All channels' },
  { id: 'Google Ads', label: 'Google Ads' },
  { id: 'LinkedIn Ads', label: 'LinkedIn Ads' },
  { id: 'Meta Ads', label: 'Meta Ads' },
];

function formatColumnHeading(col: string): string {
  const clean = col.replace(/_/g, ' ').trim();
  const upperAcronyms = clean.replace(/\b(roas|cpa|cpc|ctr|utm|id)\b/gi, (m) =>
    m.toUpperCase(),
  );
  return upperAcronyms.charAt(0).toUpperCase() + upperAcronyms.slice(1);
}

export function formatCellValue(
  key: string,
  value: string | number | boolean | null,
): string {
  if (value === null || value === undefined) {
    return '—';
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      return '—';
    }
    const clean = Object.is(value, -0) ? 0 : value;
    const lower = key.toLowerCase();
    if (lower.includes('pct') || lower.includes('percent')) {
      return `${clean.toFixed(2)}%`;
    }
    if (lower.includes('roas') || lower.includes('return')) {
      return `${clean.toFixed(2)}x`;
    }
    if (
      lower.includes('spend') ||
      lower.includes('budget') ||
      lower.includes('pipeline') ||
      lower.includes('cost') ||
      lower.includes('cpa') ||
      lower.includes('cpc')
    ) {
      const sign = clean < 0 ? '-' : '';
      const abs = Math.abs(clean);
      return `${sign}$${abs.toLocaleString('en-US', {
        minimumFractionDigits: abs < 100 ? 2 : 0,
        maximumFractionDigits: 2,
      })}`;
    }
    if (Number.isInteger(clean)) {
      return clean.toLocaleString('en-US');
    }
    return clean.toLocaleString('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  }
  return String(value);
}

export function SandboxCard({
  state,
  output,
  errorText,
  onRetry,
}: SandboxCardProps) {
  const [overrideOutput, setOverrideOutput] = useState<SandboxToolOutput | null>(null);
  const [activePresetKey, setActivePresetKey] = useState<string>(
    output?.templateId ?? 'channel_roas_summary',
  );
  const [activeChannel, setActiveChannel] = useState<string | null>(null);
  const [sliceLoading, setSliceLoading] = useState(false);
  const [sliceError, setSliceError] = useState<string | null>(null);
  const [showAllRows, setShowAllRows] = useState(false);

  if (state === 'skeleton') {
    return (
      <section
        className="tool-card accent-green"
        aria-busy="true"
        aria-label="Calculating campaign performance"
      >
        <div className="tool-card-eyebrow">CAMPAIGN PERFORMANCE</div>
        <p className="workflow-step-desc">
          Calculating spend, attributed pipeline, and return on ad spend…
        </p>
        <div className="skeleton-line skeleton-medium" />
        <div className="skeleton-line skeleton-wide" />
      </section>
    );
  }

  const effectiveOutput = overrideOutput ?? output;

  if (state === 'error' || !effectiveOutput) {
    return (
      <section className="tool-card error-card" role="alert">
        <div className="error-card-row">
          <div>
            <div className="tool-card-eyebrow error-eyebrow">PERFORMANCE REPORT ERROR</div>
            <p className="error-card-body">
              {errorText || 'Unable to load campaign performance breakdown.'}
            </p>
          </div>
          <button type="button" className="btn btn-secondary" onClick={onRetry}>
            Retry
          </button>
        </div>
      </section>
    );
  }

  const runDirectSlice = async (
    preset: PerformanceViewOption,
    channel: string | null,
  ) => {
    setSliceLoading(true);
    setSliceError(null);
    setActivePresetKey(preset.id);
    setActiveChannel(channel);
    setShowAllRows(false);
    try {
      const response = await fetch('/api/agent/sandbox/query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          templateId: preset.id,
          channel,
          zeroConversionsOnly: Boolean(preset.zeroConversionsOnly),
          limit: 12,
        }),
      });
      if (!response.ok) {
        throw new Error(`Performance report failed (${response.status})`);
      }
      const nextResult = (await response.json()) as SandboxToolOutput;
      setOverrideOutput(nextResult);
    } catch (err) {
      setSliceError(
        err instanceof Error ? err.message : 'Unable to load performance view.',
      );
    } finally {
      setSliceLoading(false);
    }
  };

  const rows = effectiveOutput.table ?? [];
  const defaultVisibleRows = 6;
  const hasMoreRows = rows.length > defaultVisibleRows;
  const visibleRows = showAllRows ? rows : rows.slice(0, defaultVisibleRows);
  const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
  const isDailyAnomalyView =
    effectiveOutput.templateId === 'daily_pacing_anomalies' &&
    rows.length > 0 &&
    typeof rows[0]?.date === 'string' &&
    typeof rows[0]?.spend_delta_pct === 'number';

  const labelColumn =
    columns.find((col) =>
      ['channel', 'campaign_name', 'name', 'campaign_id'].includes(col.toLowerCase()),
    ) ??
    columns.find((col) => typeof rows[0]?.[col] === 'string') ??
    columns[0];

  const barMetricColumn =
    columns.find((col) => col.toLowerCase().includes('roas')) ??
    columns.find((col) => col.toLowerCase().includes('pipeline')) ??
    columns.find((col) => {
      const l = col.toLowerCase();
      return l.includes('spend') && !l.includes('pct') && !l.includes('percent');
    }) ??
    columns.find((col) => typeof rows[0]?.[col] === 'number');

  const maxBarValue = barMetricColumn
    ? Math.max(
        ...rows.map((r) => {
          const v = r[barMetricColumn];
          return typeof v === 'number' && Number.isFinite(v) ? v : 0;
        }),
        1,
      )
    : 1;

  return (
    <section
      className="tool-card accent-green"
      data-testid="sandbox-card"
      aria-label="Campaign performance summary"
    >
      <div className="tool-card-header">
        <div>
          <div className="tool-card-eyebrow">PAID MEDIA PERFORMANCE</div>
          <h3 className="tool-card-title">Spend, pipeline &amp; return on ad spend</h3>
        </div>
        <span className="pill pill-green tabular-nums">
          {`${effectiveOutput.rowsScanned.toLocaleString('en-US')} daily records`}
        </span>
      </div>

      <div className="sandbox-preset-bar" data-testid="sandbox-preset-bar">
        <div
          className="sandbox-preset-group"
          role="group"
          aria-label="Performance breakdown view"
        >
          {PERFORMANCE_VIEWS.map((preset) => (
            <button
              key={preset.id}
              type="button"
              disabled={sliceLoading}
              className={
                activePresetKey === preset.id
                  ? 'btn-chip btn-chip-active'
                  : 'btn-chip'
              }
              onClick={() => void runDirectSlice(preset, activeChannel)}
              data-testid={`sandbox-preset-${preset.id}`}
            >
              {preset.label}
            </button>
          ))}
        </div>
        <div className="sandbox-preset-group" role="group" aria-label="Channel filter">
          {CHANNEL_FILTERS.map((ch) => (
            <button
              key={ch.label}
              type="button"
              disabled={sliceLoading}
              className={
                activeChannel === ch.id
                  ? 'btn-chip btn-chip-active'
                  : 'btn-chip'
              }
              onClick={() => {
                const currentPreset =
                  PERFORMANCE_VIEWS.find((p) => p.id === activePresetKey) ??
                  PERFORMANCE_VIEWS[0];
                void runDirectSlice(currentPreset, ch.id);
              }}
            >
              {ch.label}
            </button>
          ))}
        </div>
      </div>

      {sliceError ? (
        <p className="inline-validation-error" role="alert">
          {sliceError}
        </p>
      ) : null}

      {isDailyAnomalyView ? (
        <DailyAnomalyChart rows={rows} />
      ) : barMetricColumn && labelColumn && rows.length > 0 ? (
        <div className="bar-chart-list tabular-nums" aria-label="Comparison bars">
          {visibleRows.map((row, idx) => {
            const label = String(row[labelColumn] ?? `Row ${idx + 1}`);
            const rawVal = row[barMetricColumn];
            const numericVal =
              typeof rawVal === 'number' && Number.isFinite(rawVal) ? rawVal : 0;
            const widthPct = Math.max(2, Math.min(100, (numericVal / maxBarValue) * 100));
            const channelCandidate =
              typeof row.channel === 'string' ? row.channel : label;
            const tone = resolveChannelTone(channelCandidate);
            const barColor =
              tone !== 'default'
                ? getChannelColorVar(channelCandidate)
                : 'var(--accent-green)';
            return (
              <div key={`${label}-${idx}`} className="bar-row">
                <div className="bar-row-meta">
                  <span className="bar-label">
                    {tone !== 'default' ? (
                      <span
                        className={`channel-dot channel-dot-${tone}`}
                        aria-hidden="true"
                      />
                    ) : null}
                    <span>{label}</span>
                  </span>
                  <span className="bar-value">
                    {formatCellValue(barMetricColumn, numericVal)}
                  </span>
                </div>
                <div className="bar-track">
                  <div
                    className="bar-fill"
                    style={{ width: `${widthPct.toFixed(1)}%`, backgroundColor: barColor }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      ) : null}

      {columns.length > 0 ? (
        <>
        <div className="table-scroll">
          <table className="data-table tabular-nums">
            <thead>
              <tr>
                {columns.map((col) => {
                  const isNumeric = typeof rows[0]?.[col] === 'number';
                  return (
                    <th key={col} scope="col" className={isNumeric ? 'num' : undefined}>
                      {formatColumnHeading(col)}
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {visibleRows.map((row, rIdx) => (
                <tr key={rIdx}>
                  {columns.map((col) => {
                    const cellVal = row[col] ?? null;
                    const isNumeric = typeof cellVal === 'number';
                    return (
                      <td key={col} className={isNumeric ? 'num' : undefined}>
                        {formatCellValue(col, cellVal)}
                      </td>
                    );
                  })}
                </tr>
              ))}
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
                : `Show all ${rows.length} rows`}
            </button>
          </div>
        ) : null}
        </>
      ) : null}
    </section>
  );
}
