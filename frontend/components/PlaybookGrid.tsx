'use client';

import React from 'react';
import { PLAYBOOKS } from '@/lib/playbooks';
import type { PlaybookDefinition, PlaybookId } from '@/lib/types';

interface PlaybookGridProps {
  highlightedPlaybookId: PlaybookId | null;
  disabled: boolean;
  onSelectPlaybook: (playbook: PlaybookDefinition) => void;
}

export function PlaybookGrid({
  highlightedPlaybookId,
  disabled,
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
