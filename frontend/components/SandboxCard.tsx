'use client';

import React from 'react';
import type { SandboxToolOutput } from '@/lib/types';

interface SandboxCardProps {
  state: 'skeleton' | 'completed' | 'error';
  output?: SandboxToolOutput;
  errorText?: string;
  onRetry: () => void;
}

function formatCellValue(key: string, value: string | number | boolean | null): string {
  if (value === null || value === undefined) {
    return '—';
  }
  if (typeof value === 'number') {
    const lower = key.toLowerCase();
    if (lower.includes('roas') || lower.includes('return')) {
      return `${value.toFixed(2)}x`;
    }
    if (
      lower.includes('spend') ||
      lower.includes('budget') ||
      lower.includes('pipeline') ||
      lower.includes('cost') ||
      lower.includes('cpa') ||
      lower.includes('cpc')
    ) {
      return `$${value.toLocaleString('en-US', {
        minimumFractionDigits: value < 100 ? 2 : 0,
        maximumFractionDigits: 2,
      })}`;
    }
    if (Number.isInteger(value)) {
      return value.toLocaleString('en-US');
    }
    return value.toLocaleString('en-US', {
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
  if (state === 'skeleton') {
    return (
      <section
        className="tool-card accent-green"
        aria-busy="true"
        aria-label="Running isolated SQLite query"
      >
        <div className="tool-card-eyebrow">ISOLATED SQL ANALYTICS</div>
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

  const rows = output.table ?? [];
  const columns = rows.length > 0 ? Object.keys(rows[0]) : [];

  const labelColumn =
    columns.find((col) =>
      ['channel', 'campaign_name', 'name', 'campaign_id'].includes(col.toLowerCase()),
    ) ??
    columns.find((col) => typeof rows[0]?.[col] === 'string') ??
    columns[0];

  const barMetricColumn =
    columns.find((col) => col.toLowerCase().includes('roas')) ??
    columns.find((col) => col.toLowerCase().includes('pipeline')) ??
    columns.find((col) => col.toLowerCase().includes('spend')) ??
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

  const isSandboxLive = output.mode === 'sandbox';

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

      <div className="sandbox-kpi-strip tabular-nums">
        <div className="kpi-chip">
          <span className="kpi-chip-label">Rows scanned</span>
          <strong className="kpi-chip-value">
            {output.rowsScanned.toLocaleString('en-US')}
          </strong>
        </div>
        <div className="kpi-chip">
          <span className="kpi-chip-label">Rows returned</span>
          <strong className="kpi-chip-value">
            {output.rowsReturned.toLocaleString('en-US')}
          </strong>
        </div>
        <div className="kpi-chip">
          <span className="kpi-chip-label">Execution time</span>
          <strong className="kpi-chip-value">
            {`${Math.round(output.sandboxMs).toLocaleString('en-US')} ms`}
          </strong>
        </div>
        <div className="kpi-chip">
          <span className="kpi-chip-label">Tokens avoided (estimated)</span>
          <strong className="kpi-chip-value">
            {output.estTokensAvoided.toLocaleString('en-US')}
          </strong>
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
          <code>{output.sql}</code>
        </pre>
      </details>
    </section>
  );
}
