'use client';

/**
 * 2x2 starter playbook grid solving cold-start blank-screen drop-off.
 *
 * Highlights the active card when arriving from a shared `/?remix=<slug>` link
 * and collapses into a 1-line switcher once the conversation begins.
 */

import React from 'react';
import { PLAYBOOKS } from '@/lib/playbooks';
import type {
  DerivedTwinState,
  PlaybookDefinition,
  PlaybookId,
} from '@/lib/types';

export interface PlaybookLiveBadge {
  label: string;
  pillClass: string;
}

export function computePlaybookLiveBadge(
  playbookId: PlaybookId,
  twinState?: DerivedTwinState | null,
  workflowCount = 0,
): PlaybookLiveBadge | null {
  if (!twinState) {
    return null;
  }
  const { totals, channels } = twinState;

  if (playbookId === 'creative-404-guard') {
    const openCount = totals.brokenCreatives + totals.utmViolations;
    if (openCount > 0) {
      const roundedRisk = Math.round(totals.spendAtRiskPerDay).toLocaleString(
        'en-US',
      );
      return {
        label: `${openCount.toLocaleString('en-US')} open issues · $${roundedRisk}/day at risk`,
        pillClass: 'pill pill-danger tabular-nums',
      };
    }
    return {
      label: '✓ All links & UTMs healthy',
      pillClass: 'pill pill-green',
    };
  }

  if (playbookId === 'cross-channel-roas') {
    if (channels.length === 0) {
      return null;
    }
    const roasValues = channels.map((c) => c.roas);
    const minRoas = Math.min(...roasValues);
    const maxRoas = Math.max(...roasValues);
    return {
      label: `${minRoas.toFixed(2)}x – ${maxRoas.toFixed(2)}x ROAS · ${totals.campaignCount.toLocaleString('en-US')} campaigns`,
      pillClass: 'pill pill-green tabular-nums',
    };
  }

  if (playbookId === 'paid-social-reallocation') {
    if (channels.length < 2) {
      return null;
    }
    const sorted = [...channels].sort((a, b) => a.roas - b.roas);
    const low = sorted[0];
    const high = sorted[sorted.length - 1];
    if (!low || !high || high.roas <= low.roas) {
      return null;
    }
    const gap = high.roas - low.roas;
    const lowShort = low.channel.replace(/\s+Ads$/i, '');
    const highShort = high.channel.replace(/\s+Ads$/i, '');
    return {
      label: `${gap.toFixed(2)}x ROAS gap · ${lowShort} → ${highShort}`,
      pillClass: 'pill pill-amber tabular-nums',
    };
  }

  if (playbookId === 'daily-pacing-guardrail') {
    if (workflowCount > 0) {
      return {
        label: `${workflowCount.toLocaleString('en-US')} scheduled ${
          workflowCount === 1 ? 'check' : 'checks'
        } saved`,
        pillClass: 'pill pill-violet tabular-nums',
      };
    }
    const riskPct =
      totals.dailyBudget > 0
        ? (totals.spendAtRiskPerDay / totals.dailyBudget) * 100
        : 0;
    return {
      label: `${riskPct.toFixed(1)}% daily spend at risk`,
      pillClass:
        riskPct > 0
          ? 'pill pill-amber tabular-nums'
          : 'pill pill-violet tabular-nums',
    };
  }

  return null;
}

interface PlaybookGridProps {
  highlightedPlaybookId: PlaybookId | null;
  disabled: boolean;
  twinState?: DerivedTwinState | null;
  workflowCount?: number;
  onSelectPlaybook: (playbook: PlaybookDefinition) => void;
}

export function PlaybookGrid({
  highlightedPlaybookId,
  disabled,
  twinState = null,
  workflowCount = 0,
  onSelectPlaybook,
}: PlaybookGridProps) {
  return (
    <section
      className="playbook-section"
      aria-label="Starter playbooks"
      data-testid="playbook-grid"
    >
      <div className="playbook-grid">
        {PLAYBOOKS.map((playbook) => {
          const isHighlighted = highlightedPlaybookId === playbook.id;
          const accentClass = isHighlighted
            ? 'accent-blue'
            : `accent-${playbook.accent}`;
          const liveBadge = computePlaybookLiveBadge(
            playbook.id,
            twinState,
            workflowCount,
          );
          return (
            <article
              key={playbook.id}
              className={`playbook-card ${accentClass}${
                isHighlighted ? ' playbook-card-highlighted' : ''
              }`}
              data-playbook-id={playbook.id}
              data-highlighted={isHighlighted ? 'true' : 'false'}
            >
              <div className="playbook-eyebrow-row">
                <span className="playbook-eyebrow">{playbook.eyebrow}</span>
                {isHighlighted ? (
                  <span className="pill remix-pill">Prefilled below</span>
                ) : liveBadge ? (
                  <span
                    className={`${liveBadge.pillClass} playbook-live-badge`}
                    data-testid={`playbook-live-badge-${playbook.id}`}
                  >
                    {liveBadge.label}
                  </span>
                ) : null}
              </div>

              <h2 className="playbook-title">{playbook.title}</h2>
              <p className="playbook-summary">{playbook.summary}</p>

              <div className="playbook-footer">
                <button
                  type="button"
                  className="btn btn-card-action"
                  disabled={disabled}
                  onClick={() => onSelectPlaybook(playbook)}
                >
                  <span>{playbook.actionLabel}</span>
                  <span aria-hidden="true">→</span>
                </button>
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}
