'use client';

/**
 * Slide-over Workflows flyout for managing saved recurring checks.
 *
 * Reads persisted workflows from `localStorage`, lets marketers rename or
 * remove automations, inspect the 4-stage visual DAG (`WorkflowDagView`), run
 * live SSE dry runs against the current Digital Twin state, or share a zero-DB
 * playbook link.
 */

import React, { useEffect, useRef, useState } from 'react';
import { CHANNEL_LABELS } from '@/lib/playbooks';
import { readStoredMutations } from '@/lib/twin-client';
import {
  formatScheduleForMarketer,
  getWorkflowDisplayName,
  normalizeWorkflowNodeName,
  resolveValidWorkflowShareSlug,
  resolveWorkflowDagSteps,
} from '@/lib/workflow-store';
import type {
  DerivedTwinState,
  SavedWorkflowRecord,
  WorkflowDigestSummary,
  WorkflowRunStepEvent,
} from '@/lib/types';
import { WorkflowDagView, type DagStepRunState } from './WorkflowDagView';
import { WorkflowNextSteps } from './WorkflowNextSteps';
import { WorkflowVisualSummary, resolveChannelTone } from './charts';

interface WorkflowsDrawerProps {
  isOpen: boolean;
  workflows: SavedWorkflowRecord[];
  selectedWorkflowId: string | null;
  twinState?: DerivedTwinState | null;
  isStreaming?: boolean;
  onSelectWorkflow: (workflowId: string) => void;
  onRenameWorkflow: (workflowId: string, nextName: string) => void;
  onRemoveWorkflow: (workflowId: string) => void;
  onShareWorkflow: (slug: string) => void;
  onRunNextStepPrompt?: (prompt: string, tierHint: 'fast' | 'reasoning') => void;
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
  twinState = null,
  isStreaming = false,
  onSelectWorkflow,
  onRenameWorkflow,
  onRemoveWorkflow,
  onShareWorkflow,
  onRunNextStepPrompt,
  onCompileSample,
  onClose,
}: WorkflowsDrawerProps) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState<string>('');

  const [runningDryRun, setRunningDryRun] = useState(false);
  const [dryRunError, setDryRunError] = useState<string | null>(null);
  const [digestPreviewByWf, setDigestPreviewByWf] = useState<Record<string, string>>(
    {},
  );
  const [digestSummaryByWf, setDigestSummaryByWf] = useState<
    Record<string, WorkflowDigestSummary>
  >({});
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
  const activeDigestSummary = activeWfId
    ? digestSummaryByWf[activeWfId] ?? null
    : null;

  const handleStartRename = (record: SavedWorkflowRecord) => {
    setEditingId(record.workflow.workflowId);
    setDraftName(getWorkflowDisplayName(record));
  };

  const handleCommitRename = (workflowId: string) => {
    onRenameWorkflow(workflowId, draftName);
    setEditingId(null);
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
        throw new Error(`Preview check failed (${response.status})`);
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
        const normalizedEvtNode = normalizeWorkflowNodeName(evt.node);
        const matchedIndex = orderedNodes.findIndex(
          (s) => s.node === normalizedEvtNode,
        );
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
            : normalizedEvtNode;

        const detailText = formatDetail(evt.detail);
        if (resolvedIdx === orderedNodes.length - 1) {
          if (detailText) {
            setDigestPreviewByWf((prev) => ({ ...prev, [targetWfId]: detailText }));
          }
          if (evt.summary && typeof evt.summary === 'object') {
            setDigestSummaryByWf((prev) => ({
              ...prev,
              [targetWfId]: evt.summary as unknown as WorkflowDigestSummary,
            }));
          }
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
                'Preview check returned an unexpected step response.';
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
        throw new Error('Preview stream ended prematurely before [DONE].');
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
        err instanceof Error ? err.message : 'Preview check encountered an error.',
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
            <div className="tool-card-eyebrow">RECURRING CAMPAIGN CHECKS</div>
            <h2 id="workflows-drawer-title" className="inspector-title">
              Saved Campaign Workflows
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
              <h3 className="inspector-section-title">No recurring checks saved yet</h3>
              <p className="inspector-note">
                Ask Relay in chat to set up a daily budget pacing or broken-link check,
                or start with the morning check below. Each check you create appears
                here with its visual step-by-step flow.
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
                  Set up daily pacing &amp; link check
                </button>
              </div>
            </section>
          ) : (
            <>
              <section className="inspector-section">
                <div className="workflows-list-header">
                  <h3 className="inspector-section-title">Your saved checks</h3>
                  <span className="pill tabular-nums">
                    {workflows.length === 1
                      ? '1 active check'
                      : `${workflows.length} active checks`}
                  </span>
                </div>

                <div
                  className="workflow-selector-list"
                  role="listbox"
                  aria-label="Saved campaign workflows"
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
                            onSelectWorkflow(wf.workflowId);
                          }}
                        >
                          <div className="workflow-selector-title-row">
                            <span className="workflow-selector-name">
                              {displayName}
                            </span>
                          </div>
                          <div className="workflow-selector-meta tabular-nums">
                            <span>
                              {(wf.channels ?? [])
                                .map((c) => CHANNEL_LABELS[c] ?? c)
                                .join(', ')}
                            </span>
                            <span>·</span>
                            <span>{formatScheduleForMarketer(wf.schedule)}</span>
                            <span>·</span>
                            <span>{`Alert ≥ ${wf.threshold}% at risk`}</span>
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
                          <div className="tool-card-eyebrow">AUTOMATION FLOW</div>
                          <h3 className="workflow-detail-title">
                            {getWorkflowDisplayName(activeRecord)}
                          </h3>
                        </>
                      )}
                    </div>

                    <div className="kpi-cluster tabular-nums">
                      <span className="pill">
                        {formatScheduleForMarketer(activeWorkflow.schedule)}
                      </span>
                      <span className="pill">
                        {`Alert if ≥ ${activeWorkflow.threshold}% of daily spend at risk`}
                      </span>
                    </div>
                  </div>

                  <div className="channel-pill-row">
                    {(activeWorkflow.channels ?? []).map((ch) => {
                      const tone = resolveChannelTone(ch);
                      return (
                        <span key={ch} className="pill channel-pill">
                          <span
                            className={`channel-dot channel-dot-${tone}`}
                            aria-hidden="true"
                          />
                          <span>{CHANNEL_LABELS[ch] ?? ch}</span>
                        </span>
                      );
                    })}
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
                      {runningDryRun ? 'Checking campaigns…' : 'Preview check now'}
                    </button>
                    <button
                      type="button"
                      className="btn btn-secondary"
                      onClick={() =>
                        onShareWorkflow(resolveValidWorkflowShareSlug(activeWorkflow))
                      }
                      data-testid="drawer-workflow-share-button"
                    >
                      Share with team
                    </button>
                  </div>

                  {activeDigest ? (
                    <WorkflowVisualSummary
                      digestPreview={activeDigest}
                      digestSummary={activeDigestSummary}
                      channels={activeWorkflow.channels ?? []}
                      threshold={activeWorkflow.threshold}
                      twinState={twinState}
                      testId="drawer-workflow-digest-preview"
                    />
                  ) : null}

                  {onRunNextStepPrompt ? (
                    <WorkflowNextSteps
                      channels={activeWorkflow.channels ?? []}
                      digestSummary={activeDigestSummary}
                      twinState={twinState}
                      disabled={Boolean(isStreaming || runningDryRun)}
                      compact={!activeDigestSummary}
                      onRunPrompt={(prompt, tierHint) => {
                        onClose();
                        onRunNextStepPrompt(prompt, tierHint);
                      }}
                    />
                  ) : null}

                  {dryRunError ? (
                    <p className="inline-validation-error" role="alert">
                      {dryRunError}
                    </p>
                  ) : null}
                </section>
              ) : null}
            </>
          )}
        </div>
      </aside>
    </div>
  );
}
