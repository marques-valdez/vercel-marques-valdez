'use client';

/**
 * Dependency-free SVG and CSS chart primitives for Relay Studio.
 *
 * Every primitive derives widths, markers, and ARIA summaries strictly from
 * live props (zero hardcoded dataset literals), uses CSS custom properties
 * from `globals.css` for consistent channel and semantic coloring, and renders
 * identically in Next.js SSR, Node contract tests, and 375px mobile viewports.
 */

import React, { useId, useState } from 'react';
import type {
  ChannelId,
  ChannelTrendPoint,
  ChannelTrendSeries,
  DerivedTwinState,
  WorkflowDigestSummary,
} from '@/lib/types';

export type ChannelToneKey = 'google' | 'linkedin' | 'meta' | 'default';

export function resolveChannelTone(channelOrId?: string | null): ChannelToneKey {
  const normalized = (channelOrId ?? '').toLowerCase();
  if (normalized.includes('google')) {
    return 'google';
  }
  if (normalized.includes('linkedin')) {
    return 'linkedin';
  }
  if (normalized.includes('meta')) {
    return 'meta';
  }
  return 'default';
}

export function getChannelColorVar(channelOrId?: string | null): string {
  const tone = resolveChannelTone(channelOrId);
  if (tone === 'google') {
    return 'var(--channel-google)';
  }
  if (tone === 'linkedin') {
    return 'var(--channel-linkedin)';
  }
  if (tone === 'meta') {
    return 'var(--channel-meta)';
  }
  return 'var(--accent-blue)';
}

export function computeBarPercent(value: number, maxValue: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(maxValue) || maxValue <= 0 || value <= 0) {
    return 0;
  }
  const raw = (value / maxValue) * 100;
  return Math.max(3, Math.min(100, Number(raw.toFixed(1))));
}

export interface BarRowProps {
  label: string;
  value: number;
  maxValue: number;
  valueText: string;
  sublabel?: string;
  color?: string;
  targetValue?: number;
  targetLabel?: string;
  compact?: boolean;
  ariaLabel?: string;
  testId?: string;
}

export function BarRow({
  label,
  value,
  maxValue,
  valueText,
  sublabel,
  color = 'var(--accent-blue)',
  targetValue,
  targetLabel,
  compact = false,
  ariaLabel,
  testId,
}: BarRowProps) {
  const fillPct = computeBarPercent(value, maxValue);
  const targetPct =
    typeof targetValue === 'number' &&
    Number.isFinite(targetValue) &&
    Number.isFinite(maxValue) &&
    maxValue > 0 &&
    targetValue >= 0
      ? Math.max(0, Math.min(100, Number(((targetValue / maxValue) * 100).toFixed(1))))
      : null;

  return (
    <div
      className={`chart-bar-row${compact ? ' chart-bar-row-compact' : ''}`}
      role="img"
      aria-label={ariaLabel ?? `${label}: ${valueText}`}
      data-testid={testId}
    >
      <div className="chart-bar-meta">
        <span className="chart-bar-label">
          <span>{label}</span>
          {sublabel ? <span className="chart-bar-sublabel">{sublabel}</span> : null}
        </span>
        <span className="chart-bar-value tabular-nums">{valueText}</span>
      </div>
      <div className="chart-bar-track">
        <div
          className="chart-bar-fill"
          style={{ width: `${fillPct}%`, backgroundColor: color }}
        />
        {targetPct !== null ? (
          <span
            className="chart-bar-target"
            style={{ left: `${targetPct}%` }}
            title={targetLabel}
            aria-hidden="true"
          />
        ) : null}
      </div>
    </div>
  );
}

export interface StackedSegmentInput {
  id: string;
  label: string;
  value: number;
  valueText?: string;
  color: string;
}

export interface ComputedStackedSegment extends StackedSegmentInput {
  pct: number;
}

export function computeStackedSegments(
  segments: StackedSegmentInput[],
): ComputedStackedSegment[] {
  const positive = segments.filter(
    (seg) => typeof seg.value === 'number' && Number.isFinite(seg.value) && seg.value > 0,
  );
  const total = positive.reduce((sum, seg) => sum + seg.value, 0);
  if (total <= 0) {
    return [];
  }
  return positive.map((seg) => ({
    ...seg,
    pct: Number(((seg.value / total) * 100).toFixed(1)),
  }));
}

export interface StackedShareBarProps {
  segments: StackedSegmentInput[];
  title?: string;
  showLegend?: boolean;
  compact?: boolean;
  ariaLabel?: string;
  testId?: string;
}

