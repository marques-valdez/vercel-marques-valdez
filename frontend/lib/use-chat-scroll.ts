'use client';

/**
 * Scroll orchestration hook for the Relay Studio conversation stream.
 *
 * Covers every `sendMessage` call site (composer, starter playbooks, workflow
 * next-step pills, retry, demo steps, continue) by observing the message list:
 * - Pins each newly submitted user prompt under the sticky 56px header.
 * - Never force-scrolls while an assistant reply streams so readers can inspect
 *   earlier cards freely.
 * - Skips auto-scroll when saved chat history hydrates on page load.
 * - Drives a floating "Jump to latest" / "New reply" pill via IntersectionObserver.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { RelayUIMessage } from './types';

export interface ScrollDecisionInput {
  prevLastUserId: string | null;
  nextLastUserId: string | null;
  isStreaming: boolean;
  isHydrating: boolean;
}

export interface JumpPillState {
  visible: boolean;
  label: string;
  isStreaming: boolean;
}

export function getLatestUserMessageId(
  messages: ReadonlyArray<Pick<RelayUIMessage, 'id' | 'role'>>,
): string | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === 'user') {
      return messages[i].id;
    }
  }
  return null;
}

export function shouldScrollToNewPrompt({
  prevLastUserId,
  nextLastUserId,
  isStreaming,
  isHydrating,
}: ScrollDecisionInput): boolean {
  if (isHydrating || !nextLastUserId) {
    return false;
  }
  if (nextLastUserId === prevLastUserId) {
    return false;
  }
  return isStreaming;
}

export function computeJumpPillState(params: {
  messageCount: number;
  isSentinelVisible: boolean;
  isStreaming: boolean;
}): JumpPillState {
  if (params.messageCount <= 0 || params.isSentinelVisible) {
    return { visible: false, label: '', isStreaming: false };
  }
  if (params.isStreaming) {
    return { visible: true, label: 'New reply', isStreaming: true };
  }
  return { visible: true, label: 'Jump to latest', isStreaming: false };
}

function resolveScrollBehavior(): ScrollBehavior {
  if (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  ) {
    return 'auto';
  }
  return 'smooth';
}

export interface UseChatScrollParams {
  messages: RelayUIMessage[];
  isStreaming: boolean;
  isHydrating: boolean;
}

export function useChatScroll({
  messages,
  isStreaming,
  isHydrating,
}: UseChatScrollParams) {
  const latestUserRef = useRef<HTMLElement | null>(null);
  const endSentinelRef = useRef<HTMLDivElement | null>(null);
  const prevLastUserIdRef = useRef<string | null>(null);

  const [pinLatestTurn, setPinLatestTurn] = useState(false);
  const [isSentinelVisible, setIsSentinelVisible] = useState(true);

  const latestUserId = getLatestUserMessageId(messages);

  useEffect(() => {
    if (messages.length === 0) {
      prevLastUserIdRef.current = null;
      setPinLatestTurn(false);
      setIsSentinelVisible(true);
      return;
    }

    const shouldScroll = shouldScrollToNewPrompt({
      prevLastUserId: prevLastUserIdRef.current,
      nextLastUserId: latestUserId,
      isStreaming,
      isHydrating,
    });

    prevLastUserIdRef.current = latestUserId;

    if (!shouldScroll) {
      return;
    }

    setPinLatestTurn(true);

    let innerFrameId = 0;
    const outerFrameId = window.requestAnimationFrame(() => {
      innerFrameId = window.requestAnimationFrame(() => {
        const target = latestUserRef.current;
        if (target && typeof target.scrollIntoView === 'function') {
          target.scrollIntoView({
            block: 'start',
            behavior: resolveScrollBehavior(),
          });
        }
      });
    });

    return () => {
      window.cancelAnimationFrame(outerFrameId);
      if (innerFrameId) {
        window.cancelAnimationFrame(innerFrameId);
      }
    };
  }, [isHydrating, isStreaming, latestUserId, messages.length]);

  useEffect(() => {
    if (messages.length === 0) {
      setIsSentinelVisible(true);
      return;
    }
    const sentinel = endSentinelRef.current;
    if (!sentinel || typeof IntersectionObserver === 'undefined') {
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (!entry) {
          return;
        }
        setIsSentinelVisible(entry.isIntersecting);
      },
      {
        root: null,
        rootMargin: '0px 0px -88px 0px',
        threshold: 0,
      },
    );

    observer.observe(sentinel);
    return () => {
      observer.disconnect();
    };
  }, [messages.length, latestUserId]);

  const jumpToLatest = useCallback(() => {
    const behavior = resolveScrollBehavior();
    const userEl = latestUserRef.current;
    const sentinelEl = endSentinelRef.current;

    if (userEl && typeof userEl.getBoundingClientRect === 'function') {
      const rect = userEl.getBoundingClientRect();
      // If the latest prompt itself is off-screen (above or below), land cleanly on it.
      if (rect.top > 120 || rect.bottom < 72) {
        userEl.scrollIntoView({ block: 'start', behavior });
        return;
      }
    }

    if (sentinelEl && typeof sentinelEl.scrollIntoView === 'function') {
      sentinelEl.scrollIntoView({ block: 'end', behavior });
    } else if (userEl && typeof userEl.scrollIntoView === 'function') {
      userEl.scrollIntoView({ block: 'start', behavior });
    }
  }, []);

  const jumpPill = computeJumpPillState({
    messageCount: messages.length,
    isSentinelVisible,
    isStreaming,
  });

  return {
    latestUserRef,
    endSentinelRef,
    pinLatestTurn,
    jumpPill,
    jumpToLatest,
  };
}
