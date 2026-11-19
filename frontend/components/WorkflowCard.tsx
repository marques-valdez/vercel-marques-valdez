'use client';

import React, { useEffect, useRef, useState } from 'react';
import { CANONICAL_CHANNELS, CHANNEL_LABELS, WORKFLOW_NODE_NAMES } from '@/lib/playbooks';
import { encodePlaybookSlug, PlaybookTemplateSchema, resolvePlaybookSlug } from '@/lib/share';
import { readStoredMutations } from '@/lib/twin-client';
import type {
  ChannelId,
  WorkflowRunStepEvent,
  WorkflowToolOutput,
} from '@/lib/types';

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

function resolveValidShareSlug(output: WorkflowToolOutput): string {
  if (output.slug && resolvePlaybookSlug(output.slug)) {
    return output.slug;
  }
  const parsedTemplate = PlaybookTemplateSchema.safeParse(output.template);
  const template = parsedTemplate.success
    ? parsedTemplate.data
    : 'daily-pacing-guardrail';
  const validChannels: ChannelId[] = Array.isArray(output.channels)
    ? CANONICAL_CHANNELS.filter((c) => output.channels.includes(c))
    : [];
  const rawThreshold = Number(output.threshold);
  const clampedThreshold = Number.isFinite(rawThreshold)
    ? Math.min(100, Math.max(1, Math.round(rawThreshold)))
    : 15;

  return encodePlaybookSlug({
    template,
    channels:
      validChannels.length > 0
        ? validChannels
        : ['google_ads', 'linkedin_ads', 'meta_ads'],
    threshold: clampedThreshold,
  });
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
        aria-label="Compiling guardrail workflow"
      >
        <div className="tool-card-eyebrow">GUARDRAIL WORKFLOW</div>
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
            <div className="tool-card-eyebrow error-eyebrow">WORKFLOW TOOL ERROR</div>
            <p className="error-card-body">
              {errorText || 'Failed to compile scheduled workflow.'}
            </p>
          </div>
          <button type="button" className="btn btn-secondary" onClick={onRetry}>
            Retry
          </button>
        </div>
      </section>
    );
  }

  const orderedNodes = WORKFLOW_NODE_NAMES.map((canonicalNode, idx) => {
    const matched = output.steps?.find((s) => s.node === canonicalNode) ?? output.steps?.[idx];
    return {
      node: canonicalNode,
      description: matched?.description || '',
    };
  });

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

  const shareSlug = resolveValidShareSlug(output);

  return (
    <section
      className="tool-card accent-blue"
      data-testid="workflow-card"
      aria-label="Compiled six-node workflow"
    >
      <div className="tool-card-header">
        <div>
          <div className="tool-card-eyebrow">COMPILED GUARDRAIL WORKFLOW</div>
          <h3 className="tool-card-title">{output.title}</h3>
        </div>
        <div className="kpi-cluster tabular-nums">
          {output.schedule ? <span className="pill mono-text">{output.schedule}</span> : null}
          <span className="pill">{`Threshold: ${output.threshold}%`}</span>
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
                  {runInfo?.mode === 'sandbox' ? (
                    <span className="pill channel-pill">Vercel Sandbox</span>
                  ) : runInfo?.mode === 'in-process' ? (
                    <span className="pill channel-pill">In-process fallback</span>
                  ) : null}
                </div>
                <div className="workflow-step-timing mono-text">
                  {status === 'running'
                    ? 'Running…'
                    : status === 'failed'
                      ? typeof runInfo?.ms === 'number'
                        ? `Failed · ${Math.round(runInfo.ms).toLocaleString('en-US')} ms`
                        : 'Failed'
                      : typeof runInfo?.ms === 'number'
                        ? `${Math.round(runInfo.ms).toLocaleString('en-US')} ms`
                        : 'Ready'}
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
            Digest preview (rendered in UI only — nothing sent to Slack or Sheets)
          </div>
          <pre className="digest-preview-text">{digestPreview}</pre>
        </div>
      ) : null}

      {dryRunError ? (
        <p className="inline-validation-error" role="alert">
          {dryRunError}
        </p>
      ) : null}

      <details className="technical-drawer">
        <summary>Temporal Python workflow code</summary>
        <div className="temporal-drawer-body">
          <p className="temporal-disclaimer">
            Generated for production. Not executed in this demo.
          </p>
          <pre className="code-block">
            <code>{output.temporalCode}</code>
          </pre>
        </div>
      </details>

      <div className="tool-card-footer">
        <div className="card-actions-inline">
          <button
            type="button"
            className="btn btn-primary"
            disabled={runningDryRun}
            onClick={() => void handleTestRun()}
            data-testid="workflow-test-run-button"
          >
            {runningDryRun ? 'Running dry run…' : 'Test run'}
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => onShare(shareSlug)}
            data-testid="workflow-share-button"
          >
            Share playbook
          </button>
          {onOpenInDrawer ? (
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => onOpenInDrawer(output.workflowId)}
              data-testid="workflow-open-dag-button"
            >
              View DAG in Workflows
            </button>
          ) : null}
        </div>
      </div>
    </section>
  );
}
