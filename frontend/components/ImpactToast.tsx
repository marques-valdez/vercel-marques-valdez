'use client';

/**
 * Non-blocking portfolio impact toast rendered above the floating Composer.
 *
 * Confirms off-screen KPI improvements (`$ protected`, `Blended ROAS` lift, or
 * reverted changes) immediately after the operator applies a hygiene fix or
 * approves a budget reallocation, with 1-click Undo and smooth scroll-to-top.
 */

import React, { useEffect, useState } from 'react';
import type { ImpactToastData, Mutation } from '@/lib/types';

interface ImpactToastProps {
  toast: ImpactToastData | null;
  busy?: boolean;
  onUndo?: (snapshot: Mutation[]) => void;
  onJumpTop: () => void;
  onDismiss: () => void;
}

const AUTO_DISMISS_MS = 5500;

export function ImpactToast({
  toast,
  busy = false,
  onUndo,
  onJumpTop,
  onDismiss,
}: ImpactToastProps) {
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    setPaused(false);
  }, [toast?.id]);

  useEffect(() => {
    if (!toast || paused || busy) {
      return;
    }
    const timer = setTimeout(() => {
      onDismiss();
    }, AUTO_DISMISS_MS);
    return () => clearTimeout(timer);
  }, [toast, paused, busy, onDismiss]);

  if (!toast) {
    return null;
  }

  return (
    <div
      className={`impact-toast impact-toast-${toast.tone}`}
      role="status"
      aria-live="polite"
      data-testid="impact-toast"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
    >
      <div className="impact-toast-copy">
        <strong className="impact-toast-title">{toast.title}</strong>
        <span className="impact-toast-detail tabular-nums">{toast.detail}</span>
      </div>

      <div className="impact-toast-actions">
        {toast.undoSnapshot && onUndo ? (
          <button
            type="button"
            className="impact-toast-btn impact-toast-undo"
            disabled={busy}
            onClick={() => onUndo(toast.undoSnapshot!)}
            data-testid="impact-toast-undo"
          >
            Undo
          </button>
        ) : null}
        <button
          type="button"
          className="impact-toast-btn"
          onClick={onJumpTop}
          data-testid="impact-toast-top"
        >
          Top KPIs ↑
        </button>
        <button
          type="button"
          className="impact-toast-dismiss"
          aria-label="Dismiss notification"
          onClick={onDismiss}
          data-testid="impact-toast-dismiss"
        >
          ×
        </button>
      </div>
    </div>
  );
}
