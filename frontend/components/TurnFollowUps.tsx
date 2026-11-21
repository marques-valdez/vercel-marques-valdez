'use client';

/**
 * Contextual follow-up action chips rendered below completed assistant turns.
 *
 * Highlights index `0` (`.turn-followup-primary`) as the sequential default
 * "Next table" slice alongside secondary optimization and guardrail actions so
 * marketers explore data progressively without cognitive overload.
 */

import React from 'react';
import type { FollowUpChip } from '@/lib/types';

interface TurnFollowUpsProps {
  chips: FollowUpChip[];
  disabled?: boolean;
  onSelect: (prompt: string, tierHint: 'fast' | 'reasoning') => void;
}

export function TurnFollowUps({
  chips,
  disabled = false,
  onSelect,
}: TurnFollowUpsProps) {
  if (!chips || chips.length === 0) {
    return null;
  }

  return (
    <div
      className="turn-followups"
      data-testid="turn-follow-ups"
      role="group"
      aria-label="Suggested follow-ups"
    >
      <span className="turn-followups-label">Next</span>
      <div className="turn-followups-list">
        {chips.map((chip, idx) => (
          <button
            key={chip.id}
            type="button"
            disabled={disabled}
            aria-label={idx === 0 ? `Default next step: ${chip.label}` : chip.label}
            className={`turn-followup-chip turn-followup-${chip.tone}${idx === 0 ? ' turn-followup-primary' : ''}`}
            onClick={() => onSelect(chip.prompt, chip.tierHint)}
            data-testid={`followup-${chip.id}`}
          >
            <span>{chip.label}</span>
            <span aria-hidden="true">→</span>
          </button>
        ))}
      </div>
    </div>
  );
}
