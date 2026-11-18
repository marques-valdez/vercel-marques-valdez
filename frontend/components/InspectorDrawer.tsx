'use client';

import React, { useEffect, useState } from 'react';
import type { HealthStatus, RelayUIMessage, TelemetryData } from '@/lib/types';

interface InspectorDrawerProps {
  isOpen: boolean;
  injectFailure: boolean;
  telemetryEntries: TelemetryData[];
  messages: RelayUIMessage[];
  uiStreamSource: string;
  health: HealthStatus | null;
  healthLoading: boolean;
  onClose: () => void;
  onToggleInjectFailure: (next: boolean) => void;
  onRefreshHealth: () => void;
  onResetDemo: () => Promise<void>;
}

const REAL_VS_STANDIN_ROWS: ReadonlyArray<{
  production: string;
  demo: string;
  status: string;
  isReal: boolean;
}> = [
  {
    production: 'Python FastAPI + LangGraph agent',
    demo: 'Same stack, deployed as the backend service',
    status: 'Real',
    isReal: true,
  },
  {
    production: 'Model calls through a gateway',
    demo: 'AI Gateway, live',
    status: 'Real',
    isReal: true,
  },
  {
    production: 'Isolated analytics execution',
    demo: 'Vercel Sandbox, live, with in-process fallback',
    status: 'Real, fallback badged',
    isReal: true,
  },
  {
    production: 'Ad platform and CRM APIs',
    demo: 'Seeded Digital Twin dataset',
    status: 'Stand-in',
    isReal: false,
  },
  {
    production: 'LangGraph checkpointer in the database',
    demo: 'None. The graph is rebuilt from message history each turn',
    status: 'Stand-in',
    isReal: false,
  },
  {
    production: 'Temporal scheduled DAGs',
    demo: 'Six steps run in-process, once, on click. Generated Temporal code is display-only',
    status: 'Stand-in',
    isReal: false,
  },
  {
    production: 'Slack and Sheets delivery',
    demo: 'Digest preview rendered in the UI. Nothing is sent',
    status: 'Stand-in',
    isReal: false,
  },
];

const TRACKED_TOOLS = [
  'audit_campaign_hygiene',
  'analyze_in_sandbox',
  'propose_budget_reallocation',
  'compile_workflow',
] as const;

type InspectorTab = 'all' | 'adapter' | 'deployment';

interface ToolLedgerRow {
  tool: string;
  calls: number;
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
  costUsd: number;
}

export function distributeInteger(total: number, parts: number, index: number): number {
  const base = Math.floor(total / parts);
  const remainder = total % parts;
  return base + (index < remainder ? 1 : 0);
}

export function computeSessionSavings(entries: TelemetryData[]): {
  actualUsd: number;
  baselineUsd: number;
  savedUsd: number;
  savingsPercent: number;
} {
  const actualUsd = entries.reduce((s, e) => s + e.costUsd, 0);
  const baselineUsd = entries.reduce((s, e) => s + e.baselineCostUsd, 0);
  const savedUsd = Math.max(0, baselineUsd - actualUsd);
  const savingsPercent =
    baselineUsd > 0
      ? Math.max(0, Math.round(((baselineUsd - actualUsd) / baselineUsd) * 100))
      : 0;
  return { actualUsd, baselineUsd, savedUsd, savingsPercent };
}

