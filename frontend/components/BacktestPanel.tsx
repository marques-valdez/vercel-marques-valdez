'use client';

/**
 * Alert-history backtest for a compiled recurring check.
 *
 * Fetches the daily series once from `POST /api/agent/workflows/backtest`
 * (Neon Postgres, or the bundled rows when Neon is absent or holds older rows)
 * and recomputes alert days in the browser as the threshold slider moves, so
 * dragging sends no requests. The slider is a preview only: it never rewrites
 * the saved workflow's threshold.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { BacktestResponse, WorkflowToolOutput } from '@/lib/types';
import { BacktestTimeline, computeBacktestSummary, formatShortIsoDate } from './charts';

interface BacktestPanelProps {
  workflow: WorkflowToolOutput;
  architectMode?: boolean;
  testIdPrefix?: string;
}

const SLIDER_MIN = 1;

export function clampBacktestThreshold(value: number, sliderMax: number): number {
  if (!Number.isFinite(value)) {
    return SLIDER_MIN;
  }
  return Math.max(SLIDER_MIN, Math.min(sliderMax, Math.round(value)));
}

export function resolveBacktestSliderMax(savedThreshold: number, maxPct: number): number {
  const needed = Math.max(
    Number.isFinite(savedThreshold) ? savedThreshold : 0,
    Number.isFinite(maxPct) ? Math.ceil(maxPct) + 5 : 0,
    30,
  );
  return Math.min(100, Math.ceil(needed / 5) * 5);
}

export function BacktestPanel({
  workflow,
  architectMode = false,
  testIdPrefix = 'workflow',
}: BacktestPanelProps) {
  const [result, setResult] = useState<BacktestResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [threshold, setThreshold] = useState<number>(workflow.threshold);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    abortRef.current?.abort();
    setResult(null);
    setError(null);
    setLoading(false);
    setThreshold(workflow.threshold);
  }, [workflow.workflowId, workflow.threshold]);

  const sliderMax = useMemo(
    () => resolveBacktestSliderMax(workflow.threshold, result?.summary.maxPct ?? 0),
    [workflow.threshold, result],
  );
  const activeThreshold = clampBacktestThreshold(threshold, sliderMax);
  const summary = useMemo(
    () => (result ? computeBacktestSummary(result.points, activeThreshold) : null),
    [result, activeThreshold],
  );

  const handleRun = async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);
    setError(null);
    try {
      const response = await fetch('/api/agent/workflows/backtest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        cache: 'no-store',
        signal: controller.signal,
        body: JSON.stringify({
          workflow: {
            template: workflow.template,
            channels: workflow.channels,
            threshold: workflow.threshold,
            schedule: workflow.schedule,
          },
          days: 90,
        }),
      });
      if (!response.ok) {
        throw new Error(
          response.status === 429
            ? 'Too many backtests in a short time. Please wait a moment and retry.'
            : `Backtest unavailable (${response.status}).`,
        );
      }
      const parsed = (await response.json()) as BacktestResponse;
      if (!parsed || !Array.isArray(parsed.points)) {
        throw new Error('Backtest returned an unexpected response.');
      }
      if (!controller.signal.aborted) {
        setResult(parsed);
        setThreshold(workflow.threshold);
      }
    } catch (err) {
      if (!controller.signal.aborted) {
        setError(err instanceof Error ? err.message : 'Backtest failed.');
      }
    } finally {
      if (!controller.signal.aborted) {
        setLoading(false);
      }
    }
  };

  if (!result || !summary) {
    return (
      <div className="backtest-launch" data-testid={`${testIdPrefix}-backtest-launch`}>
        <button
          type="button"
          className="btn btn-secondary"
          disabled={loading}
          onClick={() => void handleRun()}
          data-testid={`${testIdPrefix}-backtest-button`}
        >
          {loading ? 'Checking past days…' : 'Backtest alert history'}
        </button>
        <span className="cell-secondary">
          See how often this alert would have fired on past data before you rely on it.
        </span>
        {error ? (
          <p className="inline-validation-error" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    );
  }

  const brokenLinkCount = result.events.reduce((acc, evt) => acc + evt.brokenLinks, 0);
  const isPreviewing = activeThreshold !== workflow.threshold;
  const sliderId = `${testIdPrefix}-backtest-slider-${workflow.workflowId}`;

  return (
    <div className="forecast-band backtest-panel tabular-nums" data-testid={`${testIdPrefix}-backtest-panel`}>
      <div className="forecast-band-header">
        <div>
          <div className="panel-heading">{`Alert history · last ${result.days} days`}</div>
          <div className="cell-secondary">
            {`Each bar is the share of that day's spend on ad groups with no conversions in the previous ${result.windowDays} days.`}
            {architectMode
              ? ` · ${
                  result.mode === 'neon-postgres' ? 'Neon Postgres' : 'In-process SQLite'
                } (${Math.round(result.ms)}ms)`
              : ''}
          </div>
        </div>
        <span
          className={`pill ${summary.alertDays > 0 ? 'badge-amber' : 'pill-green'}`}
          data-testid={`${testIdPrefix}-backtest-alert-pill`}
        >
          {`${summary.alertDays} of ${summary.totalDays} days would have alerted`}
        </span>
      </div>

      <BacktestTimeline
        points={result.points}
        thresholdPct={activeThreshold}
        events={result.events}
        testId={`${testIdPrefix}-backtest-timeline`}
      />

      <div className="backtest-slider-row">
        <label htmlFor={sliderId} className="backtest-slider-label">
          {`Alert when at least ${activeThreshold}% of spend`}
        </label>
        <input
          id={sliderId}
          type="range"
          className="reallocation-range-input"
          min={SLIDER_MIN}
          max={sliderMax}
          step={1}
          value={activeThreshold}
          aria-label="Alert threshold as a percent of daily spend"
          onChange={(e) => setThreshold(Number(e.target.value))}
          data-testid={`${testIdPrefix}-backtest-slider`}
        />
      </div>

      <div className="forecast-grid">
        <div className="forecast-cell">
          <span className="forecast-label">Longest run of alert days</span>
          <strong className="forecast-value">
            {summary.longestStreakDays === 1 ? '1 day' : `${summary.longestStreakDays} days`}
          </strong>
        </div>
        <div className="forecast-cell">
          <span className="forecast-label">First alert</span>
          <strong className="forecast-value">
            {summary.firstAlertDate ? formatShortIsoDate(summary.firstAlertDate) : 'None'}
          </strong>
        </div>
        <div className="forecast-cell">
          <span className="forecast-label">Spend flagged on alert days</span>
          <strong className="forecast-value">
            {`$${Math.round(summary.flaggedSpend).toLocaleString('en-US')}`}
          </strong>
        </div>
      </div>

      <p className="forecast-note">
        {brokenLinkCount > 0
          ? `Red markers show when ${brokenLinkCount} landing page${
              brokenLinkCount === 1 ? '' : 's'
            } broke. `
          : ''}
        {`A page is counted once it has gone ${result.windowDays} days without a conversion, so this rule reacts about ${result.windowDays} days after a break. Small ad groups can also go ${result.windowDays} days without converting by chance, which is why the bars never reach zero.`}
      </p>
      {isPreviewing ? (
        <p className="forecast-note" data-testid={`${testIdPrefix}-backtest-preview-note`}>
          {`Previewing ${activeThreshold}%. The saved check still alerts at ${workflow.threshold}%.`}
        </p>
      ) : null}
    </div>
  );
}
