'use client';

/**
 * Three whole-portfolio budget plans, compared side by side.
 *
 * `POST /api/agent/reallocation/optimize` builds Cautious / Balanced / Bold plans
 * from the current budgets and scores all three in one 2,000-trial Monte Carlo job
 * (`@vercel/sandbox` when available). Plans differ by how much budget moves; a
 * larger move earns more in total and less per dollar moved. Applying a plan
 * appends ordinary `reallocate_budget` mutations in a single call, so the audit
 * log and Undo behave exactly as they do for one approved shift.
 */

import React, { useEffect, useRef, useState } from 'react';
import type { Mutation, PortfolioOptimizeResponse, PortfolioPlan } from '@/lib/types';

interface PortfolioPlansProps {
  disabled: boolean;
  architectMode?: boolean;
  getMutations?: () => Mutation[];
  onApplyPlan: (plan: PortfolioPlan) => Promise<void>;
}

export function formatCompactCurrency(amount: number): string {
  const safe = Number.isFinite(amount) ? amount : 0;
  const sign = safe < 0 ? '-' : '';
  const abs = Math.abs(safe);
  if (abs >= 1000) {
    return `${sign}$${(abs / 1000).toFixed(abs >= 100000 ? 0 : 1)}K`;
  }
  return `${sign}$${Math.round(abs).toLocaleString('en-US')}`;
}

export interface PlanBarGeometry {
  leftPct: number;
  widthPct: number;
  medianPct: number;
}

/** Places each plan's P10-P90 band on one shared 0..max scale so cards are comparable. */
export function computeSharedPlanBars(
  plans: ReadonlyArray<
    Pick<
      PortfolioPlan,
      'incrementalPipelineP10' | 'incrementalPipelineP50' | 'incrementalPipelineP90'
    >
  >,
): PlanBarGeometry[] {
  const scaleMax = plans.reduce(
    (acc, plan) => Math.max(acc, plan.incrementalPipelineP90, 0),
    0,
  );
  const toPct = (value: number) =>
    scaleMax > 0
      ? Math.max(0, Math.min(100, Number(((Math.max(0, value) / scaleMax) * 100).toFixed(1))))
      : 0;
  return plans.map((plan) => {
    const left = toPct(plan.incrementalPipelineP10);
    const right = toPct(plan.incrementalPipelineP90);
    return {
      leftPct: left,
      widthPct: Math.max(1, Number((right - left).toFixed(1))),
      medianPct: toPct(plan.incrementalPipelineP50),
    };
  });
}