export function computeToolLedger(messages: RelayUIMessage[]): ToolLedgerRow[] {
  const rowsByTool: Record<(typeof TRACKED_TOOLS)[number], ToolLedgerRow> = {
    audit_campaign_hygiene: {
      tool: 'audit_campaign_hygiene',
      calls: 0,
      inputTokens: 0,
      cachedTokens: 0,
      outputTokens: 0,
      costUsd: 0,
    },
    analyze_in_sandbox: {
      tool: 'analyze_in_sandbox',
      calls: 0,
      inputTokens: 0,
      cachedTokens: 0,
      outputTokens: 0,
      costUsd: 0,
    },
    propose_budget_reallocation: {
      tool: 'propose_budget_reallocation',
      calls: 0,
      inputTokens: 0,
      cachedTokens: 0,
      outputTokens: 0,
      costUsd: 0,
    },
    compile_workflow: {
      tool: 'compile_workflow',
      calls: 0,
      inputTokens: 0,
      cachedTokens: 0,
      outputTokens: 0,
      costUsd: 0,
    },
  };

  const directRow: ToolLedgerRow = {
    tool: 'Text / direct',
    calls: 0,
    inputTokens: 0,
    cachedTokens: 0,
    outputTokens: 0,
    costUsd: 0,
  };

  for (const msg of messages) {
    if (msg.role !== 'assistant') {
      continue;
    }

    const turnToolCounts: Record<(typeof TRACKED_TOOLS)[number], number> = {
      audit_campaign_hygiene: 0,
      analyze_in_sandbox: 0,
      propose_budget_reallocation: 0,
      compile_workflow: 0,
    };
    const turnTelemetry: TelemetryData[] = [];

    for (const part of msg.parts) {
      if (part.type === 'data-telemetry') {
        turnTelemetry.push(part.data);
      } else if (part.type === 'tool-audit_campaign_hygiene') {
        turnToolCounts.audit_campaign_hygiene += 1;
      } else if (part.type === 'tool-analyze_in_sandbox') {
        turnToolCounts.analyze_in_sandbox += 1;
      } else if (part.type === 'tool-propose_budget_reallocation') {
        turnToolCounts.propose_budget_reallocation += 1;
      } else if (part.type === 'tool-compile_workflow') {
        turnToolCounts.compile_workflow += 1;
      } else if (
        part.type === 'dynamic-tool' &&
        (TRACKED_TOOLS as readonly string[]).includes(part.toolName)
      ) {
        const key = part.toolName as (typeof TRACKED_TOOLS)[number];
        turnToolCounts[key] += 1;
      }
    }

    for (const toolName of TRACKED_TOOLS) {
      rowsByTool[toolName].calls += turnToolCounts[toolName];
    }

    const distinctTools = TRACKED_TOOLS.filter((t) => turnToolCounts[t] > 0);
    if (turnTelemetry.length === 0) {
      continue;
    }

    const turnInput = turnTelemetry.reduce((s, e) => s + e.inputTokens, 0);
    const turnCached = turnTelemetry.reduce((s, e) => s + e.cachedTokens, 0);
    const turnOutput = turnTelemetry.reduce((s, e) => s + e.outputTokens, 0);
    const turnCost = turnTelemetry.reduce((s, e) => s + e.costUsd, 0);

    if (distinctTools.length === 0) {
      directRow.calls += turnTelemetry.length;
      directRow.inputTokens += turnInput;
      directRow.cachedTokens += turnCached;
      directRow.outputTokens += turnOutput;
      directRow.costUsd += turnCost;
    } else {
      const shareCount = distinctTools.length;
      distinctTools.forEach((toolName, idx) => {
        rowsByTool[toolName].inputTokens += distributeInteger(
          turnInput,
          shareCount,
          idx,
        );
        rowsByTool[toolName].cachedTokens += distributeInteger(
          turnCached,
          shareCount,
          idx,
        );
        rowsByTool[toolName].outputTokens += distributeInteger(
          turnOutput,
          shareCount,
          idx,
        );
        rowsByTool[toolName].costUsd += turnCost / shareCount;
      });
    }
  }

  const orderedRows: ToolLedgerRow[] = TRACKED_TOOLS.map(
    (toolName) => rowsByTool[toolName],
  );
  if (directRow.calls > 0) {
    orderedRows.push(directRow);
  }
  return orderedRows;
}

