'use client';

/**
 * Contextual follow-up action chips rendered below completed assistant turns.
 *
 * Surfaces 2-3 one-click next actions grounded in the turn's tool outputs
 * (e.g. hygiene -> budget shift -> recurring check) so marketers can keep
 * moving without typing from scratch.
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
        {chips.map((chip) => (
          <button
            key={chip.id}
            type="button"
            disabled={disabled}
            className={`turn-followup-chip turn-followup-${chip.tone}`}
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
