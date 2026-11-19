'use client';

import React, { useState } from 'react';
import type { SandboxStatusData, SandboxToolOutput } from '@/lib/types';

interface SandboxCardProps {
  state: 'skeleton' | 'completed' | 'error';
  output?: SandboxToolOutput;
  sandboxStatus?: SandboxStatusData | null;
  errorText?: string;
  onRetry: () => void;
}

interface SqlPresetOption {
  id: 'channel_roas_summary' | 'campaign_roas_ranking' | 'daily_pacing_anomalies' | 'ad_group_efficiency';
  label: string;
  zeroConversionsOnly?: boolean;
}

const SQL_PRESETS: SqlPresetOption[] = [
  { id: 'channel_roas_summary', label: 'Channel ROAS' },
  { id: 'campaign_roas_ranking', label: 'Campaign ranking' },
  { id: 'daily_pacing_anomalies', label: 'Daily pacing spikes' },
  {
    id: 'ad_group_efficiency',
    label: 'Zero-conv waste',
    zeroConversionsOnly: true,
  },
];

const CHANNEL_FILTERS: Array<{ id: string | null; label: string }> = [
  { id: null, label: 'All channels' },
  { id: 'Google Ads', label: 'Google Ads' },
  { id: 'LinkedIn Ads', label: 'LinkedIn Ads' },
  { id: 'Meta Ads', label: 'Meta Ads' },
];

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
  sandboxStatus,
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

  if (state === 'skeleton') {
    const activeStage = sandboxStatus?.stage ?? 'provisioning';
    return (
      <section
        className="tool-card accent-green"
        aria-busy="true"
        aria-label="Running isolated SQLite query"
      >
        <div className="tool-card-eyebrow">ISOLATED SQL ANALYTICS · @VERCEL/SANDBOX</div>
        <ol className="sandbox-stage-stepper mono-text" data-testid="sandbox-stage-stepper">
          <li className={activeStage === 'provisioning' ? 'stage-active' : 'stage-done'}>
            1. Provision ephemeral microVM
          </li>
          <li className={activeStage === 'executing_sql' ? 'stage-active' : activeStage === 'completed' ? 'stage-done' : ''}>
            2. Run parameterized sqlite3 over CSV
          </li>
          <li className={activeStage === 'completed' ? 'stage-done' : ''}>
            3. Return compact JSON summary
          </li>
        </ol>
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
            <div className="tool-card-eyebrow error-eyebrow">SANDBOX TOOL ERROR</div>
            <p className="error-card-body">
              {errorText || 'Sandbox SQL aggregation failed.'}
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
    preset: SqlPresetOption,
    channel: string | null,
  ) => {
    setSliceLoading(true);
    setSliceError(null);
    setActivePresetKey(preset.id);
    setActiveChannel(channel);
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
        throw new Error(`Sandbox query failed (${response.status})`);
      }
      const nextResult = (await response.json()) as SandboxToolOutput;
      setOverrideOutput(nextResult);
    } catch (err) {
      setSliceError(
        err instanceof Error ? err.message : 'Unable to execute Sandbox SQL slice.',
      );
    } finally {
      setSliceLoading(false);
    }
  };

  const rows = effectiveOutput.table ?? [];
  const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
  const compactSummaryTokens = Math.max(
    40,
    Math.round(JSON.stringify(rows).length / 4),
  );
  const totalContextTokens = Math.max(
    1,
    effectiveOutput.estTokensAvoided + compactSummaryTokens,
  );
  const keptInSandboxPct = Math.min(
    99.9,
    Math.max(0, (effectiveOutput.estTokensAvoided / totalContextTokens) * 100),
  );

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

  const isSandboxLive = effectiveOutput.mode === 'sandbox';

  return (
    <section
      className={`tool-card ${isSandboxLive ? 'accent-green' : 'accent-amber'}`}
      data-testid="sandbox-card"
      aria-label="Sandbox SQL aggregation results"
    >
      <div className="tool-card-header">
        <div>
          <div className="tool-card-eyebrow">ISOLATED SQL ANALYTICS</div>
          <h3 className="tool-card-title">Aggregated performance summary</h3>
        </div>
        <span
          className={`pill ${isSandboxLive ? 'badge-green' : 'badge-amber'}`}
          data-testid="sandbox-mode-badge"
        >
          <span
            className={`status-dot ${isSandboxLive ? 'dot-green' : 'dot-amber'}`}
            aria-hidden="true"
          />
          {isSandboxLive ? 'Vercel Sandbox' : 'In-process fallback'}
        </span>
      </div>

      <div className="sandbox-preset-bar" data-testid="sandbox-preset-bar">
        <div className="sandbox-preset-group" role="group" aria-label="SQL template presets">
          {SQL_PRESETS.map((preset) => (
            <button
              key={preset.id}
              type="button"
              disabled={sliceLoading}
              className={
                activePresetKey === preset.id
                  ? 'btn-chip btn-chip-active mono-text'
                  : 'btn-chip mono-text'
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
                  SQL_PRESETS.find((p) => p.id === activePresetKey) ?? SQL_PRESETS[0];
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

      <div className="sandbox-kpi-strip tabular-nums">
        <div className="kpi-chip">
          <span className="kpi-chip-label">Rows scanned</span>
          <strong className="kpi-chip-value">
            {effectiveOutput.rowsScanned.toLocaleString('en-US')}
          </strong>
        </div>
        <div className="kpi-chip">
          <span className="kpi-chip-label">Rows returned</span>
          <strong className="kpi-chip-value">
            {effectiveOutput.rowsReturned.toLocaleString('en-US')}
          </strong>
        </div>
        <div className="kpi-chip">
          <span className="kpi-chip-label">Execution time</span>
          <strong className="kpi-chip-value">
            {`${Math.round(effectiveOutput.sandboxMs).toLocaleString('en-US')} ms`}
          </strong>
        </div>
        <div className="kpi-chip">
          <span className="kpi-chip-label">Tokens avoided (estimated)</span>
          <strong className="kpi-chip-value">
            {effectiveOutput.estTokensAvoided.toLocaleString('en-US')}
          </strong>
        </div>
      </div>

      <div
        className="context-ratio-meter tabular-nums"
        data-testid="sandbox-context-meter"
      >
        <div className="context-ratio-header mono-text">
          <span>
            {`Context isolated in Sandbox: ~${effectiveOutput.estTokensAvoided.toLocaleString('en-US')} tokens (${keptInSandboxPct.toFixed(1)}%)`}
          </span>
          <span>
            {`Sent to LLM: ~${compactSummaryTokens.toLocaleString('en-US')} tokens`}
          </span>
        </div>
        <div className="context-ratio-track" aria-hidden="true">
          <div
            className={`context-ratio-fill ${isSandboxLive ? 'bar-fill-green' : 'bar-fill-amber'}`}
            style={{ width: `${keptInSandboxPct.toFixed(1)}%` }}
          />
        </div>
      </div>

      {barMetricColumn && labelColumn && rows.length > 0 ? (
        <div className="bar-chart-list tabular-nums" aria-label="Comparison bars">
          {rows.map((row, idx) => {
            const label = String(row[labelColumn] ?? `Row ${idx + 1}`);
            const rawVal = row[barMetricColumn];
            const numericVal =
              typeof rawVal === 'number' && Number.isFinite(rawVal) ? rawVal : 0;
            const widthPct = Math.max(2, Math.min(100, (numericVal / maxBarValue) * 100));
            return (
              <div key={`${label}-${idx}`} className="bar-row">
                <div className="bar-row-meta">
                  <span className="bar-label">{label}</span>
                  <span className="bar-value">
                    {formatCellValue(barMetricColumn, numericVal)}
                  </span>
                </div>
                <div className="bar-track">
                  <div
                    className={`bar-fill ${
                      isSandboxLive ? 'bar-fill-green' : 'bar-fill-amber'
                    }`}
                    style={{ width: `${widthPct.toFixed(1)}%` }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      ) : null}

      {columns.length > 0 ? (
        <div className="table-scroll">
          <table className="data-table tabular-nums">
            <thead>
              <tr>
                {columns.map((col) => {
                  const isNumeric = typeof rows[0]?.[col] === 'number';
                  return (
                    <th key={col} scope="col" className={isNumeric ? 'num' : undefined}>
                      {col.replace(/_/g, ' ')}
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, rIdx) => (
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
      ) : null}

      <details className="technical-drawer">
        <summary>Executed SQL</summary>
        <pre className="code-block">
          <code>{effectiveOutput.sql}</code>
        </pre>
      </details>
    </section>
  );
}
