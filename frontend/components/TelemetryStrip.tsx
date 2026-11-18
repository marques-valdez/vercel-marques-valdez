'use client';

import React from 'react';
import type { TelemetryData } from '@/lib/types';

interface TelemetryStripProps {
  entries: TelemetryData[];
}

export function TelemetryStrip({ entries }: TelemetryStripProps) {
  if (entries.length === 0) {
    return null;
  }

  const first = entries[0];
  const last = entries[entries.length - 1];
  const failoverEntry = entries.find(
    (entry) => entry.failover === 'gateway' || entry.failover === 'simulated',
  );

  const totalInputTokens = entries.reduce((sum, item) => sum + item.inputTokens, 0);
  const totalCachedTokens = entries.reduce((sum, item) => sum + item.cachedTokens, 0);
  const totalOutputTokens = entries.reduce((sum, item) => sum + item.outputTokens, 0);
  const totalLatencyMs = entries.reduce((sum, item) => sum + item.latencyMs, 0);
  const totalCostUsd = entries.reduce((sum, item) => sum + item.costUsd, 0);

  const displayedModel = failoverEntry ? failoverEntry.servedModel : last.servedModel;
  const failoverMode = failoverEntry ? failoverEntry.failover : 'none';

  return (
    <div
      className="telemetry-strip tabular-nums"
      data-testid="telemetry-strip"
      aria-label="Turn model telemetry"
    >
      <span className="telemetry-chip telemetry-tier">
        {`tier: ${first.tier}`}
      </span>
      <span className="telemetry-sep" aria-hidden="true">·</span>
      <span className="telemetry-item">{`routed: ${first.routedBy}`}</span>
      <span className="telemetry-sep" aria-hidden="true">·</span>
      <span className="telemetry-item" data-testid="telemetry-served-model">
        {displayedModel}
      </span>
      <span className="telemetry-sep" aria-hidden="true">·</span>
      <span className="telemetry-item">
        {`${Math.round(totalLatencyMs).toLocaleString('en-US')} ms`}
      </span>
      <span className="telemetry-sep" aria-hidden="true">·</span>
      <span className="telemetry-item">
        {`${totalInputTokens.toLocaleString('en-US')} in (${totalCachedTokens.toLocaleString('en-US')} cached)`}
      </span>
      <span className="telemetry-sep" aria-hidden="true">·</span>
      <span className="telemetry-item">
        {`${totalOutputTokens.toLocaleString('en-US')} out`}
      </span>
      <span className="telemetry-sep" aria-hidden="true">·</span>
      <span className="telemetry-item">{`$${totalCostUsd.toFixed(4)}`}</span>

      {failoverMode === 'gateway' ? (
        <span
          className="telemetry-failover telemetry-failover-amber"
          data-testid="telemetry-failover-badge"
        >
          {`Gateway failover → ${displayedModel}`}
        </span>
      ) : null}

      {failoverMode === 'simulated' ? (
        <span
          className="telemetry-failover telemetry-failover-amber"
          data-testid="telemetry-failover-badge"
        >
          {`Simulated outage · app-level retry → ${displayedModel}`}
        </span>
      ) : null}
    </div>
  );
}
