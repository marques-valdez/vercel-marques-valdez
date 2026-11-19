'use client';

/**
 * 4-stage fan-out/fan-in visual workflow DAG renderer.
 *
 * Renders the 6 workflow steps as an interactive 4-column execution graph
 * (Snapshot -> 3 parallel checks -> Alert rule -> Morning brief) with live
 * SVG edge coloring during SSE dry runs and per-node detail inspection.
 */

import React, { useState } from 'react';
import { resolveWorkflowDagSteps, type ResolvedDagStep } from '@/lib/workflow-store';
import type { WorkflowToolOutput } from '@/lib/types';

export interface DagStepRunState {
  status: 'idle' | 'running' | 'completed' | 'failed';
  ms?: number;
  mode?: string;
  detail?: string;
}

interface WorkflowDagViewProps {
  workflow: WorkflowToolOutput;
  stepStates?: Record<string, DagStepRunState>;
}

function edgeStrokeColor(
  fromStatus: DagStepRunState['status'],
  toStatus: DagStepRunState['status'],
): string {
  if (fromStatus === 'failed' || toStatus === 'failed') {
    return '#D93025';
  }
  if (toStatus === 'running') {
    return '#0070F3';
  }
  if (fromStatus === 'completed' && toStatus === 'completed') {
    return '#0E8A5F';
  }
  if (fromStatus === 'completed') {
    return '#0070F3';
  }
  return '#CFCFCF';
}

function formatStepStatusLabel(runInfo?: DagStepRunState): string {
  const status = runInfo?.status ?? 'idle';
  if (status === 'running') {
    return 'Checking…';
  }
  if (status === 'failed') {
    return 'Needs review';
  }
  if (status === 'completed') {
    return '✓ Checked';
  }
  return 'Included';
}

function formatFlowOrderLabel(step: ResolvedDagStep): string {
  if (step.stage === 0) {
    return 'Step 1 of 6 · Runs first';
  }
  if (step.stage === 1) {
    return 'Runs in parallel after Step 1';
  }
  if (step.stage === 2) {
    return 'Combines link, UTM & ROAS checks (Steps 2–4)';
  }
  return 'Final step · Runs after alert rule check';
}

