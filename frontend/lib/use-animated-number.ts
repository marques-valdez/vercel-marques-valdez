'use client';

/**
 * Reduced-motion-aware numeric tween hook for KPI roll-ups.
 *
 * Returns `target` immediately on SSR and initial mount so hydration always
 * matches server HTML, then animates smoothly over `durationMs` (cubic
 * ease-out) whenever `target` updates in the browser.
 */

import { useEffect, useRef, useState } from 'react';

export function interpolateEaseOut(
  from: number,
  to: number,
  progress: number,
): number {
  if (!Number.isFinite(to)) {
    return 0;
  }
  if (!Number.isFinite(from)) {
    return to;
  }
  const clamped = Math.max(0, Math.min(1, progress));
  const eased = 1 - Math.pow(1 - clamped, 3);
  return from + (to - from) * eased;
}

export function useAnimatedNumber(
  target: number,
  durationMs: number = 380,
): number {
  const safeTarget = Number.isFinite(target) ? target : 0;
  const [displayValue, setDisplayValue] = useState<number>(safeTarget);
  const currentRef = useRef<number>(safeTarget);
  const mountedRef = useRef(false);

  useEffect(() => {
    if (!mountedRef.current) {
      mountedRef.current = true;
      currentRef.current = safeTarget;
      setDisplayValue(safeTarget);
      return;
    }

    const startValue = currentRef.current;
    if (Math.abs(safeTarget - startValue) < 0.0005) {
      currentRef.current = safeTarget;
      setDisplayValue(safeTarget);
      return;
    }

    if (
      typeof window === 'undefined' ||
      typeof requestAnimationFrame !== 'function' ||
      (typeof window.matchMedia === 'function' &&
        window.matchMedia('(prefers-reduced-motion: reduce)').matches)
    ) {
      currentRef.current = safeTarget;
      setDisplayValue(safeTarget);
      return;
    }

    let rafId = 0;
    const startTs =
      typeof performance !== 'undefined' ? performance.now() : Date.now();
    const duration = Math.max(120, durationMs);

    const step = (nowTs: number) => {
      const elapsed = Math.max(0, nowTs - startTs);
      const progress = Math.min(1, elapsed / duration);
      const next = interpolateEaseOut(startValue, safeTarget, progress);
      currentRef.current = next;
      setDisplayValue(next);
      if (progress < 1) {
        rafId = requestAnimationFrame(step);
      } else {
        currentRef.current = safeTarget;
        setDisplayValue(safeTarget);
      }
    };

    rafId = requestAnimationFrame(step);
    return () => {
      if (rafId) {
        cancelAnimationFrame(rafId);
      }
    };
  }, [safeTarget, durationMs]);

  return displayValue;
}
