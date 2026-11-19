'use client';

import React, { useEffect, useRef, useState } from 'react';
import { CHANNEL_LABELS } from '@/lib/playbooks';
import { readStoredMutations } from '@/lib/twin-client';
import {
  getWorkflowDisplayName,
  resolveValidWorkflowShareSlug,
  resolveWorkflowDagSteps,
} from '@/lib/workflow-store';
import type { SavedWorkflowRecord, WorkflowRunStepEvent } from '@/lib/types';
import { WorkflowDagView, type DagStepRunState } from './WorkflowDagView';

interface WorkflowsDrawerProps {
  isOpen: boolean;
  workflows: SavedWorkflowRecord[];
  selectedWorkflowId: string | null;
  onSelectWorkflow: (workflowId: string) => void;
  onRenameWorkflow: (workflowId: string, nextName: string) => void;
  onRemoveWorkflow: (workflowId: string) => void;
  onShareWorkflow: (slug: string) => void;
  onCompileSample: () => void;
  onClose: () => void;
}

function formatDetail(detail: unknown): string {
  if (typeof detail === 'string') {
    return detail;
  }
  if (detail === null || detail === undefined) {
    return '';
  }
  try {
    return JSON.stringify(detail);
  } catch {
    return String(detail);
  }
}

export function WorkflowsDrawer({
  isOpen,
  workflows,
  selectedWorkflowId,
  onSelectWorkflow,
  onRenameWorkflow,
  onRemoveWorkflow,
  onShareWorkflow,
  onCompileSample,
  onClose,
}: WorkflowsDrawerProps) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState<string>('');
  const [copiedCode, setCopiedCode] = useState(false);

  const [runningDryRun, setRunningDryRun] = useState(false);
  const [dryRunError, setDryRunError] = useState<string | null>(null);
  const [digestPreviewByWf, setDigestPreviewByWf] = useState<Record<string, string>>(
    {},
  );
  const [stepStatesByWf, setStepStatesByWf] = useState<
    Record<string, Record<string, DagStepRunState>>
  >({});
  const dryRunAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    return () => {
      dryRunAbortRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    if (!isOpen) {
      dryRunAbortRef.current?.abort();
      setRunningDryRun(false);
      setEditingId(null);
      setCopiedCode(false);
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

  const activeRecord =
    workflows.find((item) => item.workflow.workflowId === selectedWorkflowId) ??
    workflows[0] ??
    null;

  const activeWorkflow = activeRecord?.workflow ?? null;
  const activeWfId = activeWorkflow?.workflowId ?? '';
  const activeStepStates = activeWfId ? stepStatesByWf[activeWfId] ?? {} : {};
  const activeDigest = activeWfId ? digestPreviewByWf[activeWfId] ?? null : null;

  const handleStartRename = (record: SavedWorkflowRecord) => {
    setEditingId(record.workflow.workflowId);
    setDraftName(getWorkflowDisplayName(record));
  };

  const handleCommitRename = (workflowId: string) => {
    onRenameWorkflow(workflowId, draftName);
    setEditingId(null);
  };

  const handleCopyTemporalCode = async (code: string) => {
    try {
      await navigator.clipboard.writeText(code);
      setCopiedCode(true);
    } catch {
      // Ignore clipboard failures in restricted contexts
    }
  };

  const handleRunDryRun = async () => {
    if (!activeWorkflow) {
      return;
    }
    const targetWfId = activeWorkflow.workflowId;
    const orderedNodes = resolveWorkflowDagSteps(activeWorkflow);

    dryRunAbortRef.current?.abort();
    const controller = new AbortController();
    dryRunAbortRef.current = controller;

    setRunningDryRun(true);
    setDryRunError(null);
    setDigestPreviewByWf((prev) => {
      const next = { ...prev };
      delete next[targetWfId];
      return next;
    });

    const initialMap: Record<string, DagStepRunState> = {};
    orderedNodes.forEach((step, idx) => {
      initialMap[step.node] = { status: idx === 0 ? 'running' : 'idle' };
    });
    setStepStatesByWf((prev) => ({ ...prev, [targetWfId]: initialMap }));

    try {
      const response = await fetch('/api/agent/workflows/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          workflow: activeWorkflow,
          mutations: readStoredMutations(),
        }),
      });

      if (!response.ok || !response.body) {
        throw new Error(`Dry run failed (${response.status})`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let buffer = '';
      let sawZeroStepIndex = false;
      let sawDone = false;

      const applyEvent = (evt: WorkflowRunStepEvent) => {
        if (evt.stepIndex === 0) {
          sawZeroStepIndex = true;
        }
        const matchedIndex = orderedNodes.findIndex((s) => s.node === evt.node);
        const fallbackIdx =
          typeof evt.stepIndex === 'number'
            ? !sawZeroStepIndex &&
              evt.stepIndex >= 1 &&
              evt.stepIndex <= orderedNodes.length &&
              matchedIndex === -1
              ? evt.stepIndex - 1
              : evt.stepIndex
            : -1;
        const resolvedIdx = matchedIndex !== -1 ? matchedIndex : fallbackIdx;
        const targetNode =
          resolvedIdx >= 0 && resolvedIdx < orderedNodes.length
            ? orderedNodes[resolvedIdx].node
            : evt.node;

        const detailText = formatDetail(evt.detail);
        if (targetNode === 'Digest' && detailText) {
          setDigestPreviewByWf((prev) => ({ ...prev, [targetWfId]: detailText }));
        }

        setStepStatesByWf((prev) => {
          const prevWf = prev[targetWfId] ?? {};
          const nextWf: Record<string, DagStepRunState> = {
            ...prevWf,
            [targetNode]: {
              status: evt.status === 'failed' ? 'failed' : 'completed',
              ms: evt.ms,
              mode: evt.mode,
              detail: detailText,
            },
          };
          if (evt.status !== 'failed') {
            orderedNodes.forEach((candidate) => {
              if (candidate.dependsOn.includes(targetNode)) {
                const allParentsDone = candidate.dependsOn.every(
                  (dep) => nextWf[dep]?.status === 'completed',
                );
                if (
                  allParentsDone &&
                  (!nextWf[candidate.node] || nextWf[candidate.node].status === 'idle')
                ) {
                  nextWf[candidate.node] = { status: 'running' };
                }
              }
            });
          }
          return { ...prev, [targetWfId]: nextWf };
        });
      };

      while (true) {
        const { value, done } = await reader.read();
        buffer += value
          ? decoder.decode(value, { stream: !done })
          : decoder.decode();
        buffer = buffer.replace(/\r\n/g, '\n');

        let boundary = buffer.indexOf('\n\n');
        while (boundary !== -1) {
          const rawBlock = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const payload = rawBlock
            .split('\n')
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).trimStart())
            .join('\n')
            .trim();

          if (payload === '[DONE]') {
            sawDone = true;
            break;
          }
          if (payload) {
            const rawParsed = JSON.parse(payload) as Record<string, unknown>;
            if (
              !rawParsed ||
              typeof rawParsed !== 'object' ||
              Array.isArray(rawParsed) ||
              rawParsed.type === 'error' ||
              typeof rawParsed.errorText === 'string' ||
              typeof rawParsed.error === 'string' ||
              typeof rawParsed.node !== 'string' ||
              rawParsed.node.trim().length === 0
            ) {
              const errMsg =
                (typeof rawParsed?.errorText === 'string' && rawParsed.errorText) ||
                (typeof rawParsed?.error === 'string' && rawParsed.error) ||
                'Workflow dry run returned an invalid step frame.';
              throw new Error(errMsg);
            }
            applyEvent(rawParsed as unknown as WorkflowRunStepEvent);
          }
          boundary = buffer.indexOf('\n\n');
        }

        if (sawDone || done) {
          break;
        }
      }

      if (!sawDone || buffer.trim().length > 0) {
        throw new Error('Workflow dry run stream ended prematurely before [DONE].');
      }

      setStepStatesByWf((prev) => {
        const current = prev[targetWfId];
        if (!current) {
          return prev;
        }
        const cleaned: Record<string, DagStepRunState> = { ...current };
        for (const key of Object.keys(cleaned)) {
          if (cleaned[key]?.status === 'running') {
            cleaned[key] = { ...cleaned[key], status: 'idle' };
          }
        }
        return { ...prev, [targetWfId]: cleaned };
      });
    } catch (err) {
      if (controller.signal.aborted) {
        return;
      }
      setStepStatesByWf((prev) => {
        const current = prev[targetWfId] ?? {};
        const nextWf: Record<string, DagStepRunState> = { ...current };
        for (const key of Object.keys(nextWf)) {
          if (nextWf[key]?.status === 'running') {
            nextWf[key] = { ...nextWf[key], status: 'failed' };
          }
        }
        return { ...prev, [targetWfId]: nextWf };
      });
      setDryRunError(
        err instanceof Error ? err.message : 'Workflow dry run encountered an error.',
      );
    } finally {
      if (dryRunAbortRef.current === controller) {
        dryRunAbortRef.current = null;
      }
      if (!controller.signal.aborted) {
        setRunningDryRun(false);
      }
    }
  };

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
        id="workflows-drawer"
        className="inspector-drawer workflows-drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="workflows-drawer-title"
        data-testid="workflows-drawer"
      >
        <div className="inspector-header">
          <div>
            <div className="tool-card-eyebrow">GENERATED WORKFLOWS &amp; DAG</div>
            <h2 id="workflows-drawer-title" className="inspector-title">
              Compiled Guardrail Workflows
            </h2>
          </div>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={onClose}
            aria-label="Close workflows flyout"
          >
            Close
          </button>
        </div>

        <div className="inspector-body">
          {workflows.length === 0 ? (
            <section
              className="workflows-empty-state"
              data-testid="workflows-empty-state"
            >
              <h3 className="inspector-section-title">No workflows compiled yet</h3>
              <p className="inspector-note">
                Ask Relay to compile a pacing or hygiene guardrail in chat, or launch
                the starter guardrail below. Every compiled workflow is saved in browser
                localStorage with its name and 6-step fan-out/fan-in DAG.
              </p>
              <div>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => {
                    onClose();
                    onCompileSample();
                  }}
                  data-testid="workflows-compile-sample-button"
                >
                  Compile daily pacing guardrail
                </button>
              </div>
            </section>
          ) : (
            <>
              <section className="inspector-section">
                <div className="workflows-list-header">
                  <h3 className="inspector-section-title">
                    Select a generated workflow
                  </h3>
                  <span className="pill tabular-nums">
                    {workflows.length === 1
                      ? '1 saved in browser'
                      : `${workflows.length} saved in browser`}
                  </span>
                </div>

                <div
                  className="workflow-selector-list"
                  role="listbox"
                  aria-label="Generated workflows"
                >
                  {workflows.map((record) => {
                    const wf = record.workflow;
                    const isSelected =
                      activeRecord?.workflow.workflowId === wf.workflowId;
                    const displayName = getWorkflowDisplayName(record);

                    return (
                      <div
                        key={wf.workflowId}
                        role="option"
                        aria-selected={isSelected}
                        className={`workflow-selector-item${
                          isSelected ? ' workflow-selector-item-active' : ''
                        }`}
                        data-testid={`workflow-selector-${wf.workflowId}`}
                      >
                        <button
                          type="button"
                          className="workflow-selector-main"
                          onClick={() => {
                            setDryRunError(null);
                            setCopiedCode(false);
                            onSelectWorkflow(wf.workflowId);
                          }}
                        >
                          <div className="workflow-selector-title-row">
                            <span className="workflow-selector-name">
                              {displayName}
                            </span>
                            <span className="pill mono-text">{wf.workflowId}</span>
                          </div>
                          <div className="workflow-selector-meta tabular-nums">
                            <span>
                              {(wf.channels ?? [])
                                .map((c) => CHANNEL_LABELS[c] ?? c)
                                .join(', ')}
                            </span>
                            <span>·</span>
                            <span>{`Threshold ${wf.threshold}%`}</span>
                            {wf.schedule ? (
                              <>
                                <span>·</span>
                                <span className="mono-text">{wf.schedule}</span>
                              </>
                            ) : null}
                          </div>
                        </button>

                        <div className="workflow-selector-actions">
                          <button
                            type="button"
                            className="btn-ghost-mini"
                            onClick={() => handleStartRename(record)}
                            aria-label={`Rename ${displayName}`}
                          >
                            Rename
                          </button>
                          <button
                            type="button"
                            className="btn-ghost-mini"
                            onClick={() => onRemoveWorkflow(wf.workflowId)}
                            aria-label={`Remove ${displayName}`}
                          >
                            Remove
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </section>

              {activeRecord && activeWorkflow ? (
                <section className="inspector-section inspector-reset-section">
                  <div className="workflow-detail-header">
                    <div className="workflow-detail-title-wrap">
                      {editingId === activeWorkflow.workflowId ? (
                        <form
                          className="workflow-rename-form"
                          onSubmit={(e) => {
                            e.preventDefault();
                            handleCommitRename(activeWorkflow.workflowId);
                          }}
                        >
                          <input
                            type="text"
                            className="workflow-rename-input"
                            value={draftName}
                            maxLength={80}
                            onChange={(e) => setDraftName(e.target.value)}
                            aria-label="Workflow name"
                            autoFocus
                          />
                          <button type="submit" className="btn btn-primary">
                            Save
                          </button>
                          <button
                            type="button"
                            className="btn btn-secondary"
                            onClick={() => setEditingId(null)}
                          >
                            Cancel
                          </button>
                        </form>
                      ) : (
                        <>
                          <div className="tool-card-eyebrow">SELECTED WORKFLOW DAG</div>
                          <h3 className="workflow-detail-title">
                            {getWorkflowDisplayName(activeRecord)}
                          </h3>
                        </>
                      )}
                    </div>

                    <div className="kpi-cluster tabular-nums">
                      <span
                        className="pill"
                        title="Generated Temporal Python SDK code is a display-only Option A artifact; dry runs execute in-app via FastAPI SSE and Vercel Sandbox."
                      >
                        In-app SSE dry run · Temporal code preview
                      </span>
                      {activeWorkflow.schedule ? (
                        <span className="pill mono-text">
                          {activeWorkflow.schedule}
                        </span>
                      ) : null}
                      <span className="pill">{`Threshold: ${activeWorkflow.threshold}%`}</span>
                    </div>
                  </div>

                  <div className="channel-pill-row">
                    {(activeWorkflow.channels ?? []).map((ch) => (
                      <span key={ch} className="pill channel-pill">
                        {CHANNEL_LABELS[ch] ?? ch}
                      </span>
                    ))}
                  </div>

                  <WorkflowDagView
                    key={activeWorkflow.workflowId}
                    workflow={activeWorkflow}
                    stepStates={activeStepStates}
                  />

                  <div className="card-actions-inline">
                    <button
                      type="button"
                      className="btn btn-primary"
                      disabled={runningDryRun}
                      onClick={() => void handleRunDryRun()}
                      data-testid="drawer-workflow-test-run-button"
                    >
                      {runningDryRun ? 'Running dry run…' : 'Test run'}
                    </button>
                    <button
                      type="button"
                      className="btn btn-secondary"
                      onClick={() =>
                        onShareWorkflow(resolveValidWorkflowShareSlug(activeWorkflow))
                      }
                      data-testid="drawer-workflow-share-button"
                    >
                      Share playbook
                    </button>
                  </div>

                  {activeDigest ? (
                    <div
                      className="digest-preview-box"
                      data-testid="drawer-workflow-digest-preview"
                    >
                      <div className="digest-preview-header">
                        Digest preview (rendered in UI only — nothing sent to Slack or
                        Sheets)
                      </div>
                      <pre className="digest-preview-text">{activeDigest}</pre>
                    </div>
                  ) : null}

                  {dryRunError ? (
                    <p className="inline-validation-error" role="alert">
                      {dryRunError}
                    </p>
                  ) : null}

                  <details className="technical-drawer">
                    <summary>
                      Temporal Python workflow code (display-only Option A preview)
                    </summary>
                    <div className="temporal-drawer-body">
                      <div className="adapter-header-row">
                        <p className="temporal-disclaimer">
                          Generated `temporalio` SDK source for Fieldstone Kubernetes +
                          Temporal workers. Relay Studio does not run a live Temporal
                          cluster; dry runs execute in-process and in Vercel Sandbox.
                        </p>
                        <button
                          type="button"
                          className="btn btn-secondary"
                          onClick={() =>
                            void handleCopyTemporalCode(activeWorkflow.temporalCode)
                          }
                        >
                          {copiedCode ? '✓ Copied!' : 'Copy code'}
                        </button>
                      </div>
                      <pre className="code-block">
                        <code>{activeWorkflow.temporalCode}</code>
                      </pre>
                    </div>
                  </details>
                </section>
              ) : null}
            </>
          )}
        </div>
      </aside>
    </div>
  );
}