export function PortfolioPlans({
  disabled,
  architectMode = false,
  getMutations,
  onApplyPlan,
}: PortfolioPlansProps) {
  const [result, setResult] = useState<PortfolioOptimizeResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  const [appliedPlan, setAppliedPlan] = useState<PortfolioPlan | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  const handleCompare = async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);
    setError(null);
    setAppliedPlan(null);
    try {
      const response = await fetch('/api/agent/reallocation/optimize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        cache: 'no-store',
        signal: controller.signal,
        body: JSON.stringify({ mutations: getMutations ? getMutations() : [] }),
      });
      if (!response.ok) {
        throw new Error(
          response.status === 429
            ? 'Too many simulations in a short time. Please wait a moment and retry.'
            : `Plan comparison unavailable (${response.status}).`,
        );
      }
      const parsed = (await response.json()) as PortfolioOptimizeResponse;
      if (!parsed || !Array.isArray(parsed.plans)) {
        throw new Error('Plan comparison returned an unexpected response.');
      }
      if (!controller.signal.aborted) {
        setResult(parsed);
        const middle = parsed.plans[Math.floor(parsed.plans.length / 2)];
        setSelectedId(middle ? middle.planId : null);
      }
    } catch (err) {
      if (!controller.signal.aborted) {
        setError(err instanceof Error ? err.message : 'Plan comparison failed.');
      }
    } finally {
      if (!controller.signal.aborted) {
        setLoading(false);
      }
    }
  };

  const handleApply = async (plan: PortfolioPlan) => {
    setApplying(true);
    setError(null);
    try {
      await onApplyPlan(plan);
      setAppliedPlan(plan);
      setResult(null);
      setSelectedId(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not apply this plan.');
    } finally {
      setApplying(false);
    }
  };

  if (!result) {
    return (
      <div className="portfolio-launch" data-testid="portfolio-plans-launch">
        {appliedPlan ? (
          <p className="forecast-note" data-testid="portfolio-plan-applied-note">
            {`Applied the ${appliedPlan.label} plan: $${Math.round(
              appliedPlan.movedPerDay,
            ).toLocaleString('en-US')}/day moved in ${appliedPlan.shifts.length} shift${
              appliedPlan.shifts.length === 1 ? '' : 's'
            }. Each shift is listed under Changes, where it can be undone.`}
          </p>
        ) : null}
        <button
          type="button"
          className="btn btn-secondary"
          disabled={disabled || loading}
          onClick={() => void handleCompare()}
          data-testid="portfolio-compare-button"
        >
          {loading
            ? 'Simulating plans…'
            : appliedPlan
              ? 'Compare plans again'
              : 'Compare 3 portfolio plans'}
        </button>
        {!appliedPlan ? (
          <span className="cell-secondary">
            Or rebalance the whole portfolio instead of one pair of campaigns.
          </span>
        ) : null}
        {error ? (
          <p className="inline-validation-error" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    );
  }

  if (result.plans.length === 0) {
    return (
      <div className="forecast-band portfolio-panel" data-testid="portfolio-plans-panel">
        <div className="panel-heading">Portfolio plans</div>
        <p className="forecast-note">
          {result.note ?? 'No portfolio plan is available for the current budgets.'}
        </p>
      </div>
    );
  }

  const bars = computeSharedPlanBars(result.plans);
  const selectedPlan = result.plans.find((plan) => plan.planId === selectedId) ?? null;

  return (
    <div className="forecast-band portfolio-panel tabular-nums" data-testid="portfolio-plans-panel">
      <div className="forecast-band-header">
        <div>
          <div className="panel-heading">{`Portfolio plans · ${result.horizonDays}-day pipeline forecast`}</div>
          <div className="cell-secondary">
            {`${result.trials.toLocaleString('en-US')}-trial simulation, all three plans scored on the same draws. Total budget stays $${Math.round(
              result.baseline.dailyBudget,
            ).toLocaleString('en-US')}/day.`}
            {architectMode
              ? ` · ${
                  result.mode === 'sandbox' ? 'Vercel Sandbox microVM' : 'In-process Python'
                } (${Math.round(result.sandboxMs)}ms)`
              : ''}
          </div>
        </div>
      </div>

      <div className="portfolio-plan-grid" role="radiogroup" aria-label="Portfolio plan">
        {result.plans.map((plan, idx) => {
          const isSelected = plan.planId === selectedId;
          const bar = bars[idx];
          return (
            <button
              key={plan.planId}
              type="button"
              role="radio"
              aria-checked={isSelected}
              className={`portfolio-plan-card${isSelected ? ' portfolio-plan-card-selected' : ''}`}
              disabled={disabled || applying}
              onClick={() => setSelectedId(plan.planId)}
              data-testid={`portfolio-plan-${plan.planId}`}
            >
              <span className="portfolio-plan-eyebrow">{plan.label}</span>
              <span className="portfolio-plan-moved">
                {`Move $${Math.round(plan.movedPerDay).toLocaleString('en-US')}/day`}
              </span>
              <span className="portfolio-plan-sub">
                {`${plan.movedSharePct.toFixed(1)}% of daily budget`}
              </span>
              <span className="portfolio-plan-bar" aria-hidden="true">
                <span
                  className="portfolio-plan-bar-band"
                  style={{ left: `${bar.leftPct}%`, width: `${bar.widthPct}%` }}
                />
                <span
                  className="portfolio-plan-bar-median"
                  style={{ left: `${bar.medianPct}%` }}
                />
              </span>
              <span className="portfolio-plan-lift">
                {`${plan.incrementalPipelineP50 >= 0 ? '+' : ''}${formatCompactCurrency(
                  plan.incrementalPipelineP50,
                )} expected`}
              </span>
              <span className="portfolio-plan-sub">
                {`${formatCompactCurrency(plan.incrementalPipelineP10)} to ${formatCompactCurrency(
                  plan.incrementalPipelineP90,
                )} range`}
              </span>
              <span className="portfolio-plan-sub">
                {`$${Math.round(plan.liftPerDollarMoved).toLocaleString('en-US')} per $1/day moved`}
              </span>
              <span className="portfolio-plan-sub">
                {`${plan.blendedRoasP50.toFixed(2)}x blended ROAS`}
              </span>
            </button>
          );
        })}
      </div>

      {selectedPlan ? (
        <div className="portfolio-shift-list" data-testid="portfolio-shift-list">
          <div className="forecast-label">{`${selectedPlan.label} plan moves`}</div>
          <ul>
            {selectedPlan.shifts.map((shift) => (
              <li key={`${shift.fromCampaign}-${shift.toCampaign}`}>
                <strong>{`$${Math.round(shift.amountPerDay).toLocaleString('en-US')}/day`}</strong>
                {` from ${shift.fromCampaignName} to ${shift.toCampaignName}`}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <p className="forecast-note">
        Bigger moves add more pipeline in total but less per dollar moved, because added
        budget earns a diminishing return. The simulation assumes each campaign keeps its
        historical return at the new spend level.
      </p>

      {selectedPlan && !selectedPlan.fitsMutationCap ? (
        <p className="inline-validation-error" role="status">
          This workspace has reached its limit of saved changes. Revert some changes before
          applying a plan.
        </p>
      ) : null}
      {error ? (
        <p className="inline-validation-error" role="alert">
          {error}
        </p>
      ) : null}

      <div className="card-actions-inline">
        <button
          type="button"
          className="btn btn-primary"
          disabled={disabled || applying || !selectedPlan || !selectedPlan.fitsMutationCap}
          onClick={() => (selectedPlan ? void handleApply(selectedPlan) : undefined)}
          data-testid="portfolio-apply-button"
        >
          {applying
            ? 'Applying plan…'
            : selectedPlan
              ? `Apply ${selectedPlan.label} plan`
              : 'Select a plan'}
        </button>
        <button
          type="button"
          className="btn btn-secondary"
          disabled={applying}
          onClick={() => {
            setResult(null);
            setSelectedId(null);
          }}
          data-testid="portfolio-close-button"
        >
          Close
        </button>
      </div>
    </div>
  );
}