export function InspectorDrawer({
  isOpen,
  injectFailure,
  telemetryEntries,
  messages,
  uiStreamSource,
  health,
  healthLoading,
  onClose,
  onToggleInjectFailure,
  onRefreshHealth,
  onResetDemo,
}: InspectorDrawerProps) {
  const [activeTab, setActiveTab] = useState<InspectorTab>('all');
  const [copiedSource, setCopiedSource] = useState(false);
  const [resetting, setResetting] = useState(false);

  useEffect(() => {
    if (!isOpen) {
      setCopiedSource(false);
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

  const tierStats = (['fast', 'reasoning'] as const).map((tier) => {
    const matching = telemetryEntries.filter((e) => e.tier === tier);
    return {
      tier,
      calls: matching.length,
      inputTokens: matching.reduce((s, e) => s + e.inputTokens, 0),
      cachedTokens: matching.reduce((s, e) => s + e.cachedTokens, 0),
      outputTokens: matching.reduce((s, e) => s + e.outputTokens, 0),
      costUsd: matching.reduce((s, e) => s + e.costUsd, 0),
    };
  });

  const { actualUsd: totalCostUsd, baselineUsd: totalBaselineCostUsd } =
    computeSessionSavings(telemetryEntries);
  const toolLedgerRows = computeToolLedger(messages);

  const handleCopyAdapter = async () => {
    try {
      await navigator.clipboard.writeText(uiStreamSource);
      setCopiedSource(true);
    } catch {
      const helper = document.createElement('textarea');
      helper.value = uiStreamSource;
      helper.style.position = 'fixed';
      helper.style.opacity = '0';
      document.body.appendChild(helper);
      try {
        helper.select();
        document.execCommand('copy');
        setCopiedSource(true);
      } catch {
        // Ignore fallback clipboard restrictions
      } finally {
        document.body.removeChild(helper);
      }
    }
  };

  const handleReset = async () => {
    setResetting(true);
    try {
      await onResetDemo();
    } finally {
      setResetting(false);
    }
  };

  const showArchitectureSections = activeTab === 'all';
  const showAdapterSection = activeTab === 'all' || activeTab === 'adapter';
  const showDeploymentSection = activeTab === 'all' || activeTab === 'deployment';

  return (
    <div
      className="drawer-backdrop"
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          onClose();
        }
      }}
    >
      <aside
        id="inspector-drawer"
        className="inspector-drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="inspector-drawer-title"
        data-testid="inspector-drawer"
      >
        <div className="inspector-header">
          <div>
            <div className="tool-card-eyebrow">ARCHITECTURE &amp; RUNTIME INSPECTOR</div>
            <h2 id="inspector-drawer-title" className="inspector-title">
              Option A Glass Box Inspector
            </h2>
          </div>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={onClose}
            aria-label="Close inspector"
          >
            Close
          </button>
        </div>

        <div className="inspector-tablist" role="tablist" aria-label="Inspector views">
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'all'}
            className={`tab-btn${activeTab === 'all' ? ' tab-btn-active' : ''}`}
            onClick={() => setActiveTab('all')}
          >
            All sections
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'adapter'}
            className={`tab-btn${activeTab === 'adapter' ? ' tab-btn-active' : ''}`}
            onClick={() => setActiveTab('adapter')}
          >
            Python adapter
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'deployment'}
            className={`tab-btn${activeTab === 'deployment' ? ' tab-btn-active' : ''}`}
            onClick={() => setActiveTab('deployment')}
          >
            Deployment
          </button>
        </div>

        <div className="inspector-body">
          {showArchitectureSections ? (
            <>
              <section className="inspector-section" aria-labelledby="sec-real-standin">
                <h3 id="sec-real-standin" className="inspector-section-title">
                  1. Real vs. Stand-in
                </h3>
                <div className="table-scroll">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th scope="col">Production system</th>
                        <th scope="col">In this demo</th>
                        <th scope="col">Real or stand-in</th>
                      </tr>
                    </thead>
                    <tbody>
                      {REAL_VS_STANDIN_ROWS.map((row) => (
                        <tr key={row.production}>
                          <td className="cell-primary">{row.production}</td>
                          <td>{row.demo}</td>
                          <td>
                            <span
                              className={`pill ${
                                row.isReal ? 'badge-green' : 'channel-pill'
                              }`}
                            >
                              {row.status}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="inspector-note">
                  <strong>Hosting boundary:</strong> This Hobby-plan demo runs the Python FastAPI + LangGraph service on Vercel Services so one URL contains everything. In Fieldstone&apos;s Option A production, the same Python stream adapter code runs on their existing Kubernetes cluster in <code className="mono-text">us-east4</code> alongside Temporal, AlloyDB, and Vertex AI, and only the Next.js front end, AI Gateway, and Vercel Sandbox run on Vercel.
                </p>
                <p className="inspector-note">
                  <strong>Approval checkpointing:</strong> Because this stateless demo has no database checkpointer, budget approval is client-held in the browser. Production pauses the graph with a <code className="mono-text">LangGraph</code> interrupt backed by a database checkpointer.
                </p>
              </section>

              <section className="inspector-section" aria-labelledby="sec-failover">
                <div className="switch-row">
                  <div>
                    <h3 id="sec-failover" className="inspector-section-title">
                      2. Failure injection
                    </h3>
                    <label
                      htmlFor="inject-failure-switch"
                      className="switch-label"
                    >
                      Inject primary-model failure
                    </label>
                  </div>
                  <button
                    id="inject-failure-switch"
                    type="button"
                    role="switch"
                    aria-checked={injectFailure}
                    className={`switch-control${injectFailure ? ' switch-on' : ''}`}
                    onClick={() => onToggleInjectFailure(!injectFailure)}
                    data-testid="inject-failure-switch"
                  >
                    <span className="switch-thumb" />
                  </button>
                </div>
                <p className="inspector-note">
                  When enabled, turns send <code className="mono-text">injectFailure: true</code>. If AI Gateway serves the ordered fallback, the telemetry strip badges <code className="mono-text">Gateway failover → &lt;servedModel&gt;</code>; if the Python service raises a synthetic primary 503 and retries the first fallback directly, it badges <code className="mono-text">Simulated outage · app-level retry → &lt;servedModel&gt;</code> without mislabelling an application retry as a gateway failover.
                </p>
              </section>

              <section className="inspector-section" aria-labelledby="sec-ledger">
                <h3 id="sec-ledger" className="inspector-section-title">
                  3. Session ledger
                </h3>
                <div className="ledger-subtable-heading">By tier</div>
                <div className="table-scroll">
                  <table className="data-table tabular-nums">
                    <thead>
                      <tr>
                        <th scope="col">Tier</th>
                        <th scope="col" className="num">Calls</th>
                        <th scope="col" className="num">Input (cached)</th>
                        <th scope="col" className="num">Output</th>
                        <th scope="col" className="num">Cost (USD)</th>
                      </tr>
                    </thead>
                    <tbody>
                      {tierStats.map((row) => (
                        <tr key={row.tier}>
                          <td className="mono-text">{row.tier}</td>
                          <td className="num">{row.calls.toLocaleString('en-US')}</td>
                          <td className="num">
                            {row.inputTokens.toLocaleString('en-US')} (
                            {row.cachedTokens.toLocaleString('en-US')})
                          </td>
                          <td className="num">
                            {row.outputTokens.toLocaleString('en-US')}
                          </td>
                          <td className="num">${row.costUsd.toFixed(4)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                <div className="ledger-baseline-box tabular-nums">
                  <div className="ledger-baseline-row">
                    <span>Actual session model cost</span>
                    <strong>${totalCostUsd.toFixed(4)}</strong>
                  </div>
                  <div className="ledger-baseline-row">
                    <span>Baseline (vs. every turn on the reasoning model)</span>
                    <strong>${totalBaselineCostUsd.toFixed(4)}</strong>
                  </div>
                </div>

                <div className="ledger-subtable-heading">By tool</div>
                <div className="table-scroll" data-testid="inspector-tool-ledger">
                  <table className="data-table tabular-nums">
                    <thead>
                      <tr>
                        <th scope="col">Tool</th>
                        <th scope="col" className="num">Calls</th>
                        <th scope="col" className="num">Input (cached)</th>
                        <th scope="col" className="num">Output</th>
                        <th scope="col" className="num">Cost (USD)</th>
                      </tr>
                    </thead>
                    <tbody>
                      {toolLedgerRows.map((row) => (
                        <tr key={row.tool}>
                          <td className="mono-text">{row.tool}</td>
                          <td className="num">{row.calls.toLocaleString('en-US')}</td>
                          <td className="num">
                            {row.inputTokens.toLocaleString('en-US')} (
                            {row.cachedTokens.toLocaleString('en-US')})
                          </td>
                          <td className="num">
                            {row.outputTokens.toLocaleString('en-US')}
                          </td>
                          <td className="num">${row.costUsd.toFixed(4)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            </>
          ) : null}

          {showAdapterSection ? (
            <section
              className="inspector-section"
              aria-labelledby="sec-python-adapter"
              data-testid="inspector-python-adapter"
            >
              <div className="adapter-header-row">
                <div>
                  <h3 id="sec-python-adapter" className="inspector-section-title">
                    4. Python adapter (backend/app/ui_stream.py)
                  </h3>
                  <p className="adapter-running-caption">
                    This file is running. It produced the stream you are reading.
                  </p>
                </div>
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => void handleCopyAdapter()}
                  data-testid="copy-adapter-button"
                >
                  {copiedSource ? 'Copied' : 'Copy'}
                </button>
              </div>
              <pre className="code-block inspector-code-scroll">
                <code data-testid="ui-stream-source">{uiStreamSource}</code>
              </pre>
            </section>
          ) : null}

          {showDeploymentSection ? (
            <section
              className="inspector-section"
              aria-labelledby="sec-deployment"
              data-testid="inspector-deployment"
            >
              <div className="adapter-header-row">
                <h3 id="sec-deployment" className="inspector-section-title">
                  5. Deployment (/api/agent/health)
                </h3>
                <button
                  type="button"
                  className="btn btn-secondary"
                  disabled={healthLoading}
                  onClick={onRefreshHealth}
                >
                  {healthLoading ? 'Refreshing…' : 'Refresh'}
                </button>
              </div>

              <dl className="deployment-dl tabular-nums">
                <div className="deployment-dl-row">
                  <dt>Environment</dt>
                  <dd className="mono-text">{health?.vercelEnv ?? 'unavailable'}</dd>
                </div>
                <div className="deployment-dl-row">
                  <dt>Deployment ID</dt>
                  <dd className="mono-text">{health?.deploymentId ?? 'unavailable'}</dd>
                </div>
                <div className="deployment-dl-row">
                  <dt>Commit SHA</dt>
                  <dd className="mono-text">{health?.commitSha ?? 'unavailable'}</dd>
                </div>
                <div className="deployment-dl-row">
                  <dt>Python version</dt>
                  <dd className="mono-text">{health?.pythonVersion ?? 'unavailable'}</dd>
                </div>
                <div className="deployment-dl-row">
                  <dt>Pricing source</dt>
                  <dd className="mono-text">{health?.pricingSource ?? 'unavailable'}</dd>
                </div>
                <div className="deployment-dl-row">
                  <dt>Sandbox runtime</dt>
                  <dd className="mono-text">
                    {health
                      ? health.sandboxAvailable
                        ? 'available'
                        : 'in-process fallback'
                      : 'unavailable'}
                  </dd>
                </div>
              </dl>

              <p className="inspector-note">
                <strong>Preview Deployments &amp; Rolling Releases:</strong> Vercel Services builds the Next.js front end and Python FastAPI service together so every pull request gets an isolated full-stack Preview URL. For production traffic on Pro and Enterprise plans, Rolling Releases (paired with Skew Protection and Instant Rollback) shifts traffic gradually across canary stages; Rolling Releases is described only here as the production recommendation and is not active on this Hobby-plan demo.
              </p>
            </section>
          ) : null}

          {showArchitectureSections ? (
            <section className="inspector-section" aria-labelledby="sec-later-phase">
              <h3 id="sec-later-phase" className="inspector-section-title">
                6. Later phase note (Option B — Phase 2)
              </h3>
              <p className="inspector-note">
                Today in Option A, Fieldstone keeps its Python FastAPI and LangGraph agent service, scheduled Temporal Python workflows, AlloyDB and lakehouse data plane, DeepEval test suite, and committed Vertex AI BYOK inference on its existing us-east4 cloud cluster while Vercel runs the Next.js workspace, AI Gateway routing, and Sandbox microVMs. Deferring a backend runtime port avoids a mid-launch Python-to-TypeScript rewrite while Vercel&apos;s Python Workflow SDK remains in beta. In Phase 2 (Option B), once multi-day autonomous campaign experiments and asynchronous Slack or inbox approvals are required and Python Workflow SDK GA or MCP connector boundaries are in place, orchestration moves to Vercel Workflows, WorkflowAgent, and WorkflowChatTransport for tab-close survival and zero-compute approval waits without rewriting this Next.js UI.
              </p>
            </section>
          ) : null}

          <section className="inspector-section inspector-reset-section" aria-labelledby="sec-reset">
            <div className="reset-row">
              <div>
                <h3 id="sec-reset" className="inspector-section-title">
                  7. Reset demo state
                </h3>
                <p className="inspector-note">
                  Clears browser-held Digital Twin mutations, restores baseline campaign budgets and hygiene counts, and clears session history.
                </p>
              </div>
              <button
                type="button"
                className="btn btn-danger-outline"
                disabled={resetting}
                onClick={() => void handleReset()}
                data-testid="reset-demo-button"
              >
                Reset demo
              </button>
            </div>
          </section>
        </div>
      </aside>
    </div>
  );
}
