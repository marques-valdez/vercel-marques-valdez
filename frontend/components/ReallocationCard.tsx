'use client';

/**
 * Human-in-the-loop approval card for `propose_budget_reallocation`.
 *
 * Enforces the read-only proposal invariant: renders server-computed before
 * and after daily budgets and blended ROAS deltas, and mutates Digital Twin
 * state only when the operator explicitly clicks Approve (decision state is
 * isolated per `toolCallId` in `WorkspaceClient`).
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { Mutation, ReallocationToolOutput } from '@/lib/types';
import {
  BarRow,
  BeforeAfterBars,
  RangeBar,
  getChannelColorVar,
} from './charts';

interface ReallocationCardProps {
  state: 'skeleton' | 'completed' | 'error';
  output?: ReallocationToolOutput;
  errorText?: string;
  decision: 'approved' | 'declined' | null;
  disabled: boolean;
  architectMode?: boolean;
  getMutations?: () => Mutation[];
  onApprove: (output: ReallocationToolOutput) => Promise<void>;
  onDecline: (output: ReallocationToolOutput) => void;
  onRetry: () => void;
}

export function computeClientReallocationPreview(
  base: ReallocationToolOutput,
  requestedAmount: number,
): ReallocationToolOutput {
  const avail = Number.isFinite(base.before.fromDailyBudget)
    ? Math.max(0, base.before.fromDailyBudget)
    : 0;
  if (avail <= 0) {
    return base;
  }
  const safeRequested = Number.isFinite(requestedAmount)
    ? requestedAmount
    : base.amountPerDay;
  const clamped = Number(
    Math.max(1, Math.min(avail, safeRequested)).toFixed(2),
  );
  if (Math.abs(clamped - base.amountPerDay) < 0.005) {
    return base;
  }

  const totalBudget =
    Number.isFinite(base.before.totalDailyBudget) &&
    base.before.totalDailyBudget > 0
      ? base.before.totalDailyBudget
      : 1;
  const roasDiff = base.before.toRoas - base.before.fromRoas;
  const projectedBlended = Number(
    (base.blendedRoasBefore + (clamped * roasDiff) / totalBudget).toFixed(2),
  );

  return {
    ...base,
    amountPerDay: clamped,
    after: {
      ...base.after,
      fromDailyBudget: Number(
        Math.max(0, base.before.fromDailyBudget - clamped).toFixed(2),
      ),
      toDailyBudget: Number((base.before.toDailyBudget + clamped).toFixed(2)),
    },
    blendedRoasAfter: projectedBlended,
  };
}

function formatBudget(amount: number): string {
  const hasFraction = Math.abs(amount - Math.round(amount)) >= 0.005;
  return amount.toLocaleString('en-US', {
    minimumFractionDigits: hasFraction ? 2 : 0,
    maximumFractionDigits: 2,
  });
}

function formatSignedCurrency(amount: number): string {
  const sign = amount > 0 ? '+' : amount < 0 ? '-' : '';
  const abs = Math.abs(amount);
  return `${sign}$${abs.toLocaleString('en-US', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  })}`;
}

export function ReallocationCard({
  state,
  output,
  errorText,
  decision = null,
  disabled,
  architectMode = false,
  getMutations,
  onApprove,
  onDecline,
  onRetry,
}: ReallocationCardProps) {
  const [submitting, setSubmitting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [sliderAmount, setSliderAmount] = useState<number | null>(null);
  const [simulatedOutput, setSimulatedOutput] =
    useState<ReallocationToolOutput | null>(null);
  const [simUpdating, setSimUpdating] = useState(false);
  const [simError, setSimError] = useState<string | null>(null);
  const simAbortRef = useRef<AbortController | null>(null);
  const simTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const baseProposalId = output?.proposalId ?? '';
  const baseAmount = output?.amountPerDay ?? 0;

  useEffect(() => {
    setSliderAmount(null);
    setSimulatedOutput(null);
    setSimUpdating(false);
    setSimError(null);
  }, [baseProposalId, baseAmount]);

  useEffect(() => {
    return () => {
      if (simTimerRef.current) {
        clearTimeout(simTimerRef.current);
      }
      if (simAbortRef.current) {
        simAbortRef.current.abort();
      }
    };
  }, []);

  const effectiveAmount =
    sliderAmount !== null && output
      ? Math.max(1, Math.min(output.before.fromDailyBudget, sliderAmount))
      : baseAmount;

  const clientPreview = useMemo(() => {
    if (!output) {
      return undefined;
    }
    return computeClientReallocationPreview(output, effectiveAmount);
  }, [output, effectiveAmount]);

  const effectiveOutput = useMemo(() => {
    if (!clientPreview) {
      return undefined;
    }
    if (
      simulatedOutput &&
      Math.abs(simulatedOutput.amountPerDay - clientPreview.amountPerDay) < 0.01
    ) {
      return simulatedOutput;
    }
    return clientPreview;
  }, [clientPreview, simulatedOutput]);

  if (state === 'skeleton') {
    return (
      <section
        className="tool-card accent-amber"
        aria-busy="true"
        aria-label="Drafting budget shift proposal"
      >
        <div className="tool-card-eyebrow">BUDGET SHIFT PROPOSAL</div>
        <div className="skeleton-line skeleton-medium" />
        <div className="skeleton-line skeleton-wide" />
        <div className="skeleton-line skeleton-wide" />
      </section>
    );
  }

  if (state === 'error' || !output || !effectiveOutput) {
    return (
      <section className="tool-card error-card" role="alert">
        <div className="error-card-row">
          <div>
            <div className="tool-card-eyebrow error-eyebrow">PROPOSAL ERROR</div>
            <p className="error-card-body">
              {errorText || 'Unable to draft the daily budget shift proposal.'}
            </p>
          </div>
          <button type="button" className="btn btn-secondary" onClick={onRetry}>
            Retry
          </button>
        </div>
      </section>
    );
  }

  const fromLabel = effectiveOutput.fromCampaignName || effectiveOutput.fromCampaign;
  const toLabel = effectiveOutput.toCampaignName || effectiveOutput.toCampaign;
  const maxShiftBudget = Math.max(1, Math.floor(output.before.fromDailyBudget));
  const minShiftBudget = Math.min(25, maxShiftBudget);
  const canAdjustAmount = decision === null && maxShiftBudget >= 25;
  const isModifiedFromSuggested =
    Math.abs(effectiveOutput.amountPerDay - output.amountPerDay) >= 0.5;

  const triggerLiveSimulation = (nextAmount: number) => {
    if (simTimerRef.current) {
      clearTimeout(simTimerRef.current);
      simTimerRef.current = null;
    }
    if (simAbortRef.current) {
      simAbortRef.current.abort();
      simAbortRef.current = null;
    }

    if (Math.abs(nextAmount - output.amountPerDay) < 0.01) {
      setSimulatedOutput(null);
      setSimUpdating(false);
      setSimError(null);
      return;
    }

    setSimUpdating(true);
    setSimError(null);
    simTimerRef.current = setTimeout(() => {
      const controller = new AbortController();
      simAbortRef.current = controller;
      const currentMutations = getMutations ? getMutations() : [];
      void fetch('/api/agent/reallocation/simulate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          fromCampaign: output.fromCampaign,
          toCampaign: output.toCampaign,
          amountPerDay: nextAmount,
          proposalId: output.proposalId,
          mutations: currentMutations,
        }),
      })
        .then(async (res) => {
          if (!res.ok) {
            throw new Error(`Simulation unavailable (${res.status})`);
          }
          return (await res.json()) as ReallocationToolOutput;
        })
        .then((nextSim) => {
          if (!controller.signal.aborted) {
            setSimulatedOutput(nextSim);
            setSimUpdating(false);
            setSimError(null);
          }
        })
        .catch((err) => {
          if (controller.signal.aborted) {
            return;
          }
          setSimUpdating(false);
          setSimError(
            err instanceof Error ? err.message : 'Unable to refresh forecast.',
          );
        });
    }, 250);
  };

  const handleSliderChange = (rawAmount: number) => {
    const snapped =
      rawAmount >= maxShiftBudget
        ? maxShiftBudget
        : Math.max(minShiftBudget, Math.round(rawAmount / 25) * 25);
    setSliderAmount(snapped);
    setActionError(null);
    triggerLiveSimulation(snapped);
  };

  const handlePresetPercent = (pct: number) => {
    const target =
      pct >= 1
        ? output.before.fromDailyBudget
        : Math.max(minShiftBudget, Math.round((output.before.fromDailyBudget * pct) / 25) * 25);
    const clamped = Math.min(output.before.fromDailyBudget, target);
    setSliderAmount(clamped);
    setActionError(null);
    triggerLiveSimulation(clamped);
  };

  const handleResetSuggested = () => {
    setSliderAmount(null);
    setSimulatedOutput(null);
    setSimUpdating(false);
    setSimError(null);
    if (simTimerRef.current) {
      clearTimeout(simTimerRef.current);
      simTimerRef.current = null;
    }
    if (simAbortRef.current) {
      simAbortRef.current.abort();
      simAbortRef.current = null;
    }
  };

  const handleApproveClick = async () => {
    setSubmitting(true);
    setActionError(null);
    try {
      await onApprove(effectiveOutput);
    } catch (err) {
      setActionError(
        err instanceof Error ? err.message : 'Unable to apply budget shift.',
      );
    } finally {
      setSubmitting(false);
    }
  };

  const handleDeclineClick = () => {
    setActionError(null);
    onDecline(effectiveOutput);
  };

  const roasLift = effectiveOutput.blendedRoasAfter - effectiveOutput.blendedRoasBefore;
  const maxRoasScale = Math.max(
    effectiveOutput.blendedRoasBefore,
    effectiveOutput.blendedRoasAfter,
    1,
  );

  return (
    <section
      className="tool-card accent-amber"
      data-testid="reallocation-card"
      aria-label="Budget reallocation proposal"
    >
      <div className="tool-card-header">
        <div>
          <div className="tool-card-eyebrow">BUDGET SHIFT FOR APPROVAL</div>
          <h3 className="tool-card-title">
            {`Shift $${formatBudget(effectiveOutput.amountPerDay)}/day from ${fromLabel} to ${toLabel}`}
          </h3>
        </div>
        <span
          className={`pill tabular-nums ${
            roasLift >= 0 ? 'pill-green' : 'pill-amber'
          }`}
        >
          {`Projected ROAS: ${effectiveOutput.blendedRoasBefore.toFixed(2)}x → ${effectiveOutput.blendedRoasAfter.toFixed(2)}x`}
        </span>
      </div>

      {canAdjustAmount ? (
        <div
          className="reallocation-slider-panel tabular-nums"
          data-testid="reallocation-whatif-slider"
        >
          <div className="reallocation-slider-header">
            <label
              htmlFor={`shift-slider-${output.proposalId}`}
              className="reallocation-slider-label"
            >
              Adjust daily shift
            </label>
            <div className="reallocation-slider-controls">
              <strong className="reallocation-slider-amount">
                {`$${formatBudget(effectiveOutput.amountPerDay)}/day`}
              </strong>
              {isModifiedFromSuggested ? (
                <button
                  type="button"
                  className="reallocation-reset-link"
                  onClick={handleResetSuggested}
                  data-testid="reallocation-reset-suggested"
                >
                  Reset to suggested
                </button>
              ) : null}
            </div>
          </div>

          <input
            id={`shift-slider-${output.proposalId}`}
            type="range"
            className="reallocation-range-input"
            min={minShiftBudget}
            max={maxShiftBudget}
            step={1}
            disabled={disabled || submitting}
            value={Math.min(maxShiftBudget, Math.max(minShiftBudget, Math.round(effectiveOutput.amountPerDay)))}
            aria-label="Daily budget shift amount in dollars"
            onChange={(e) => handleSliderChange(Number(e.target.value))}
          />

          <div className="reallocation-preset-row">
            <span className="reallocation-preset-cap">
              {`Max $${formatBudget(output.before.fromDailyBudget)}/day from ${fromLabel}`}
            </span>
            <div className="reallocation-preset-chips" role="group" aria-label="Quick shift percentages">
              {[0.25, 0.5, 0.75, 1].map((pct) => {
                const targetVal =
                  pct >= 1
                    ? output.before.fromDailyBudget
                    : Math.min(
                        output.before.fromDailyBudget,
                        Math.max(
                          minShiftBudget,
                          Math.round((output.before.fromDailyBudget * pct) / 25) * 25,
                        ),
                      );
                const isSelected = Math.abs(effectiveOutput.amountPerDay - targetVal) < 0.5;
                return (
                  <button
                    key={pct}
                    type="button"
                    disabled={disabled || submitting}
                    className={isSelected ? 'btn-chip btn-chip-active' : 'btn-chip'}
                    onClick={() => handlePresetPercent(pct)}
                    data-testid={`reallocation-preset-${Math.round(pct * 100)}`}
                  >
                    {`${Math.round(pct * 100)}%`}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      ) : null}

      <div className="reallocation-chart-panel" data-testid="reallocation-budget-chart">
        <BeforeAfterBars
          ariaLabel={`Daily budget shift of $${formatBudget(effectiveOutput.amountPerDay)} per day from ${fromLabel} to ${toLabel}`}
          items={[
            {
              id: `from-${effectiveOutput.fromCampaign}`,
              label: fromLabel,
              sublabel: effectiveOutput.fromChannel
                ? `${effectiveOutput.fromChannel} · ${effectiveOutput.before.fromRoas.toFixed(2)}x ROAS`
                : `${effectiveOutput.before.fromRoas.toFixed(2)}x ROAS`,
              beforeValue: effectiveOutput.before.fromDailyBudget,
              afterValue: effectiveOutput.after.fromDailyBudget,
              beforeText: `$${formatBudget(effectiveOutput.before.fromDailyBudget)}/day`,
              afterText: `$${formatBudget(effectiveOutput.after.fromDailyBudget)}/day`,
              deltaText: `-$${formatBudget(effectiveOutput.amountPerDay)}/day`,
              deltaTone: 'negative',
              color: getChannelColorVar(
                effectiveOutput.fromChannel || effectiveOutput.fromCampaign,
              ),
            },
            {
              id: `to-${effectiveOutput.toCampaign}`,
              label: toLabel,
              sublabel: effectiveOutput.toChannel
                ? `${effectiveOutput.toChannel} · ${effectiveOutput.before.toRoas.toFixed(2)}x ROAS`
                : `${effectiveOutput.before.toRoas.toFixed(2)}x ROAS`,
              beforeValue: effectiveOutput.before.toDailyBudget,
              afterValue: effectiveOutput.after.toDailyBudget,
              beforeText: `$${formatBudget(effectiveOutput.before.toDailyBudget)}/day`,
              afterText: `$${formatBudget(effectiveOutput.after.toDailyBudget)}/day`,
              deltaText: `+$${formatBudget(effectiveOutput.amountPerDay)}/day`,
              deltaTone: 'positive',
              color: getChannelColorVar(
                effectiveOutput.toChannel || effectiveOutput.toCampaign,
              ),
            },
          ]}
        />

        <div className="reallocation-roas-compare">
          <div className="chart-section-label">Portfolio blended ROAS impact</div>
          <div className="chart-bar-stack">
            <BarRow
              label="Current blended ROAS"
              value={effectiveOutput.blendedRoasBefore}
              maxValue={maxRoasScale}
              valueText={`${effectiveOutput.blendedRoasBefore.toFixed(2)}x`}
              color="#94A3B8"
              compact
            />
            <BarRow
              label="Projected blended ROAS"
              value={effectiveOutput.blendedRoasAfter}
              maxValue={maxRoasScale}
              valueText={`${effectiveOutput.blendedRoasAfter.toFixed(2)}x (${roasLift >= 0 ? '+' : ''}${roasLift.toFixed(2)}x)`}
              color={roasLift >= 0 ? 'var(--accent-green)' : 'var(--accent-amber)'}
              compact
            />
          </div>
        </div>
      </div>

      {effectiveOutput.simulation ? (
        <div
          className={`forecast-band tabular-nums${simUpdating ? ' forecast-band-updating' : ''}`}
          data-testid="reallocation-forecast-band"
        >
          <div className="forecast-band-header">
            <div>
              <div className="panel-heading">
                {`${effectiveOutput.simulation.horizonDays}-day pipeline forecast (with diminishing returns)`}
              </div>
              <div className="cell-secondary">
                {`${effectiveOutput.simulation.trials.toLocaleString('en-US')}-trial Monte Carlo simulation calibrated from historical daily variance`}
                {architectMode
                  ? ` · ${
                      effectiveOutput.simulation.mode === 'sandbox'
                        ? 'Vercel Sandbox microVM'
                        : 'In-process Python'
                    } (${Math.round(effectiveOutput.simulation.sandboxMs)}ms)`
                  : ''}
              </div>
            </div>
            <div className="forecast-badge-group">
              {simUpdating ? (
                <span className="pill badge-amber" data-testid="forecast-updating-pill">
                  Updating forecast…
                </span>
              ) : null}
              <span className="pill pill-green" data-testid="forecast-lift-probability">
                {`${Math.round(effectiveOutput.simulation.probabilityOfPositiveLiftPct)}% chance of positive lift`}
              </span>
            </div>
          </div>

          <RangeBar
            p10={effectiveOutput.simulation.incrementalPipelineP10}
            p50={effectiveOutput.simulation.incrementalPipelineP50}
            p90={effectiveOutput.simulation.incrementalPipelineP90}
            p10Text={formatSignedCurrency(effectiveOutput.simulation.incrementalPipelineP10)}
            p50Text={formatSignedCurrency(effectiveOutput.simulation.incrementalPipelineP50)}
            p90Text={formatSignedCurrency(effectiveOutput.simulation.incrementalPipelineP90)}
            p10Sub={`${effectiveOutput.simulation.blendedRoasP10.toFixed(2)}x blended ROAS`}
            p50Sub={`${effectiveOutput.simulation.blendedRoasP50.toFixed(2)}x blended ROAS`}
            p90Sub={`${effectiveOutput.simulation.blendedRoasP90.toFixed(2)}x blended ROAS`}
            testId="reallocation-range-bar"
          />

          {effectiveOutput.simulation.targetSaturationDragPct > 0 ? (
            <p className="forecast-note">
              {`Accounts for an estimated ${effectiveOutput.simulation.targetSaturationDragPct.toFixed(1)}% marginal ROAS compression as ${toLabel} scales budget.`}
            </p>
          ) : null}

          {simError ? (
            <p className="inline-validation-error" role="status">
              {simError}
            </p>
          ) : null}
        </div>
      ) : null}

      <details className="technical-drawer">
        <summary>How projected ROAS is calculated</summary>
        <div className="formula-drawer-body">
          <p className="drawer-caption">
            Projected blended ROAS weights each active campaign&apos;s historical return by
            its updated daily budget while keeping your total daily budget unchanged at $
            {formatBudget(effectiveOutput.before.totalDailyBudget)}/day.
          </p>
        </div>
      </details>

      {actionError ? (
        <p className="inline-validation-error" role="alert">
          {actionError}
        </p>
      ) : null}

      <div className="tool-card-footer">
        {decision === 'approved' ? (
          <span className="pill badge-green" data-testid="reallocation-decision-pill">
            Approved · daily budgets updated
          </span>
        ) : decision === 'declined' ? (
          <span className="pill" data-testid="reallocation-decision-pill">
            Declined · budgets unchanged
          </span>
        ) : (
          <div className="card-actions-inline">
            <button
              type="button"
              className="btn btn-primary"
              disabled={disabled || submitting}
              onClick={() => void handleApproveClick()}
              data-testid="reallocation-approve-button"
            >
              Approve budget shift
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              disabled={disabled || submitting}
              onClick={handleDeclineClick}
              data-testid="reallocation-decline-button"
            >
              Decline
            </button>
          </div>
        )}
      </div>
    </section>
  );
}
