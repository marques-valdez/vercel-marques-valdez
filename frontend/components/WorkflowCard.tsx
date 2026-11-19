'use client';

/**
 * Typed tool card for `compile_workflow`.
 *
 * Streams live 6-step dry runs directly from `POST /api/agent/workflow/run`
 * over SSE (with unmount `AbortController` cleanup and chunk-boundary framing)
 * and links into both the full-screen `WorkflowsDrawer` DAG visualizer and the
 * `ShareModal` playbook URL builder.
 */

import React, { useEffect, useRef, useState } from 'react';
import { CHANNEL_LABELS } from '@/lib/playbooks';
import { readStoredMutations } from '@/lib/twin-client';
import {
  formatScheduleForMarketer,
  normalizeWorkflowNodeName,
  resolveValidWorkflowShareSlug,
  resolveWorkflowDagSteps,
} from '@/lib/workflow-store';
import type { WorkflowRunStepEvent, WorkflowToolOutput } from '@/lib/types';

interface WorkflowCardProps {
  state: 'skeleton' | 'completed' | 'error';
  output?: WorkflowToolOutput;
  errorText?: string;
  onShare: (slug: string) => void;
  onOpenInDrawer?: (workflowId: string) => void;
  onRetry: () => void;
}

interface StepRunState {
  status: 'idle' | 'running' | 'completed' | 'failed';
  ms?: number;
  mode?: string;
  detail?: string;
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

export function WorkflowCard({
  state,
  output,
  errorText,
  onShare,
  onOpenInDrawer,
  onRetry,
}: WorkflowCardProps) {
  const [runningDryRun, setRunningDryRun] = useState(false);
  const [dryRunError, setDryRunError] = useState<string | null>(null);
  const [digestPreview, setDigestPreview] = useState<string | null>(null);
  const [stepStates, setStepStates] = useState<Record<string, StepRunState>>({});
  const dryRunAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    return () => {
      dryRunAbortRef.current?.abort();
    };
  }, []);

  if (state === 'skeleton') {
    return (
      <section
        className="tool-card accent-blue"
        aria-busy="true"
        aria-label="Setting up recurring campaign check"
      >
        <div className="tool-card-eyebrow">RECURRING CAMPAIGN CHECK</div>
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
            <div className="tool-card-eyebrow error-eyebrow">WORKFLOW SETUP ERROR</div>
            <p className="error-card-body">
              {errorText || 'Unable to set up the recurring campaign check.'}
            </p>
          </div>
          <button type="button" className="btn btn-secondary" onClick={onRetry}>
            Retry
          </button>
        </div>
      </section>
    );
  }

  const orderedNodes = resolveWorkflowDagSteps(output);

  const handleTestRun = async () => {
    dryRunAbortRef.current?.abort();
    const controller = new AbortController();
    dryRunAbortRef.current = controller;

    setRunningDryRun(true);
    setDryRunError(null);
    setDigestPreview(null);

    const initialMap: Record<string, StepRunState> = {};
    orderedNodes.forEach((step, idx) => {
      initialMap[step.node] = { status: idx === 0 ? 'running' : 'idle' };
    });
    setStepStates(initialMap);

    try {
      const response = await fetch('/api/agent/workflows/run', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        signal: controller.signal,
        body: JSON.stringify({
          workflow: output,
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
        if (resolvedIdx === orderedNodes.length - 1 && detailText) {
          setDigestPreview(detailText);
        }

        setStepStates((prev) => {
          const next: Record<string, StepRunState> = {
            ...prev,
            [targetNode]: {
              status: evt.status === 'failed' ? 'failed' : 'completed',
              ms: evt.ms,
              mode: evt.mode,
              detail: detailText,
            },
          };
          const nextIdx = resolvedIdx + 1;
          if (
            evt.status !== 'failed' &&
            nextIdx >= 0 &&
            nextIdx < orderedNodes.length
          ) {
            const upcomingNode = orderedNodes[nextIdx].node;
            if (!next[upcomingNode] || next[upcomingNode].status === 'idle') {
              next[upcomingNode] = { status: 'running' };
            }
          }
          return next;
        });
      };

      while (true) {
        const { value, done } = await reader.read();
        buffer += value ? decoder.decode(value, { stream: !done }) : decoder.decode();
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
        throw new Error('Workflow dry run stream ended prematurely before [DONE].');
      }

      setStepStates((prev) => {
        let changed = false;
        const next: Record<string, StepRunState> = { ...prev };
        for (const key of Object.keys(next)) {
          if (next[key]?.status === 'running') {
            next[key] = { ...next[key], status: 'idle' };
            changed = true;
          }
        }
        return changed ? next : prev;
      });
    } catch (err) {
      if (controller.signal.aborted) {
        return;
      }
      setStepStates((prev) => {
        const next: Record<string, StepRunState> = { ...prev };
        for (const key of Object.keys(next)) {
          if (next[key]?.status === 'running') {
            next[key] = { ...next[key], status: 'failed' };
          }
        }
        return next;
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

  const shareSlug = resolveValidWorkflowShareSlug(output);

  return (
    <section
      className="tool-card accent-blue"
      data-testid="workflow-card"
      aria-label="Scheduled campaign check"
    >
      <div className="tool-card-header">
        <div>
          <div className="tool-card-eyebrow">RECURRING CAMPAIGN CHECK</div>
          <h3 className="tool-card-title">{output.title}</h3>
        </div>
        <div className="kpi-cluster tabular-nums">
          <span className="pill">{formatScheduleForMarketer(output.schedule)}</span>
          <span className="pill">
            {`Alert if ≥ ${output.threshold}% spend at risk`}
          </span>
        </div>
      </div>

      <div className="channel-pill-row">
        {(output.channels ?? []).map((ch) => (
          <span key={ch} className="pill channel-pill">
            {CHANNEL_LABELS[ch] ?? ch}
          </span>
        ))}
      </div>

      <ol className="workflow-step-list tabular-nums">
        {orderedNodes.map((step, index) => {
          const runInfo = stepStates[step.node];
          const status = runInfo?.status ?? 'idle';
          return (
            <li
              key={step.node}
              className={`workflow-step-item workflow-step-${status}`}
              data-step-node={step.node}
            >
              <div className="workflow-step-top">
                <div className="workflow-step-title-group">
                  <span className="workflow-step-index">{index + 1}</span>
                  <strong className="workflow-step-name">{step.node}</strong>
                </div>
                <div className="workflow-step-timing">
                  {status === 'running'
                    ? 'Checking…'
                    : status === 'failed'
                      ? 'Needs review'
                      : status === 'completed'
                        ? '✓ Checked'
                        : 'Included'}
                </div>
              </div>
              {runInfo?.detail ? (
                <p className="workflow-step-detail">{runInfo.detail}</p>
              ) : step.description ? (
                <p className="workflow-step-desc">{step.description}</p>
              ) : null}
            </li>
          );
        })}
      </ol>

      {digestPreview ? (
        <div className="digest-preview-box" data-testid="workflow-digest-preview">
          <div className="digest-preview-header">
            Sample morning Slack &amp; Google Sheets brief
          </div>
          <pre className="digest-preview-text">{digestPreview}</pre>
        </div>
      ) : null}

      {dryRunError ? (
        <p className="inline-validation-error" role="alert">
          {dryRunError}
        </p>
      ) : null}

      <div className="tool-card-footer">
        <div className="card-actions-inline">
          <button
            type="button"
            className="btn btn-primary"
            disabled={runningDryRun}
            onClick={() => void handleTestRun()}
            data-testid="workflow-test-run-button"
          >
            {runningDryRun ? 'Checking campaigns…' : 'Preview check now'}
          </button>
          {onOpenInDrawer ? (
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => onOpenInDrawer(output.workflowId)}
              data-testid="workflow-open-dag-button"
            >
              Open visual flow
            </button>
          ) : null}
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => onShare(shareSlug)}
            data-testid="workflow-share-button"
          >
            Share with team
          </button>
        </div>
      </div>
    </section>
  );
}
