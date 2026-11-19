'use client';

/**
 * Opt-in Architect X-Ray topology bar (`?xray=1` or `X-Ray` header toggle).
 *
 * Visualizes the live Vercel Services path (`Next.js App Router -> /api/agent/*
 * -> Python FastAPI + LangGraph`), Sandbox/pricing mode, 1-click `Primary 503
 * drill` failover trigger, and a 4-step interactive demo tour. Hidden by
 * default so Marketing Managers see a distraction-free workspace.
 */

import React, { useState } from 'react';
import type { HealthStatus, PlaybookId } from '@/lib/types';

interface VercelArchitectureStripProps {
  health: HealthStatus | null;
  healthPingMs: number | null;
  injectFailure: boolean;
  isStreaming: boolean;
  onToggleInjectFailure: (next: boolean) => void;
  onRunDemoStep: (step: 'sandbox' | 'xray' | 'failover' | 'og') => void;
  onOpenInspector: (tab: 'runtime' | 'adapter' | 'deployment') => void;
}

const DEMO_STEPS: Array<{
  id: 'sandbox' | 'xray' | 'failover' | 'og';
  stepNum: string;
  primitive: string;
  label: string;
  playbookHint?: PlaybookId;
}> = [
  {
    id: 'sandbox',
    stepNum: '1',
    primitive: '@vercel/sandbox',
    label: 'Run microVM SQL slice',
    playbookHint: 'cross-channel-roas',
  },
  {
    id: 'xray',
    stepNum: '2',
    primitive: 'AI SDK UI + Python SSE',
    label: 'Inspect live SSE wire',
    playbookHint: 'creative-404-guard',
  },
  {
    id: 'failover',
    stepNum: '3',
    primitive: 'AI Gateway',
    label: 'Arm 503 drill & run reasoning',
    playbookHint: 'paid-social-reallocation',
  },
  {
    id: 'og',
    stepNum: '4',
    primitive: 'next/og + App Router',
    label: 'Open zero-DB OG studio',
  },
];

export function VercelArchitectureStrip({
  health,
  healthPingMs,
  injectFailure,
  isStreaming,
  onToggleInjectFailure,
  onRunDemoStep,
  onOpenInspector,
}: VercelArchitectureStripProps) {
  const [tourOpen, setTourOpen] = useState(false);

  const pythonLabel = health?.pythonVersion
    ? `Python ${health.pythonVersion}`
    : 'Python FastAPI';
  const sandboxLabel = health?.sandboxAvailable
    ? 'Firecracker microVM'
    : 'In-process SQLite';
  const pricingLabel =
    health?.pricingSource === 'live' ? 'Live pricing' : 'Pinned pricing';
  const dbLabel = health?.databaseConnected ? 'Neon Postgres' : 'Browser local';

  return (
    <section
      className="arch-strip"
      aria-label="Vercel Services runtime topology"
      data-testid="vercel-architecture-strip"
    >
      <div className="arch-strip-main">
        <div className="arch-topology tabular-nums">
          <span className="arch-node">
            <span className="arch-dot arch-dot-blue" aria-hidden="true" />
            <span>Next.js App Router</span>
          </span>
          <span className="arch-arrow mono-text" aria-hidden="true">
            {'->'}
          </span>
          <button
            type="button"
            className="arch-node arch-node-btn mono-text"
            onClick={() => onOpenInspector('deployment')}
            title="Inspect Vercel Services deployment metadata"
          >
            <span>/api/agent/*</span>
            {healthPingMs !== null ? (
              <span className="arch-ping">{`${healthPingMs}ms`}</span>
            ) : null}
          </button>
          <span className="arch-arrow mono-text" aria-hidden="true">
            {'->'}
          </span>
          <button
            type="button"
            className="arch-node arch-node-btn"
            onClick={() => onOpenInspector('adapter')}
            title="Inspect Python UI Message Stream v1 adapter"
          >
            <span className="arch-dot arch-dot-green" aria-hidden="true" />
            <span>{`${pythonLabel} · LangGraph`}</span>
          </button>
          <span className="arch-sep" aria-hidden="true">
            |
          </span>
          <span className="arch-meta mono-text">
            {`Sandbox: ${sandboxLabel} · DB: ${dbLabel} · ${pricingLabel}`}
          </span>
        </div>

        <div className="arch-controls">
          <button
            type="button"
            className={
              injectFailure
                ? 'btn-chip btn-chip-amber'
                : 'btn-chip'
            }
            aria-pressed={injectFailure}
            onClick={() => onToggleInjectFailure(!injectFailure)}
            data-testid="arch-503-drill-button"
          >
            {injectFailure ? 'Primary 503 drill: Armed' : 'Primary 503 drill: Off'}
          </button>

          <button
            type="button"
            className={tourOpen ? 'btn-chip btn-chip-active' : 'btn-chip'}
            aria-expanded={tourOpen}
            onClick={() => setTourOpen((prev) => !prev)}
            data-testid="demo-tour-toggle"
          >
            {tourOpen ? 'Hide 4-step tour' : '4-step demo tour'}
          </button>
        </div>
      </div>

      {tourOpen ? (
        <div
          className="demo-tour-bar"
          role="region"
          aria-label="Four-step Vercel component tour"
          data-testid="demo-tour-bar"
        >
          {DEMO_STEPS.map((item) => (
            <button
              key={item.id}
              type="button"
              className="demo-tour-step"
              disabled={isStreaming && item.id !== 'og'}
              onClick={() => onRunDemoStep(item.id)}
              data-testid={`demo-tour-step-${item.id}`}
            >
              <span className="demo-tour-eyebrow mono-text">
                {`${item.stepNum}. ${item.primitive}`}
              </span>
              <span className="demo-tour-label">{item.label}</span>
            </button>
          ))}
        </div>
      ) : null}
    </section>
  );
}