export function WorkflowDagView({
  workflow,
  stepStates = {},
}: WorkflowDagViewProps) {
  const steps = resolveWorkflowDagSteps(workflow);
  const [selectedNodeName, setSelectedNodeName] = useState<string>(
    steps[0]?.node ?? 'Pull active campaigns & budgets',
  );

  const entryStep = steps[0];
  const parallelSteps = steps.slice(1, 4);
  const gateStep = steps[4];
  const digestStep = steps[5];

  const activeStep =
    steps.find((s) => s.node === selectedNodeName) ?? steps[0];
  const activeRun = activeStep ? stepStates[activeStep.node] : undefined;

  const statusOf = (nodeName?: string): DagStepRunState['status'] =>
    (nodeName && stepStates[nodeName]?.status) || 'idle';

  const renderNodeCard = (step: ResolvedDagStep) => {
    const runInfo = stepStates[step.node];
    const status = runInfo?.status ?? 'idle';
    const isSelected = activeStep?.node === step.node;

    return (
      <button
        key={step.node}
        type="button"
        onClick={() => setSelectedNodeName(step.node)}
        className={`workflow-dag-node workflow-dag-node-${status}${
          isSelected ? ' workflow-dag-node-selected' : ''
        }`}
        data-testid={`dag-node-${step.index + 1}`}
        data-dag-node={step.node}
        aria-pressed={isSelected}
      >
        <div className="workflow-dag-node-top">
          <span className="workflow-step-index">{step.index + 1}</span>
          <span className="workflow-dag-node-timing">
            {formatStepStatusLabel(runInfo)}
          </span>
        </div>
        <div className="workflow-dag-node-title">{step.node}</div>
      </button>
    );
  };

  const fanOutYTargets = [40, 120, 200];

  return (
    <div className="workflow-dag-wrapper" data-testid="workflow-dag-view">
      <div className="workflow-dag-stage-headers" aria-hidden="true">
        <span>1. Pull Live Ads</span>
        <span />
        <span>2. Audit Links, Tracking &amp; ROAS</span>
        <span />
        <span>3. Spend Alert Rule</span>
        <span />
        <span>4. Morning Brief</span>
      </div>

      <div
        className="workflow-dag-canvas"
        role="group"
        aria-label={`Automated check flow for ${workflow.title}`}
      >
        {/* Stage 1: Entry */}
        <div className="workflow-dag-col workflow-dag-col-center">
          {entryStep ? renderNodeCard(entryStep) : null}
        </div>

        {/* Connector 1: 1 -> 3 Fan-out */}
        <svg
          className="workflow-dag-connector"
          viewBox="0 0 48 240"
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          {parallelSteps.map((targetStep, idx) => {
            const targetY = fanOutYTargets[idx] ?? 120;
            const stroke = edgeStrokeColor(
              statusOf(entryStep?.node),
              statusOf(targetStep.node),
            );
            return (
              <g
                key={`edge-1-${targetStep.node}`}
                data-dag-edge={`${entryStep?.node ?? ''}->${targetStep.node}`}
              >
                <path
                  d={`M 0 120 C 22 120, 24 ${targetY}, 44 ${targetY}`}
                  fill="none"
                  stroke={stroke}
                  strokeWidth="2"
                />
                <polygon
                  points={`48,${targetY} 41,${targetY - 4} 41,${targetY + 4}`}
                  fill={stroke}
                />
              </g>
            );
          })}
        </svg>

        {/* Stage 2: 3 Parallel Branches */}
        <div className="workflow-dag-col workflow-dag-col-stack">
          {parallelSteps.map((step) => renderNodeCard(step))}
        </div>

        {/* Connector 2: 3 -> 1 Fan-in */}
        <svg
          className="workflow-dag-connector"
          viewBox="0 0 48 240"
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          {parallelSteps.map((sourceStep, idx) => {
            const sourceY = fanOutYTargets[idx] ?? 120;
            const stroke = edgeStrokeColor(
              statusOf(sourceStep.node),
              statusOf(gateStep?.node),
            );
            return (
              <path
                key={`edge-2-${sourceStep.node}`}
                data-dag-edge={`${sourceStep.node}->${gateStep?.node ?? ''}`}
                d={`M 0 ${sourceY} C 24 ${sourceY}, 26 120, 44 120`}
                fill="none"
                stroke={stroke}
                strokeWidth="2"
              />
            );
          })}
          {(() => {
            const gateStroke = edgeStrokeColor(
              parallelSteps.some((s) => statusOf(s.node) === 'failed')
                ? 'failed'
                : parallelSteps.every((s) => statusOf(s.node) === 'completed')
                  ? 'completed'
                  : 'idle',
              statusOf(gateStep?.node),
            );
            return <polygon points="48,120 41,116 41,124" fill={gateStroke} />;
          })()}
        </svg>

        {/* Stage 3: Spend Alert Rule */}
        <div className="workflow-dag-col workflow-dag-col-center">
          {gateStep ? renderNodeCard(gateStep) : null}
        </div>

        {/* Connector 3: Rule -> Brief */}
        <svg
          className="workflow-dag-connector workflow-dag-connector-short"
          viewBox="0 0 36 240"
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          {(() => {
            const stroke = edgeStrokeColor(
              statusOf(gateStep?.node),
              statusOf(digestStep?.node),
            );
            return (
              <g data-dag-edge={`${gateStep?.node ?? ''}->${digestStep?.node ?? ''}`}>
                <line
                  x1="0"
                  y1="120"
                  x2="31"
                  y2="120"
                  stroke={stroke}
                  strokeWidth="2"
                />
                <polygon points="36,120 29,116 29,124" fill={stroke} />
              </g>
            );
          })()}
        </svg>

        {/* Stage 4: Morning Brief */}
        <div className="workflow-dag-col workflow-dag-col-center">
          {digestStep ? renderNodeCard(digestStep) : null}
        </div>
      </div>

      {activeStep ? (
        <div className="workflow-dag-detail" data-testid="workflow-dag-step-detail">
          <div className="workflow-dag-detail-header">
            <div className="workflow-step-title-group">
              <span className="workflow-step-index">{activeStep.index + 1}</span>
              <strong className="workflow-step-name">{activeStep.node}</strong>
            </div>
            <span className="workflow-dag-deps">
              {formatFlowOrderLabel(activeStep)}
            </span>
          </div>
          <p className="workflow-step-desc">
            {activeRun?.detail || activeStep.description}
          </p>
        </div>
      ) : null}
    </div>
  );
}