export function StackedShareBar({
  segments,
  title,
  showLegend = true,
  compact = false,
  ariaLabel,
  testId,
}: StackedShareBarProps) {
  const computed = computeStackedSegments(segments);
  const fallbackAria =
    ariaLabel ??
    (computed.length > 0
      ? computed
          .map((seg) => `${seg.label} ${Math.round(seg.pct)}%${seg.valueText ? ` (${seg.valueText})` : ''}`)
          .join(', ')
      : 'No data');

  return (
    <div
      className={`chart-stacked${compact ? ' chart-stacked-compact' : ''}`}
      data-testid={testId}
    >
      {title ? <div className="chart-section-label">{title}</div> : null}
      <div className="chart-stacked-track" role="img" aria-label={fallbackAria}>
        {computed.length > 0 ? (
          computed.map((seg) => (
            <div
              key={seg.id}
              className="chart-stacked-segment"
              style={{
                width: `${seg.pct}%`,
                backgroundColor: seg.color,
              }}
              title={`${seg.label}: ${seg.valueText ?? `${Math.round(seg.pct)}%`} (${Math.round(seg.pct)}%)`}
            />
          ))
        ) : (
          <div className="chart-stacked-empty" />
        )}
      </div>
      {showLegend && computed.length > 0 ? (
        <div className="chart-legend tabular-nums">
          {computed.map((seg) => (
            <span key={seg.id} className="chart-legend-item">
              <span
                className="chart-legend-swatch"
                style={{ backgroundColor: seg.color }}
                aria-hidden="true"
              />
              <span className="chart-legend-name">{seg.label}</span>
              <span className="chart-legend-stat">
                {seg.valueText ? `${seg.valueText} (${Math.round(seg.pct)}%)` : `${Math.round(seg.pct)}%`}
              </span>
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export interface BeforeAfterItem {
  id: string;
  label: string;
  sublabel?: string;
  beforeValue: number;
  afterValue: number;
  beforeText: string;
  afterText: string;
  deltaText: string;
  deltaTone: 'positive' | 'negative' | 'neutral';
  color: string;
}

export interface BeforeAfterBarsProps {
  items: BeforeAfterItem[];
  beforeLegend?: string;
  afterLegend?: string;
  ariaLabel?: string;
  testId?: string;
}

export function BeforeAfterBars({
  items,
  beforeLegend = 'Current',
  afterLegend = 'Proposed',
  ariaLabel = 'Before and after comparison',
  testId,
}: BeforeAfterBarsProps) {
  const maxVal = Math.max(
    ...items.flatMap((item) => [
      Number.isFinite(item.beforeValue) ? Math.max(0, item.beforeValue) : 0,
      Number.isFinite(item.afterValue) ? Math.max(0, item.afterValue) : 0,
    ]),
    1,
  );

  return (
    <div
      className="chart-ba-list tabular-nums"
      role="group"
      aria-label={ariaLabel}
      data-testid={testId}
    >
      <div className="chart-ba-legend">
        <span className="chart-legend-item">
          <span className="chart-ba-swatch chart-ba-swatch-before" aria-hidden="true" />
          <span>{beforeLegend}</span>
        </span>
        <span className="chart-legend-item">
          <span className="chart-ba-swatch chart-ba-swatch-after" aria-hidden="true" />
          <span>{afterLegend}</span>
        </span>
      </div>

      {items.map((item) => {
        const beforePct = computeBarPercent(item.beforeValue, maxVal);
        const afterPct = computeBarPercent(item.afterValue, maxVal);
        const deltaClass =
          item.deltaTone === 'positive'
            ? 'delta-pill delta-pill-positive'
            : item.deltaTone === 'negative'
              ? 'delta-pill delta-pill-negative'
              : 'pill';

        return (
          <div
            key={item.id}
            className="chart-ba-item"
            role="img"
            aria-label={`${item.label}: ${beforeLegend} ${item.beforeText}, ${afterLegend} ${item.afterText} (${item.deltaText})`}
          >
            <div className="chart-ba-header">
              <div className="chart-ba-title-wrap">
                <span
                  className="chart-channel-dot"
                  style={{ backgroundColor: item.color }}
                  aria-hidden="true"
                />
                <span className="chart-bar-label">{item.label}</span>
                {item.sublabel ? (
                  <span className="chart-bar-sublabel">{item.sublabel}</span>
                ) : null}
              </div>
              <span className={deltaClass}>{item.deltaText}</span>
            </div>

            <div className="chart-ba-tracks">
              <div className="chart-ba-track-row">
                <span className="chart-ba-row-tag">{beforeLegend}</span>
                <div className="chart-bar-track chart-bar-track-muted">
                  <div
                    className="chart-bar-fill chart-bar-fill-before"
                    style={{ width: `${beforePct}%` }}
                  />
                </div>
                <span className="chart-ba-row-num">{item.beforeText}</span>
              </div>
              <div className="chart-ba-track-row">
                <span className="chart-ba-row-tag">{afterLegend}</span>
                <div className="chart-bar-track">
                  <div
                    className="chart-bar-fill"
                    style={{ width: `${afterPct}%`, backgroundColor: item.color }}
                  />
                </div>
                <strong className="chart-ba-row-num chart-ba-row-num-strong">
                  {item.afterText}
                </strong>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

export interface RangeGeometry {
  minBound: number;
  maxBound: number;
  p10Pct: number;
  p50Pct: number;
  p90Pct: number;
  zeroPct: number | null;
  allNonNegative: boolean;
  allNegative: boolean;
}

export function computeRangeGeometry(
  p10: number,
  p50: number,
  p90: number,
): RangeGeometry {
  const safeP10 = Number.isFinite(p10) ? p10 : 0;
  const safeP50 = Number.isFinite(p50) ? p50 : safeP10;
  const safeP90 = Number.isFinite(p90) ? p90 : safeP50;

  const low = Math.min(safeP10, safeP50, safeP90);
  const high = Math.max(safeP10, safeP50, safeP90);

  let minBound = Math.min(0, low);
  let maxBound = Math.max(0, high);
  if (minBound === maxBound) {
    minBound = -1;
    maxBound = 1;
  } else {
    const pad = (maxBound - minBound) * 0.08;
    minBound = minBound < 0 ? minBound - pad : 0;
    maxBound = maxBound > 0 ? maxBound + pad : 0;
  }

  const span = maxBound - minBound || 1;
  const toPct = (v: number) =>
    Math.max(0, Math.min(100, Number((((v - minBound) / span) * 100).toFixed(1))));

  const zeroPct =
    minBound <= 0 && maxBound >= 0 ? toPct(0) : null;

  return {
    minBound,
    maxBound,
    p10Pct: toPct(safeP10),
    p50Pct: toPct(safeP50),
    p90Pct: toPct(safeP90),
    zeroPct,
    allNonNegative: low >= 0,
    allNegative: high < 0,
  };
}

export interface RangeBarProps {
  p10: number;
  p50: number;
  p90: number;
  p10Text: string;
  p50Text: string;
  p90Text: string;
  p10Sub?: string;
  p50Sub?: string;
  p90Sub?: string;
  showZeroLine?: boolean;
  ariaLabel?: string;
  testId?: string;
}

export function RangeBar({
  p10,
  p50,
  p90,
  p10Text,
  p50Text,
  p90Text,
  p10Sub,
  p50Sub,
  p90Sub,
  showZeroLine = true,
  ariaLabel,
  testId,
}: RangeBarProps) {
  const geom = computeRangeGeometry(p10, p50, p90);
  const svgW = 400;
  const xFor = (pct: number) => Number(((pct / 100) * svgW).toFixed(1));
  const x10 = xFor(Math.min(geom.p10Pct, geom.p90Pct));
  const x90 = xFor(Math.max(geom.p10Pct, geom.p90Pct));
  const bandW = Math.max(6, Number((x90 - x10).toFixed(1)));
  const x50 = xFor(geom.p50Pct);
  const xZero = geom.zeroPct !== null ? xFor(geom.zeroPct) : null;

  const bandFill = geom.allNegative
    ? '#F6BFC1'
    : geom.allNonNegative
      ? '#B5E3BB'
      : '#F5D08A';
  const bandStroke = geom.allNegative
    ? '#E5484D'
    : geom.allNonNegative
      ? '#0E8A16'
      : '#D97706';
  const medianFill = geom.allNegative ? '#E5484D' : '#0E8A16';

  const summaryAria =
    ariaLabel ??
    `Forecast range: Conservative P10 ${p10Text}, Expected P50 ${p50Text}, Upside P90 ${p90Text}`;

  return (
    <div className="chart-range-wrap tabular-nums" data-testid={testId}>
      <div
        className="chart-range-canvas"
        role="img"
        aria-label={summaryAria}
      >
        <svg
          className="chart-range-svg"
          viewBox={`0 0 ${svgW} 44`}
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          <rect x="0" y="18" width={svgW} height="8" rx="4" fill="#EAEAEA" />
          {showZeroLine && xZero !== null ? (
            <line
              x1={xZero}
              y1="6"
              x2={xZero}
              y2="38"
              stroke="#666666"
              strokeWidth="1.5"
              strokeDasharray="3 2"
            />
          ) : null}
          <rect
            x={x10}
            y="14"
            width={bandW}
            height="16"
            rx="8"
            fill={bandFill}
            stroke={bandStroke}
            strokeWidth="1.5"
            vectorEffect="non-scaling-stroke"
          />
        </svg>
        <span
          className="chart-range-p50-line"
          style={{ left: `${geom.p50Pct}%`, backgroundColor: medianFill }}
          aria-hidden="true"
        />
        <span
          className="chart-range-p50-dot"
          style={{ left: `${geom.p50Pct}%`, backgroundColor: medianFill }}
          aria-hidden="true"
        />
      </div>

      <div className="forecast-grid">
        <div className="forecast-cell">
          <span className="forecast-label">Conservative (P10)</span>
          <strong className="forecast-value">{p10Text}</strong>
          {p10Sub ? <span className="forecast-sub">{p10Sub}</span> : null}
        </div>
        <div className="forecast-cell forecast-cell-median">
          <span className="forecast-label">Expected (P50)</span>
          <strong
            className={`forecast-value${
              p50 >= 0 ? ' metric-positive' : ' metric-danger'
            }`}
          >
            {p50Text}
          </strong>
          {p50Sub ? <span className="forecast-sub">{p50Sub}</span> : null}
        </div>
        <div className="forecast-cell">
          <span className="forecast-label">Upside (P90)</span>
          <strong className="forecast-value">{p90Text}</strong>
          {p90Sub ? <span className="forecast-sub">{p90Sub}</span> : null}
        </div>
      </div>
    </div>
  );
}

export interface ThresholdGaugeComputation {
  scaleMax: number;
  fillPct: number;
  thresholdPctPos: number;
  status: 'triggered' | 'warning' | 'healthy';
}

export function computeThresholdGauge(
  valuePct: number,
  thresholdPct: number,
): ThresholdGaugeComputation {
  const safeVal = Number.isFinite(valuePct) ? Math.max(0, valuePct) : 0;
  const safeThresh = Number.isFinite(thresholdPct) ? Math.max(1, thresholdPct) : 15;
  const peak = Math.max(safeVal, safeThresh);
  const rawMax = Math.max(40, Math.ceil((peak * 1.35) / 5) * 5);
  const scaleMax = peak > 100 ? Math.ceil(peak / 10) * 10 : Math.min(100, rawMax);

  const fillPct =
    safeVal <= 0
      ? 0
      : Math.max(2, Math.min(100, Number(((safeVal / scaleMax) * 100).toFixed(1))));
  const thresholdPctPos = Math.max(
    4,
    Math.min(96, Number(((safeThresh / scaleMax) * 100).toFixed(1))),
  );

  const status =
    safeVal >= safeThresh
      ? 'triggered'
      : safeVal >= safeThresh * 0.75
        ? 'warning'
        : 'healthy';

  return { scaleMax, fillPct, thresholdPctPos, status };
}

export interface ThresholdGaugeProps {
  label: string;
  valuePct: number;
  thresholdPct: number;
  valueText: string;
  thresholdText?: string;
  detailText?: string;
  ariaLabel?: string;
  testId?: string;
}

export function ThresholdGauge({
  label,
  valuePct,
  thresholdPct,
  valueText,
  thresholdText,
  detailText,
  ariaLabel,
  testId,
}: ThresholdGaugeProps) {
  const gauge = computeThresholdGauge(valuePct, thresholdPct);
  const fillColor =
    gauge.status === 'triggered'
      ? 'var(--accent-red)'
      : gauge.status === 'warning'
        ? 'var(--accent-amber)'
        : 'var(--accent-green)';
  const statusPillClass =
    gauge.status === 'triggered'
      ? 'pill pill-danger'
      : gauge.status === 'warning'
        ? 'pill pill-amber'
        : 'pill pill-green';
  const statusLabel =
    gauge.status === 'triggered'
      ? 'Alert triggered'
      : gauge.status === 'warning'
        ? 'Near threshold'
        : 'Within guardrail';

  const ruleLabel = thresholdText ?? `Alert rule: ≥ ${thresholdPct}%`;

  return (
    <div
      className="chart-gauge tabular-nums"
      role="img"
      aria-label={ariaLabel ?? `${label}: ${valueText} (${ruleLabel}, ${statusLabel})`}
      data-testid={testId}
    >
      <div className="chart-gauge-header">
        <div className="chart-gauge-title-group">
          <span className="chart-bar-label">{label}</span>
          <strong
            className={`chart-gauge-value ${
              gauge.status === 'triggered'
                ? 'metric-danger'
                : gauge.status === 'warning'
                  ? 'metric-warn'
                  : 'metric-positive'
            }`}
          >
            {valueText}
          </strong>
        </div>
        <span className={statusPillClass}>{statusLabel}</span>
      </div>

      <div className="chart-gauge-track">
        <div
          className="chart-gauge-fill"
          style={{ width: `${gauge.fillPct}%`, backgroundColor: fillColor }}
        />
        <div
          className="chart-gauge-marker"
          style={{ left: `${gauge.thresholdPctPos}%` }}
          aria-hidden="true"
        />
      </div>

      <div className="chart-gauge-footer">
        <span>{detailText ?? '0%'}</span>
        <span>{ruleLabel}</span>
      </div>
    </div>
  );
}

export interface WorkflowVisualSummaryProps {
  digestPreview: string;
  digestSummary: WorkflowDigestSummary | null;
  channels: ChannelId[];
  threshold: number;
  twinState?: DerivedTwinState | null;
  testId?: string;
}

export function WorkflowVisualSummary({
  digestPreview,
  digestSummary,
  channels,
  threshold,
  twinState = null,
  testId,
}: WorkflowVisualSummaryProps) {
  const effectiveThreshold = digestSummary?.thresholdPct ?? threshold;
  const spendAtRiskPerDay = digestSummary?.spendAtRiskPerDay;
  const derivedPct =
    typeof digestSummary?.spendAtRiskPct === 'number' &&
    Number.isFinite(digestSummary.spendAtRiskPct)
      ? digestSummary.spendAtRiskPct
      : typeof spendAtRiskPerDay === 'number' &&
          twinState &&
          twinState.totals.dailyBudget > 0
        ? Number(((spendAtRiskPerDay / twinState.totals.dailyBudget) * 100).toFixed(1))
        : null;

  const uniqueChannels = Array.from(new Set(channels));
  const channelRows: Array<{ id: string; label: string; roas: number; spend?: number }> = [];

  if (twinState?.channels && twinState.channels.length > 0) {
    const filtered =
      uniqueChannels.length > 0
        ? twinState.channels.filter((ch) => uniqueChannels.includes(ch.channelId))
        : twinState.channels;
    const source = filtered.length > 0 ? filtered : twinState.channels;
    for (const ch of source) {
      channelRows.push({
        id: ch.channelId,
        label: ch.channel,
        roas: ch.roas,
        spend: ch.dailyBudget,
      });
    }
  } else if (digestSummary) {
    const seen = new Set<string>();
    for (const ref of [digestSummary.highestRoasChannel, digestSummary.lowestRoasChannel]) {
      if (ref && !seen.has(ref.channelId)) {
        seen.add(ref.channelId);
        channelRows.push({
          id: ref.channelId,
          label: ref.channel,
          roas: ref.roas,
        });
      }
    }
  }

  channelRows.sort((a, b) => b.roas - a.roas);
  const maxRoas = Math.max(...channelRows.map((row) => row.roas), 1);

  return (
    <div className="workflow-visual-summary" data-testid={testId}>
      {derivedPct !== null ? (
        <ThresholdGauge
          label="Daily spend at risk"
          valuePct={derivedPct}
          thresholdPct={effectiveThreshold}
          valueText={`${derivedPct.toFixed(1)}%`}
          thresholdText={`Alert rule: ≥ ${effectiveThreshold}%`}
          detailText={
            typeof spendAtRiskPerDay === 'number'
              ? `$${spendAtRiskPerDay.toLocaleString('en-US', {
                  minimumFractionDigits: 2,
                  maximumFractionDigits: 2,
                })}/day impacted · ${digestSummary?.brokenCreatives ?? 0} broken links · ${digestSummary?.utmViolations ?? 0} UTM issues`
              : undefined
          }
          testId="workflow-threshold-gauge"
        />
      ) : null}

      {channelRows.length > 0 ? (
        <div className="workflow-roas-bars" data-testid="workflow-roas-bars">
          <div className="chart-section-label">Channel ROAS snapshot</div>
          <div className="chart-bar-stack">
            {channelRows.map((row) => (
              <BarRow
                key={row.id}
                label={row.label}
                sublabel={
                  typeof row.spend === 'number'
                    ? `$${row.spend.toLocaleString('en-US', {
                        maximumFractionDigits: 0,
                      })}/day`
                    : undefined
                }
                value={row.roas}
                maxValue={maxRoas}
                valueText={`${row.roas.toFixed(2)}x ROAS`}
                color={getChannelColorVar(row.id)}
                targetValue={digestSummary?.blendedRoas ?? twinState?.totals.blendedRoas}
                targetLabel={
                  digestSummary?.blendedRoas
                    ? `Blended ROAS ${digestSummary.blendedRoas.toFixed(2)}x`
                    : undefined
                }
              />
            ))}
          </div>
        </div>
      ) : null}

      <details className="digest-raw-drawer">
        <summary className="digest-raw-summary">
          Preview morning Slack &amp; Google Sheets brief
        </summary>
        <pre className="digest-preview-text">{digestPreview}</pre>
      </details>
    </div>
  );
}

export interface SparklinePointCoord {
  index: number;
  x: number;
  y: number;
  point: ChannelTrendPoint;
}

export interface SparklineGeometry {
  coords: SparklinePointCoord[];
  linePath: string;
  areaPath: string;
  minRoas: number;
  maxRoas: number;
  avgY: number;
}

export function formatShortIsoDate(isoDate: string): string {
  const parts = isoDate.split('-');
  if (parts.length !== 3) {
    return isoDate;
  }
  const monthIdx = Number.parseInt(parts[1], 10) - 1;
  const dayNum = Number.parseInt(parts[2], 10);
  const months = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
  ];
  if (
    !Number.isFinite(monthIdx) ||
    !Number.isFinite(dayNum) ||
    monthIdx < 0 ||
    monthIdx >= months.length
  ) {
    return isoDate;
  }
  return `${months[monthIdx]} ${dayNum}`;
}

export function computeSparklineGeometry(
  points: ChannelTrendPoint[],
  width: number = 180,
  height: number = 38,
  padX: number = 4,
  padY: number = 4,
): SparklineGeometry {
  if (!points || points.length === 0) {
    return {
      coords: [],
      linePath: '',
      areaPath: '',
      minRoas: 0,
      maxRoas: 0,
      avgY: height / 2,
    };
  }

  const roasVals = points.map((p) => (Number.isFinite(p.roas) ? p.roas : 0));
  const rawMin = Math.min(...roasVals);
  const rawMax = Math.max(...roasVals);
  const span = rawMax - rawMin;
  const minRoas = span < 0.1 ? Math.max(0, rawMin - 0.5) : rawMin - span * 0.08;
  const maxRoas = span < 0.1 ? rawMax + 0.5 : rawMax + span * 0.08;
  const effectiveSpan = maxRoas - minRoas || 1;

  const innerW = Math.max(1, width - padX * 2);
  const innerH = Math.max(1, height - padY * 2);
  const bottomY = Number((height - padY).toFixed(1));

  const coords: SparklinePointCoord[] = points.map((pt, index) => {
    const x =
      points.length === 1
        ? width / 2
        : padX + (index / (points.length - 1)) * innerW;
    const val = Number.isFinite(pt.roas) ? pt.roas : minRoas;
    const norm = Math.max(0, Math.min(1, (val - minRoas) / effectiveSpan));
    const y = padY + (1 - norm) * innerH;
    return {
      index,
      x: Number(x.toFixed(1)),
      y: Number(y.toFixed(1)),
      point: pt,
    };
  });

  const linePath = coords
    .map((c, idx) => `${idx === 0 ? 'M' : 'L'} ${c.x} ${c.y}`)
    .join(' ');
  const firstX = coords[0].x;
  const lastX = coords[coords.length - 1].x;
  const areaPath = `${linePath} L ${lastX} ${bottomY} L ${firstX} ${bottomY} Z`;

  const avgVal = roasVals.reduce((sum, v) => sum + v, 0) / roasVals.length;
  const avgNorm = Math.max(0, Math.min(1, (avgVal - minRoas) / effectiveSpan));
  const avgY = Number((padY + (1 - avgNorm) * innerH).toFixed(1));

  return {
    coords,
    linePath,
    areaPath,
    minRoas: Number(rawMin.toFixed(2)),
    maxRoas: Number(rawMax.toFixed(2)),
    avgY,
  };
}

export interface TrendSparklineProps {
  series: ChannelTrendSeries;
  color: string;
  testId?: string;
}

export function TrendSparkline({
  series,
  color,
  testId,
}: TrendSparklineProps) {
  const reactId = useId();
  const safeGradId = `spark-grad-${reactId.replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  const width = 180;
  const height = 38;
  const geom = computeSparklineGeometry(series.points, width, height, 4, 4);

  if (geom.coords.length === 0) {
    return null;
  }

  const activeIdx =
    hoverIdx !== null && hoverIdx >= 0 && hoverIdx < geom.coords.length
      ? hoverIdx
      : geom.coords.length - 1;
  const activeCoord = geom.coords[activeIdx];
  const isHovering = hoverIdx !== null;

  const delta = series.deltaPct;
  const deltaPositive = delta > 1;
  const deltaNegative = delta < -1;
  const deltaText = `${delta > 0 ? '+' : ''}${delta.toFixed(1)}%`;

  const handleMouseMove = (event: React.MouseEvent<SVGSVGElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    if (!rect.width || geom.coords.length <= 1) {
      return;
    }
    const relX = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
    const idx = Math.round(relX * (geom.coords.length - 1));
    setHoverIdx(idx);
  };

  const handleKeyDown = (event: React.KeyboardEvent<SVGSVGElement>) => {
    if (geom.coords.length <= 1) {
      return;
    }
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      setHoverIdx((prev) =>
        prev === null ? geom.coords.length - 1 : Math.max(0, prev - 1),
      );
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      setHoverIdx((prev) =>
        prev === null ? 0 : Math.min(geom.coords.length - 1, prev + 1),
      );
    } else if (event.key === 'Escape') {
      setHoverIdx(null);
    }
  };

  return (
    <div className="trend-sparkline tabular-nums" data-testid={testId}>
      <div className="trend-sparkline-header">
        <span className="trend-sparkline-caption">
          {isHovering
            ? formatShortIsoDate(activeCoord.point.date)
            : `${series.points.length}d ROAS trend`}
        </span>
        {isHovering ? (
          <strong className="trend-sparkline-hover-val">
            {`${activeCoord.point.roas.toFixed(2)}x`}
          </strong>
        ) : (
          <span
            className={`trend-delta-pill ${
              deltaPositive
                ? 'trend-delta-up'
                : deltaNegative
                  ? 'trend-delta-down'
                  : 'trend-delta-flat'
            }`}
            title={`First 7 days ${series.firstWindowRoas.toFixed(2)}x vs last 7 days ${series.lastWindowRoas.toFixed(2)}x`}
          >
            <span aria-hidden="true">
              {deltaPositive ? '↗' : deltaNegative ? '↘' : '→'}
            </span>
            <span>{deltaText}</span>
          </span>
        )}
      </div>

      <div className="trend-sparkline-canvas">
        <svg
          className="trend-sparkline-svg"
          viewBox={`0 0 ${width} ${height}`}
          preserveAspectRatio="none"
          role="img"
          tabIndex={0}
          aria-label={`${series.channel} ${series.points.length}-day ROAS trend from ${series.firstWindowRoas.toFixed(2)}x to ${series.lastWindowRoas.toFixed(2)}x (${deltaText})`}
          onMouseMove={handleMouseMove}
          onMouseLeave={() => setHoverIdx(null)}
          onBlur={() => setHoverIdx(null)}
          onKeyDown={handleKeyDown}
        >
          <defs>
            <linearGradient id={safeGradId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity="0.22" />
              <stop offset="100%" stopColor={color} stopOpacity="0.02" />
            </linearGradient>
          </defs>
          <line
            x1="4"
            y1={geom.avgY}
            x2={width - 4}
            y2={geom.avgY}
            stroke="#CBD5E1"
            strokeWidth="1"
            strokeDasharray="2 2"
            vectorEffect="non-scaling-stroke"
          />
          <path d={geom.areaPath} fill={`url(#${safeGradId})`} />
          <path
            d={geom.linePath}
            fill="none"
            stroke={color}
            strokeWidth="1.75"
            strokeLinecap="round"
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          />
          {isHovering ? (
            <line
              x1={activeCoord.x}
              y1="2"
              x2={activeCoord.x}
              y2={height - 2}
              stroke={color}
              strokeOpacity="0.45"
              strokeWidth="1"
              vectorEffect="non-scaling-stroke"
            />
          ) : null}
        </svg>
        <span
          className={`trend-sparkline-dot${isHovering ? ' trend-sparkline-dot-active' : ''}`}
          style={{
            left: `${((activeCoord.x / width) * 100).toFixed(2)}%`,
            top: `${((activeCoord.y / height) * 100).toFixed(2)}%`,
            borderColor: color,
          }}
          aria-hidden="true"
        />
      </div>
    </div>
  );
}

export interface AnomalyBarPoint {
  id: string;
  date: string;
  channel: string;
  totalSpend: number;
  avgDailySpend: number;
  spendDeltaPct: number;
  roas: number | null;
  color: string;
}

export function computeAnomalySeries(
  rows: Array<Record<string, string | number | boolean | null>>,
): { items: AnomalyBarPoint[]; maxAbsPct: number } {
  const parsed: AnomalyBarPoint[] = [];
  for (let i = 0; i < rows.length; i += 1) {
    const r = rows[i];
    const date = typeof r.date === 'string' ? r.date : '';
    const spendDeltaPct =
      typeof r.spend_delta_pct === 'number' && Number.isFinite(r.spend_delta_pct)
        ? r.spend_delta_pct
        : null;
    const totalSpend =
      typeof r.total_spend === 'number' && Number.isFinite(r.total_spend)
        ? r.total_spend
        : 0;
    const avgDailySpend =
      typeof r.avg_daily_spend === 'number' && Number.isFinite(r.avg_daily_spend)
        ? r.avg_daily_spend
        : 0;
    if (!date || spendDeltaPct === null) {
      continue;
    }
    const channel = typeof r.channel === 'string' ? r.channel : 'Channel';
    const roas =
      typeof r.roas === 'number' && Number.isFinite(r.roas) ? r.roas : null;
    parsed.push({
      id: `${date}-${channel}-${i}`,
      date,
      channel,
      totalSpend,
      avgDailySpend,
      spendDeltaPct,
      roas,
      color: getChannelColorVar(channel),
    });
  }

  parsed.sort((a, b) => a.date.localeCompare(b.date) || a.channel.localeCompare(b.channel));
  const rawMax = Math.max(...parsed.map((item) => Math.abs(item.spendDeltaPct)), 10);
  const maxAbsPct = Math.ceil(rawMax / 5) * 5;
  return { items: parsed, maxAbsPct };
}

export interface DailyAnomalyChartProps {
  rows: Array<Record<string, string | number | boolean | null>>;
  testId?: string;
}

export function DailyAnomalyChart({
  rows,
  testId = 'daily-anomaly-chart',
}: DailyAnomalyChartProps) {
  const { items, maxAbsPct } = computeAnomalySeries(rows);
  const [selectedIdx, setSelectedIdx] = useState<number | null>(null);

  if (items.length === 0) {
    return null;
  }

  let peakIdx = 0;
  for (let i = 1; i < items.length; i += 1) {
    if (Math.abs(items[i].spendDeltaPct) > Math.abs(items[peakIdx].spendDeltaPct)) {
      peakIdx = i;
    }
  }
  const activeIdx =
    selectedIdx !== null && selectedIdx >= 0 && selectedIdx < items.length
      ? selectedIdx
      : peakIdx;
  const active = items[activeIdx];
  const firstDate = formatShortIsoDate(items[0].date);
  const midDate = formatShortIsoDate(items[Math.floor(items.length / 2)].date);
  const lastDate = formatShortIsoDate(items[items.length - 1].date);

  return (
    <div
      className="anomaly-chart tabular-nums"
      role="img"
      aria-label={`Chronological daily spend variance chart across ${items.length} anomaly days. Peak variance: ${formatShortIsoDate(active.date)} ${active.channel} ${active.spendDeltaPct > 0 ? '+' : ''}${active.spendDeltaPct.toFixed(1)}%.`}
      data-testid={testId}
    >
      <div className="anomaly-chart-header">
        <div>
          <div className="chart-section-label">Chronological spend vs. channel average</div>
          <div className="anomaly-readout" data-testid="anomaly-chart-readout">
            <span
              className={`channel-dot channel-dot-${resolveChannelTone(active.channel)}`}
              aria-hidden="true"
            />
            <strong>{formatShortIsoDate(active.date)}</strong>
            <span>{active.channel}</span>
            <span className="anomaly-readout-sep" aria-hidden="true">·</span>
            <span>
              {`$${Math.round(active.totalSpend).toLocaleString('en-US')} vs $${Math.round(active.avgDailySpend).toLocaleString('en-US')} avg`}
            </span>
            <span
              className={`pill ${
                active.spendDeltaPct >= 0 ? 'pill-amber' : 'pill-blue'
              }`}
            >
              {`${active.spendDeltaPct >= 0 ? '+' : ''}${active.spendDeltaPct.toFixed(1)}%`}
            </span>
            {active.roas !== null ? (
              <span className="anomaly-readout-roas">{`${active.roas.toFixed(2)}x ROAS`}</span>
            ) : null}
          </div>
        </div>
      </div>

      <div className="anomaly-plot-wrap">
        <div className="anomaly-y-axis" aria-hidden="true">
          <span>{`+${maxAbsPct}%`}</span>
          <span>0%</span>
          <span>{`-${maxAbsPct}%`}</span>
        </div>

        <div className="anomaly-plot">
          <div className="anomaly-baseline" aria-hidden="true" />
          <div className="anomaly-bars">
            {items.map((item, idx) => {
              const heightPct = Math.max(
                6,
                Math.min(100, (Math.abs(item.spendDeltaPct) / maxAbsPct) * 100),
              );
              const isPositive = item.spendDeltaPct >= 0;
              const isSelected = idx === activeIdx;
              return (
                <button
                  key={item.id}
                  type="button"
                  className={`anomaly-bar-slot${isSelected ? ' anomaly-bar-slot-active' : ''}`}
                  aria-label={`${formatShortIsoDate(item.date)} ${item.channel}: ${item.spendDeltaPct > 0 ? '+' : ''}${item.spendDeltaPct.toFixed(1)}% vs average`}
                  onMouseEnter={() => setSelectedIdx(idx)}
                  onFocus={() => setSelectedIdx(idx)}
                  onClick={() => setSelectedIdx(idx)}
                >
                  <span className="anomaly-bar-half anomaly-bar-half-top">
                    {isPositive ? (
                      <span
                        className="anomaly-bar anomaly-bar-pos"
                        style={{
                          height: `${heightPct.toFixed(1)}%`,
                          backgroundColor: item.color,
                        }}
                      />
                    ) : null}
                  </span>
                  <span className="anomaly-bar-half anomaly-bar-half-bottom">
                    {!isPositive ? (
                      <span
                        className="anomaly-bar anomaly-bar-neg"
                        style={{
                          height: `${heightPct.toFixed(1)}%`,
                          backgroundColor: item.color,
                        }}
                      />
                    ) : null}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      </div>

      <div className="anomaly-x-axis">
        <span>{firstDate}</span>
        {items.length > 2 ? <span>{midDate}</span> : null}
        <span>{lastDate}</span>
      </div>
    </div>
  );
}
