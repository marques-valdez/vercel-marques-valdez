'use client';

/**
 * Primary interactive workspace client for Relay Studio.
 *
 * Orchestrates the Marketing Manager default UI (channel health strip, starter
 * playbooks, chat stream with typed AI SDK 7 tool cards, Workflows flyout, and
 * playbook sharing) plus the opt-in `Architect X-Ray` mode (`X-Ray` header
 * toggle or `/?xray=1`) that exposes live Vercel Services topology, AI Gateway
 * route previews, 503 failover drills, SSE wire frames (`response.body.tee()`),
 * and the FinOps Inspector drawer.
 *
 * State invariants:
 * - Zero database: chat history (`chat-store.ts`), Twin mutations
 *   (`twin-client.ts`), and saved workflows (`workflow-store.ts`) persist in
 *   `localStorage` and clear atomically on `Reset changes`.
 * - Approval isolation: reallocation approval decisions key off `part.toolCallId`
 *   so repeated proposals in the same session never collide.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport } from 'ai';
import { AgentProgressCard, OPTIMISTIC_SUBMIT_STEPS } from './AgentProgressCard';
import { BackendAlertBanner, buildHttpErrorAlert } from './BackendAlertBanner';
import { ChangesPopover } from './ChangesPopover';
import { ChannelHealthStrip } from './ChannelHealthStrip';
import { Composer } from './Composer';
import { HeaderBar } from './HeaderBar';
import { HygieneCard } from './HygieneCard';
import { ImpactToast } from './ImpactToast';
import { InspectorDrawer } from './InspectorDrawer';
import { PlaybookGrid } from './PlaybookGrid';
import { ProtocolXRay } from './ProtocolXRay';
import { ReallocationCard } from './ReallocationCard';
import { SandboxCard } from './SandboxCard';
import { ShareModal } from './ShareModal';
import { TelemetryStrip } from './TelemetryStrip';
import { VercelArchitectureStrip } from './VercelArchitectureStrip';
import { WorkflowCard } from './WorkflowCard';
import { WorkflowsDrawer } from './WorkflowsDrawer';
import { MarkdownText } from './MarkdownText';
import { TurnFollowUps } from './TurnFollowUps';
import {
  buildChannelDrilldownPrompt,
  buildTurnFollowUps,
} from '@/lib/follow-ups';
import {
  clearStoredChatMessages,
  readStoredChatMessages,
  writeStoredChatMessages,
} from '@/lib/chat-store';
import {
  collectSucceededToolNames,
  shouldSuppressRetriedToolError,
} from '@/lib/tool-errors';
import { useChatScroll } from '@/lib/use-chat-scroll';
import { PLAYBOOKS } from '@/lib/playbooks';
import {
  appendTwinMutations,
  fetchTwinState,
  readStoredMutations,
  removeTwinMutationAt,
  replaceTwinMutations,
  resetTwinMutations,
} from '@/lib/twin-client';
import {
  clearStoredWorkflows,
  isValidWorkflowOutput,
  readStoredWorkflows,
  removeStoredWorkflow,
  renameStoredWorkflow,
  upsertStoredWorkflow,
} from '@/lib/workflow-store';
import {
  fetchWorkspaceSnapshot,
  getOrCreateWorkspaceId,
  resetRemoteWorkspace,
  syncWorkspaceMessages,
  syncWorkspaceMutations,
  syncWorkspaceWorkflows,
} from '@/lib/workspace-store';
import type {
  AgentStatusData,
  BackendAlert,
  ChannelDelta,
  ChannelId,
  ChannelTrendSeries,
  ChannelTrendsResponse,
  DemoStepId,
  DerivedTwinState,
  HealthStatus,
  HygieneToolOutput,
  ImpactToastData,
  Mutation,
  PlaybookDefinition,
  PlaybookId,
  ReallocationToolOutput,
  RelayUIMessage,
  ResolvedPlaybook,
  SandboxStatusData,
  SandboxToolOutput,
  SavedWorkflowRecord,
  TelemetryData,
  TwinTotals,
  WireFrameRecord,
  WorkflowToolOutput,
} from '@/lib/types';

function computeChannelDeltas(
  prev: DerivedTwinState | null,
  next: DerivedTwinState,
): Record<string, ChannelDelta> {
  if (!prev) {
    return {};
  }
  const prevById = new Map(prev.channels.map((ch) => [ch.channelId, ch]));
  const deltas: Record<string, ChannelDelta> = {};
  for (const ch of next.channels) {
    const old = prevById.get(ch.channelId);
    if (!old) {
      continue;
    }
    const dailyBudgetDelta = Number((ch.dailyBudget - old.dailyBudget).toFixed(2));
    const brokenCreativesDelta = ch.brokenCreatives - old.brokenCreatives;
    const utmViolationsDelta = ch.utmViolations - old.utmViolations;
    if (
      Math.abs(dailyBudgetDelta) >= 0.01 ||
      brokenCreativesDelta !== 0 ||
      utmViolationsDelta !== 0
    ) {
      deltas[ch.channelId] = {
        dailyBudgetDelta,
        brokenCreativesDelta,
        utmViolationsDelta,
      };
    }
  }
  return deltas;
}

interface WorkspaceClientProps {
  initialRemix: ResolvedPlaybook | null;
  initialArchitectMode?: boolean;
  uiStreamSource?: string;
}

function mapToolStateToCardState(
  partState: string,
): 'skeleton' | 'completed' | 'error' {
  if (partState === 'output-available') {
    return 'completed';
  }
  if (partState === 'output-error' || partState === 'output-denied') {
    return 'error';
  }
  return 'skeleton';
}

export function WorkspaceClient({
  initialRemix,
  initialArchitectMode = false,
  uiStreamSource = '',
}: WorkspaceClientProps) {
  const [twinState, setTwinState] = useState<DerivedTwinState | null>(null);
  const [channelDeltas, setChannelDeltas] = useState<Record<string, ChannelDelta>>({});
  const [channelTrends, setChannelTrends] = useState<
    Partial<Record<ChannelId, ChannelTrendSeries>>
  >({});
  const [twinError, setTwinError] = useState<string | null>(null);
  const [backendAlert, setBackendAlert] = useState<BackendAlert | null>(null);
  const [syncWarning, setSyncWarning] = useState<BackendAlert | null>(null);
  const [architectMode, setArchitectMode] = useState<boolean>(initialArchitectMode);
  const [health, setHealth] = useState<HealthStatus | null>(null);
  const [healthPingMs, setHealthPingMs] = useState<number | null>(null);
  const [healthLoading, setHealthLoading] = useState(false);
  const [injectFailure, setInjectFailure] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [inspectorInitialTab, setInspectorInitialTab] = useState<
    'all' | 'adapter' | 'deployment'
  >('all');
  const [playbooksExpanded, setPlaybooksExpanded] = useState(false);

  const [input, setInput] = useState<string>(() => initialRemix?.prompt ?? '');
  const [highlightedPlaybookId, setHighlightedPlaybookId] =
    useState<PlaybookId | null>(() => initialRemix?.template ?? null);
  const [primedTierHint, setPrimedTierHint] = useState<'fast' | 'reasoning' | null>(
    () => initialRemix?.tierHint ?? null,
  );

  const [savedWorkflows, setSavedWorkflows] = useState<SavedWorkflowRecord[]>([]);
  const [workflowsOpen, setWorkflowsOpen] = useState(false);
  const [selectedWorkflowId, setSelectedWorkflowId] = useState<string | null>(null);
  const [wireFramesByTurn, setWireFramesByTurn] = useState<
    Record<string, WireFrameRecord[]>
  >({});
  const [wireFramesByOrder, setWireFramesByOrder] = useState<WireFrameRecord[][]>([]);
  const [autoOpenXRayKey, setAutoOpenXRayKey] = useState<string | null>(null);
  const [shareSlug, setShareSlug] = useState<string>(
    () => initialRemix?.slug ?? 'creative-404-guard',
  );
  const [shareModalOpen, setShareModalOpen] = useState(false);
  const [hasOpenedShareStudio, setHasOpenedShareStudio] = useState(false);
  const [baselineTotals, setBaselineTotals] = useState<TwinTotals | null>(null);
  const [activeMutations, setActiveMutations] = useState<Mutation[]>([]);
  const [changesOpen, setChangesOpen] = useState(false);
  const [mutationBusy, setMutationBusy] = useState(false);
  const [impactToast, setImpactToast] = useState<ImpactToastData | null>(null);
  const [proposalDecisions, setProposalDecisions] = useState<
    Record<string, 'approved' | 'declined'>
  >({});
  const approvedByCallIdRef = useRef<
    Record<
      string,
      { from_campaign: string; to_campaign: string; amount_per_day: number }
    >
  >({});

  const twinStateRef = useRef<DerivedTwinState | null>(twinState);
  twinStateRef.current = twinState;
  const workspaceIdRef = useRef<string>('');
  const dbConnectedRef = useRef<boolean>(false);
  const architectModeRef = useRef<boolean>(architectMode);
  architectModeRef.current = architectMode;
  const injectFailureRef = useRef<boolean>(injectFailure);
  injectFailureRef.current = injectFailure;
  const turnCaptureCounterRef = useRef(0);
  const autoOpenNextXRayRef = useRef(false);
  const chatHydratedRef = useRef(false);
  const userStoppedRef = useRef(false);
  const seenWorkflowCallIdsRef = useRef<Set<string>>(new Set());

  const lastTierHintRef = useRef<'fast' | 'reasoning' | null>(
    initialRemix?.tierHint ?? null,
  );
  const lastUserPromptRef = useRef<string>('');

  const loadTwin = useCallback(async () => {
    setTwinError(null);
    try {
      const stored = readStoredMutations();
      setActiveMutations(stored);
      if (stored.length === 0) {
        const derived = await fetchTwinState([]);
        setBaselineTotals(derived.totals);
        setTwinState(derived);
      } else {
        const [baseDerived, derived] = await Promise.all([
          fetchTwinState([]),
          fetchTwinState(stored),
        ]);
        setBaselineTotals(baseDerived.totals);
        setTwinState(derived);
      }
    } catch (err) {
      setTwinError(
        err instanceof Error
          ? err.message
          : 'Unable to load campaign workspace.',
      );
    }
  }, []);

  const loadHealth = useCallback(async () => {
    setHealthLoading(true);
    const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
    try {
      const response = await fetch('/api/agent/health', { cache: 'no-store' });
      const elapsed = Math.max(
        1,
        Math.round(
          (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0,
        ),
      );
      if (response.ok) {
        const data = (await response.json()) as HealthStatus;
        setHealth(data);
        setHealthPingMs(elapsed);
      }
    } catch {
      // Keep health null so Inspector shows graceful unavailable state
    } finally {
      setHealthLoading(false);
    }
  }, []);

  useEffect(() => {
    const wsId = getOrCreateWorkspaceId();
    workspaceIdRef.current = wsId;
    setSavedWorkflows(readStoredWorkflows());
    void loadTwin();
  }, [loadTwin]);

  useEffect(() => {
    let cancelled = false;
    void fetch('/api/agent/trends?days=30', { cache: 'no-store' })
      .then(async (res) => {
        if (!res.ok) return;
        const data = (await res.json()) as ChannelTrendsResponse;
        if (!cancelled && data?.channels) {
          setChannelTrends(data.channels);
        }
      })
      .catch(() => {
        // Trend sparklines remain hidden if the trends endpoint is unreachable.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (architectMode && !health && !healthLoading) {
      void loadHealth();
    }
  }, [architectMode, health, healthLoading, loadHealth]);

  const transport = useMemo(
    () =>
      new DefaultChatTransport<RelayUIMessage>({
        api: '/api/agent/chat',
        fetch: async (inputUrl, init) => {
          userStoppedRef.current = false;
          let response: Response;
          try {
            response = await globalThis.fetch(inputUrl, init);
          } catch (fetchErr) {
            if (!userStoppedRef.current) {
              setBackendAlert({
                id: `network-${Date.now()}`,
                severity: 'error',
                title: 'CONNECTION ERROR',
                message:
                  'Could not reach the backend service. Check your connection and click Retry.',
                technicalDetail:
                  fetchErr instanceof Error ? fetchErr.message : String(fetchErr),
                retryable: true,
              });
            }
            throw fetchErr;
          }

          if (!response.ok) {
            try {
              const rawErr = await response.clone().text();
              setBackendAlert(buildHttpErrorAlert(response.status, rawErr));
            } catch {
              setBackendAlert(buildHttpErrorAlert(response.status, ''));
            }
            return response;
          }

          const contentType = response.headers.get('content-type') || '';
          if (
            !response.body ||
            !contentType.toLowerCase().includes('text/event-stream')
          ) {
            return response;
          }
          // Tee every SSE response so the AI SDK consumes `sdkStream`
          // unmodified while `tapStream` monitors stream completion (to catch
          // premature drops/timeouts) and captures wire frames in X-Ray mode.
          const [sdkStream, tapStream] = response.body.tee();
          const captureOrderIdx = turnCaptureCounterRef.current;
          turnCaptureCounterRef.current += 1;
          const startedAt =
            typeof performance !== 'undefined' ? performance.now() : Date.now();

          void (async () => {
            const reader = tapStream.getReader();
            const decoder = new TextDecoder('utf-8');
            let buffer = '';
            let messageIdKey: string | null = null;
            const collected: WireFrameRecord[] = [];
            let frameSeq = 0;
            let sawTerminalFrame = false;
            let sawErrorFrame = false;
            let lastErrorText = '';

            const pushFrame = (rawData: string) => {
              const now =
                typeof performance !== 'undefined' ? performance.now() : Date.now();
              const offsetMs = Math.max(0, Math.round(now - startedAt));
              let frameType = rawData === '[DONE]' ? '[DONE]' : 'data';
              let parsedObj: Record<string, unknown> | null = null;
              if (rawData === '[DONE]') {
                sawTerminalFrame = true;
              } else {
                try {
                  const candidate = JSON.parse(rawData) as unknown;
                  if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
                    parsedObj = candidate as Record<string, unknown>;
                    if (typeof parsedObj.type === 'string') {
                      frameType = parsedObj.type;
                    }
                    if (frameType === 'finish') {
                      sawTerminalFrame = true;
                    } else if (frameType === 'error') {
                      sawErrorFrame = true;
                      if (typeof parsedObj.errorText === 'string') {
                        lastErrorText = parsedObj.errorText;
                      }
                    } else if (
                      frameType === 'start' &&
                      typeof parsedObj.messageId === 'string' &&
                      parsedObj.messageId
                    ) {
                      messageIdKey = parsedObj.messageId;
                    }
                  }
                } catch {
                  // Preserve raw frame text even if non-JSON
                }
              }
              if (!architectModeRef.current) {
                return;
              }
              frameSeq += 1;
              collected.push({
                id: `${captureOrderIdx}-${frameSeq}`,
                offsetMs,
                type: frameType,
                raw: rawData,
                payload: parsedObj,
              });
              const snapshot = [...collected];
              if (messageIdKey) {
                const key = messageIdKey;
                setWireFramesByTurn((prev) => ({ ...prev, [key]: snapshot }));
                if (autoOpenNextXRayRef.current) {
                  autoOpenNextXRayRef.current = false;
                  setAutoOpenXRayKey(key);
                }
              }
              setWireFramesByOrder((prev) => {
                const next = [...prev];
                next[captureOrderIdx] = snapshot;
                return next;
              });
            };

            try {
              while (true) {
                const { value, done } = await reader.read();
                if (done) {
                  break;
                }
                buffer += decoder.decode(value, { stream: true });
                let splitIdx = buffer.indexOf('\n\n');
                while (splitIdx !== -1) {
                  const block = buffer.slice(0, splitIdx);
                  buffer = buffer.slice(splitIdx + 2);
                  const dataLines = block
                    .split('\n')
                    .filter((line) => line.startsWith('data:'))
                    .map((line) => line.slice(5).trim());
                  if (dataLines.length > 0) {
                    pushFrame(dataLines.join('\n'));
                  }
                  splitIdx = buffer.indexOf('\n\n');
                }
              }
              if (!userStoppedRef.current) {
                if (sawErrorFrame && lastErrorText) {
                  setBackendAlert({
                    id: `sse-error-${Date.now()}`,
                    severity: 'error',
                    title: lastErrorText.includes('No AI Gateway credential')
                      ? 'SETUP REQUIRED'
                      : 'REQUEST FAILED',
                    message: lastErrorText,
                    technicalDetail: `SSE error frame: ${lastErrorText}`,
                    retryable: true,
                  });
                } else if (!sawTerminalFrame) {
                  setBackendAlert({
                    id: `sse-dropped-${Date.now()}`,
                    severity: 'error',
                    title: 'RESPONSE INTERRUPTED',
                    message:
                      'The backend connection closed before finishing your request. Click Retry to run it again.',
                    technicalDetail: 'SSE stream ended before finish/[DONE] frame',
                    retryable: true,
                  });
                }
              }
            } catch {
              // Ignore aborted tap stream when user clicks Stop
            }
          })();

          return new Response(sdkStream, {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
          });
        },
        prepareSendMessagesRequest: ({ id, messages, trigger, body }) => {
          const perCallBody = (body ?? {}) as Record<string, unknown>;
          const resolvedTierHint =
            'tierHint' in perCallBody
              ? (perCallBody.tierHint as 'fast' | 'reasoning' | null)
              : trigger === 'regenerate-message'
                ? lastTierHintRef.current
                : null;

          // Bound history to 30 messages starting on a user turn to match
          // `backend/app/ui_messages.py`'s `MAX_MESSAGES` contract and prevent
          // orphaned leading assistant/tool messages from breaking tool-call pairing.
          const nonEmptyMessages = messages.filter(
            (msg) => msg.role !== 'assistant' || msg.parts.length > 0,
          );
          const sliced = nonEmptyMessages.slice(-30);
          const firstUserIdx = sliced.findIndex((m) => m.role === 'user');
          const bounded =
            firstUserIdx > 0 ? sliced.slice(firstUserIdx) : sliced;

          return {
            headers: workspaceIdRef.current
              ? { 'X-Relay-Workspace': workspaceIdRef.current }
              : undefined,
            body: {
              id,
              trigger,
              messages: bounded,
              twinMutations: readStoredMutations(),
              injectFailure: architectModeRef.current && injectFailureRef.current,
              ...perCallBody,
              tierHint: resolvedTierHint ?? null,
            },
          };
        },
      }),
    [],
  );

  const {
    messages,
    setMessages,
    sendMessage,
    regenerate,
    stop,
    status,
    error,
    clearError,
  } = useChat<RelayUIMessage>({
    transport,
    onError: (err) => {
      setBackendAlert((prev) => {
        if (prev) {
          return prev;
        }
        const msg = err?.message || 'Unable to process your request on the backend.';
        return {
          id: `sdk-err-${Date.now()}`,
          severity: 'error',
          title: msg.includes('No AI Gateway credential')
            ? 'SETUP REQUIRED'
            : 'REQUEST FAILED',
          message: msg,
          technicalDetail: msg,
          retryable: true,
        };
      });
    },
  });

  const isStreaming = status === 'submitted' || status === 'streaming';
  const [isHydratingChat, setIsHydratingChat] = useState(true);
  const [activeTurnStartMs, setActiveTurnStartMs] = useState<number | null>(null);
  const prevIsStreamingRef = useRef(false);

  useEffect(() => {
    if (isStreaming && !prevIsStreamingRef.current) {
      setActiveTurnStartMs(Date.now());
    }
    prevIsStreamingRef.current = isStreaming;
  }, [isStreaming]);

  const {
    latestUserRef,
    endSentinelRef,
    pinLatestTurn,
    jumpPill,
    jumpToLatest,
  } = useChatScroll({
    messages,
    isStreaming,
    isHydrating: isHydratingChat && !isStreaming,
  });

  useEffect(() => {
    if (chatHydratedRef.current) {
      return;
    }
    chatHydratedRef.current = true;
    const stored = readStoredChatMessages();
    if (stored.length > 0) {
      setMessages(stored);
    }

    const wsId = workspaceIdRef.current || getOrCreateWorkspaceId();
    workspaceIdRef.current = wsId;
    void (async () => {
      try {
        const snapshot = await fetchWorkspaceSnapshot(wsId);
        if (!snapshot || !snapshot.databaseConnected) {
          return;
        }
        dbConnectedRef.current = true;
        if (Array.isArray(snapshot.mutations) && snapshot.mutations.length > 0) {
          try {
            const derived = await fetchTwinState(snapshot.mutations);
            setActiveMutations(snapshot.mutations);
            setTwinState(derived);
          } catch {
            // Keep locally derived state if replay fails
          }
        }
        if (Array.isArray(snapshot.workflows) && snapshot.workflows.length > 0) {
          setSavedWorkflows(snapshot.workflows);
        }
        if (Array.isArray(snapshot.messages) && snapshot.messages.length > 0) {
          setMessages(snapshot.messages);
        }
      } finally {
        setIsHydratingChat(false);
      }
    })();
  }, [setMessages]);

  useEffect(() => {
    if (!chatHydratedRef.current || status !== 'ready') {
      return;
    }
    writeStoredChatMessages(messages);
    if (dbConnectedRef.current && workspaceIdRef.current) {
      void syncWorkspaceMessages(workspaceIdRef.current, messages).then((ok) => {
        if (!ok) {
          setSyncWarning({
            id: `sync-msg-${Date.now()}`,
            severity: 'warning',
            title: 'SAVED LOCALLY',
            message:
              'Your conversation is saved in this browser, but syncing to the cloud database failed.',
            technicalDetail: 'PUT /api/agent/workspace/messages failed',
            retryable: false,
          });
        }
      });
    }
  }, [messages, status]);

  useEffect(() => {
    let latestUpsertedId: string | null = null;
    let nextRecords: SavedWorkflowRecord[] | null = null;

    for (const msg of messages) {
      if (msg.role !== 'assistant') {
        continue;
      }
      for (const part of msg.parts) {
        if (
          part.type === 'tool-compile_workflow' &&
          part.state === 'output-available' &&
          part.output &&
          !seenWorkflowCallIdsRef.current.has(part.toolCallId)
        ) {
          seenWorkflowCallIdsRef.current.add(part.toolCallId);
          if (isValidWorkflowOutput(part.output)) {
            nextRecords = upsertStoredWorkflow(part.output);
            latestUpsertedId = part.output.workflowId;
          }
        } else if (
          part.type === 'dynamic-tool' &&
          part.toolName === 'compile_workflow' &&
          part.state === 'output-available' &&
          part.output &&
          !seenWorkflowCallIdsRef.current.has(part.toolCallId)
        ) {
          seenWorkflowCallIdsRef.current.add(part.toolCallId);
          if (isValidWorkflowOutput(part.output)) {
            nextRecords = upsertStoredWorkflow(part.output);
            latestUpsertedId = part.output.workflowId;
          }
        }
      }
    }

    if (nextRecords) {
      setSavedWorkflows(nextRecords);
      if (dbConnectedRef.current && workspaceIdRef.current) {
        void syncWorkspaceWorkflows(workspaceIdRef.current, nextRecords);
      }
      if (latestUpsertedId) {
        setSelectedWorkflowId(latestUpsertedId);
      }
    }
  }, [messages]);

  const handleSelectPlaybook = useCallback(
    (playbook: PlaybookDefinition) => {
      if (isStreaming) {
        return;
      }
      clearError();
      setHighlightedPlaybookId(playbook.id);
      setShareSlug(playbook.id);
      lastTierHintRef.current = playbook.tierHint;
      lastUserPromptRef.current = playbook.prompt;
      setPrimedTierHint(null);
      setPlaybooksExpanded(false);
      setInput('');
      void sendMessage(
        { text: playbook.prompt },
        {
          body: {
            tierHint: playbook.tierHint,
            twinMutations: readStoredMutations(),
            injectFailure: architectModeRef.current && injectFailureRef.current,
          },
        },
      );
    },
    [clearError, isStreaming, sendMessage],
  );

  const handleComposerChange = useCallback(
    (nextValue: string) => {
      setInput(nextValue);
      if (initialRemix && nextValue !== initialRemix.prompt) {
        setPrimedTierHint(null);
      }
    },
    [initialRemix],
  );

  const handleComposerSubmit = useCallback(() => {
    const trimmed = input.trim();
    if (!trimmed || isStreaming) {
      return;
    }
    clearError();
    const activeTierHint = primedTierHint;
    lastTierHintRef.current = activeTierHint;
    lastUserPromptRef.current = trimmed;
    setPrimedTierHint(null);
    setInput('');
    void sendMessage(
      { text: trimmed },
      {
        body: {
          tierHint: activeTierHint,
          twinMutations: readStoredMutations(),
          injectFailure: architectModeRef.current && injectFailureRef.current,
        },
      },
    );
  }, [clearError, input, isStreaming, primedTierHint, sendMessage]);

  const handleRetry = useCallback(() => {
    clearError();
    setBackendAlert(null);
    const hasUserMessage = messages.some((m) => m.role === 'user');
    if (hasUserMessage) {
      void regenerate({
        body: {
          tierHint: lastTierHintRef.current,
          twinMutations: readStoredMutations(),
          injectFailure: false,
        },
      });
      return;
    }
    if (lastUserPromptRef.current) {
      void sendMessage(
        { text: lastUserPromptRef.current },
        {
          body: {
            tierHint: lastTierHintRef.current,
            twinMutations: readStoredMutations(),
            injectFailure: false,
          },
        },
      );
    }
  }, [clearError, messages, regenerate, sendMessage]);

  const syncUndoneDecisions = useCallback((nextMutations: Mutation[]) => {
    setProposalDecisions((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const [callId, dec] of Object.entries(prev)) {
        if (dec !== 'approved') {
          continue;
        }
        const spec = approvedByCallIdRef.current[callId];
        if (!spec) {
          continue;
        }
        const stillPresent = nextMutations.some(
          (m) =>
            m.type === 'reallocate_budget' &&
            m.from_campaign === spec.from_campaign &&
            m.to_campaign === spec.to_campaign &&
            Math.abs(m.amount_per_day - spec.amount_per_day) < 0.01,
        );
        if (!stillPresent) {
          delete next[callId];
          delete approvedByCallIdRef.current[callId];
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, []);

  const handleApplyHygieneFix = useCallback(async () => {
    try {
      const prevSnapshot = readStoredMutations();
      const prevRisk = twinStateRef.current?.totals.spendAtRiskPerDay ?? 0;
      const { mutations, state } = await appendTwinMutations([
        { type: 'fix_utm_taxonomy' },
        { type: 'pause_broken_creatives' },
      ]);
      setChannelDeltas(computeChannelDeltas(twinStateRef.current, state));
      setTwinState(state);
      setActiveMutations(mutations);
      setTwinError(null);
      setBackendAlert(null);
      const protectedUsd = Math.max(
        0,
        Number((prevRisk - state.totals.spendAtRiskPerDay).toFixed(2)),
      );
      setImpactToast({
        id: `hyg-toast-${Date.now()}`,
        title: '✓ Ad & UTM fixes applied',
        detail:
          protectedUsd > 0
            ? `$${protectedUsd.toLocaleString('en-US', {
                minimumFractionDigits: 2,
                maximumFractionDigits: 2,
              })}/day protected · 0 open issues`
            : 'All active links & UTM tags healthy',
        tone: 'green',
        undoSnapshot: prevSnapshot,
      });
      if (dbConnectedRef.current && workspaceIdRef.current) {
        void syncWorkspaceMutations(workspaceIdRef.current, mutations).then(
          (res) => {
            if (!res) {
              setSyncWarning({
                id: `sync-mut-${Date.now()}`,
                severity: 'warning',
                title: 'SAVED LOCALLY',
                message:
                  'Your campaign fix is active in this browser, but syncing to the cloud database failed.',
                technicalDetail: 'PUT /api/agent/workspace/mutations failed',
                retryable: false,
              });
            }
          },
        );
      }
    } catch (err) {
      setBackendAlert({
        id: `hygiene-err-${Date.now()}`,
        severity: 'error',
        title: 'COULD NOT APPLY CAMPAIGN FIX',
        message:
          'The backend could not save your broken-link and UTM fixes. Please try again.',
        technicalDetail: err instanceof Error ? err.message : String(err),
        retryable: false,
      });
    }
  }, []);

  const handleApproveReallocation = useCallback(
    async (proposal: ReallocationToolOutput, decisionKey: string) => {
      try {
        const prevSnapshot = readStoredMutations();
        const prevRoas =
          twinStateRef.current?.totals.blendedRoas ?? proposal.blendedRoasBefore;
        const { mutations, state } = await appendTwinMutations([
          {
            type: 'reallocate_budget',
            from_campaign: proposal.fromCampaign,
            to_campaign: proposal.toCampaign,
            amount_per_day: proposal.amountPerDay,
          },
        ]);
        approvedByCallIdRef.current[decisionKey] = {
          from_campaign: proposal.fromCampaign,
          to_campaign: proposal.toCampaign,
          amount_per_day: proposal.amountPerDay,
        };
        setChannelDeltas(computeChannelDeltas(twinStateRef.current, state));
        setTwinState(state);
        setActiveMutations(mutations);
        setTwinError(null);
        setBackendAlert(null);
        const lift = state.totals.blendedRoas - prevRoas;
        setImpactToast({
          id: `realloc-toast-${Date.now()}`,
          title: `✓ Shifted $${Math.round(proposal.amountPerDay).toLocaleString('en-US')}/day`,
          detail: `Blended ROAS ${prevRoas.toFixed(2)}x → ${state.totals.blendedRoas.toFixed(2)}x (${
            lift >= 0 ? '+' : ''
          }${lift.toFixed(2)}x)`,
          tone: 'green',
          undoSnapshot: prevSnapshot,
        });
        if (dbConnectedRef.current && workspaceIdRef.current) {
          void syncWorkspaceMutations(workspaceIdRef.current, mutations).then(
            (res) => {
              if (!res) {
                setSyncWarning({
                  id: `sync-mut-${Date.now()}`,
                  severity: 'warning',
                  title: 'SAVED LOCALLY',
                  message:
                    'Your budget shift is active in this browser, but syncing to the cloud database failed.',
                  technicalDetail: 'PUT /api/agent/workspace/mutations failed',
                  retryable: false,
                });
              }
            },
          );
        }
        setProposalDecisions((prev) => ({
          ...prev,
          [decisionKey]: 'approved',
        }));
        clearError();
        const formattedShift = Math.round(proposal.amountPerDay).toLocaleString('en-US');
        const approvalText = `Approved $${formattedShift}/day budget shift from ${proposal.fromCampaignName || proposal.fromCampaign} to ${proposal.toCampaignName || proposal.toCampaign}.`;
        lastTierHintRef.current = 'reasoning';
        lastUserPromptRef.current = approvalText;
        void sendMessage(
          { text: approvalText },
          {
            body: {
              tierHint: 'reasoning',
              twinMutations: mutations,
              injectFailure: false,
            },
          },
        );
      } catch (err) {
        setBackendAlert({
          id: `realloc-err-${Date.now()}`,
          severity: 'error',
          title: 'COULD NOT APPLY BUDGET SHIFT',
          message:
            'The backend rejected or failed to save this budget shift. No budgets were changed.',
          technicalDetail: err instanceof Error ? err.message : String(err),
          retryable: false,
        });
      }
    },
    [clearError, sendMessage],
  );

  const handleDeclineReallocation = useCallback(
    (proposal: ReallocationToolOutput, decisionKey: string) => {
      setProposalDecisions((prev) => ({
        ...prev,
        [decisionKey]: 'declined',
      }));
      clearError();
      const declineText = `Declined budget shift for ${proposal.fromCampaignName || proposal.fromCampaign}.`;
      lastTierHintRef.current = 'reasoning';
      lastUserPromptRef.current = declineText;
      void sendMessage(
        { text: declineText },
        {
          body: {
            tierHint: 'reasoning',
            twinMutations: readStoredMutations(),
            injectFailure: false,
          },
        },
      );
    },
    [clearError, sendMessage],
  );

  const handleUndoSnapshot = useCallback(
    async (snapshot: Mutation[]) => {
      setMutationBusy(true);
      try {
        const { mutations, state } = await replaceTwinMutations(snapshot);
        setChannelDeltas(computeChannelDeltas(twinStateRef.current, state));
        setTwinState(state);
        setActiveMutations(mutations);
        syncUndoneDecisions(mutations);
        if (mutations.length === 0) {
          setChangesOpen(false);
        }
        setImpactToast({
          id: `undo-snap-${Date.now()}`,
          title: '↺ Change undone',
          detail: `Blended ROAS ${state.totals.blendedRoas.toFixed(2)}x · $${Math.round(
            state.totals.dailyBudget,
          ).toLocaleString('en-US')}/day`,
          tone: 'blue',
        });
        if (dbConnectedRef.current && workspaceIdRef.current) {
          void syncWorkspaceMutations(workspaceIdRef.current, mutations);
        }
      } catch (err) {
        setBackendAlert({
          id: `undo-err-${Date.now()}`,
          severity: 'error',
          title: 'COULD NOT UNDO CHANGE',
          message:
            'The backend could not revert your previous campaign change. Please try again.',
          technicalDetail: err instanceof Error ? err.message : String(err),
          retryable: false,
        });
      } finally {
        setMutationBusy(false);
      }
    },
    [syncUndoneDecisions],
  );

  const handleUndoMutationAt = useCallback(
    async (index: number) => {
      setMutationBusy(true);
      try {
        const { mutations, state } = await removeTwinMutationAt(index);
        setChannelDeltas(computeChannelDeltas(twinStateRef.current, state));
        setTwinState(state);
        setActiveMutations(mutations);
        syncUndoneDecisions(mutations);
        if (mutations.length === 0) {
          setChangesOpen(false);
        }
        setImpactToast({
          id: `undo-idx-${Date.now()}`,
          title: '↺ Change undone',
          detail: `Blended ROAS ${state.totals.blendedRoas.toFixed(2)}x · ${mutations.length} active ${
            mutations.length === 1 ? 'change' : 'changes'
          }`,
          tone: 'blue',
        });
        if (dbConnectedRef.current && workspaceIdRef.current) {
          void syncWorkspaceMutations(workspaceIdRef.current, mutations);
        }
      } catch (err) {
        setBackendAlert({
          id: `undo-item-err-${Date.now()}`,
          severity: 'error',
          title: 'COULD NOT UNDO CHANGE',
          message:
            'The backend could not remove that campaign change. Please try again.',
          technicalDetail: err instanceof Error ? err.message : String(err),
          retryable: false,
        });
      } finally {
        setMutationBusy(false);
      }
    },
    [syncUndoneDecisions],
  );

  const handleRevertAllMutations = useCallback(async () => {
    setMutationBusy(true);
    try {
      const prevSnapshot = readStoredMutations();
      const { mutations, state } = await replaceTwinMutations([]);
      approvedByCallIdRef.current = {};
      setProposalDecisions({});
      setChannelDeltas(computeChannelDeltas(twinStateRef.current, state));
      setTwinState(state);
      setActiveMutations(mutations);
      setChangesOpen(false);
      setImpactToast({
        id: `revert-all-${Date.now()}`,
        title: '↺ Reverted campaign changes',
        detail: `Restored baseline ${state.totals.blendedRoas.toFixed(2)}x blended ROAS while keeping chat history`,
        tone: 'blue',
        undoSnapshot: prevSnapshot.length > 0 ? prevSnapshot : undefined,
      });
      if (dbConnectedRef.current && workspaceIdRef.current) {
        void syncWorkspaceMutations(workspaceIdRef.current, mutations);
      }
    } catch (err) {
      setBackendAlert({
        id: `revert-all-err-${Date.now()}`,
        severity: 'error',
        title: 'COULD NOT REVERT CAMPAIGNS',
        message:
          'Unable to restore baseline campaign budgets and tracking state.',
        technicalDetail: err instanceof Error ? err.message : String(err),
        retryable: false,
      });
    } finally {
      setMutationBusy(false);
    }
  }, []);

  const handleResetDemo = useCallback(async () => {
    userStoppedRef.current = true;
    void stop();
    lastTierHintRef.current = null;
    lastUserPromptRef.current = '';
    clearError();
    setBackendAlert(null);
    setSyncWarning(null);
    setMessages([]);
    clearStoredChatMessages();
    approvedByCallIdRef.current = {};
    setProposalDecisions({});
    setActiveMutations([]);
    setChangesOpen(false);
    setImpactToast(null);
    setHasOpenedShareStudio(false);
    setChannelDeltas({});
    setWireFramesByTurn({});
    setWireFramesByOrder([]);
    setAutoOpenXRayKey(null);
    setPlaybooksExpanded(false);
    setInjectFailure(false);
    seenWorkflowCallIdsRef.current.clear();
    clearStoredWorkflows();
    setSavedWorkflows([]);
    setSelectedWorkflowId(null);
    setWorkflowsOpen(false);
    setInspectorOpen(false);
    setTwinError(null);
    setHighlightedPlaybookId(null);
    setPrimedTierHint(null);
    setInput('');
    try {
      const freshState = await resetTwinMutations();
      setBaselineTotals(freshState.totals);
      setTwinState(freshState);
      if (workspaceIdRef.current) {
        void resetRemoteWorkspace(workspaceIdRef.current);
      }
    } catch (err) {
      setTwinError(
        err instanceof Error ? err.message : 'Unable to reset campaign workspace.',
      );
    }
  }, [clearError, setMessages, stop]);

  const handleOpenWorkflowShare = useCallback((slug: string) => {
    setShareSlug(slug);
    setHasOpenedShareStudio(true);
    setShareModalOpen(true);
  }, []);

  const handleOpenWorkflowInDrawer = useCallback((workflowId: string) => {
    setSelectedWorkflowId(workflowId);
    setWorkflowsOpen(true);
  }, []);

  const handleRenameWorkflow = useCallback((workflowId: string, nextName: string) => {
    const updated = renameStoredWorkflow(workflowId, nextName);
    setSavedWorkflows(updated);
    if (dbConnectedRef.current && workspaceIdRef.current) {
      void syncWorkspaceWorkflows(workspaceIdRef.current, updated);
    }
  }, []);

  const handleRemoveWorkflow = useCallback((workflowId: string) => {
    const updated = removeStoredWorkflow(workflowId);
    setSavedWorkflows(updated);
    if (dbConnectedRef.current && workspaceIdRef.current) {
      void syncWorkspaceWorkflows(workspaceIdRef.current, updated);
    }
    setSelectedWorkflowId((prev) =>
      prev === workflowId ? updated[0]?.workflow.workflowId ?? null : prev,
    );
  }, []);

  const handleCompileSampleWorkflow = useCallback(() => {
    const pb = PLAYBOOKS.find((p) => p.id === 'daily-pacing-guardrail');
    if (pb) {
      handleSelectPlaybook(pb);
    }
  }, [handleSelectPlaybook]);

  const handleWorkflowPromptAction = useCallback(
    (prompt: string, tierHint: 'fast' | 'reasoning') => {
      if (isStreaming || !prompt.trim()) {
        return;
      }
      clearError();
      setBackendAlert(null);
      setWorkflowsOpen(false);
      setPlaybooksExpanded(false);
      lastTierHintRef.current = tierHint;
      lastUserPromptRef.current = prompt;
      setPrimedTierHint(null);
      setInput('');
      void sendMessage(
        { text: prompt },
        {
          body: {
            tierHint,
            twinMutations: readStoredMutations(),
            injectFailure: architectModeRef.current && injectFailureRef.current,
          },
        },
      );
    },
    [clearError, isStreaming, sendMessage],
  );

  const handleInspectChannel = useCallback(
    (
      channelName: string,
      focus: 'overview' | 'broken_404' | 'utm_violation',
    ) => {
      const { prompt, tierHint } = buildChannelDrilldownPrompt(channelName, focus);
      handleWorkflowPromptAction(prompt, tierHint);
    },
    [handleWorkflowPromptAction],
  );

  const handleOptimizePortfolio = useCallback(() => {
    handleWorkflowPromptAction(
      'Audit my portfolio ROAS and propose a budget shift from our weakest channel to our highest-performing channel.',
      'reasoning',
    );
  }, [handleWorkflowPromptAction]);

  const handleToggleArchitectMode = useCallback(() => {
    setArchitectMode((prev) => {
      const next = !prev;
      if (!next) {
        setInjectFailure(false);
        setInspectorOpen(false);
      }
      return next;
    });
  }, []);

  const handleOpenInspectorFromStrip = useCallback(
    (tab: 'runtime' | 'adapter' | 'deployment') => {
      setInspectorInitialTab(tab === 'runtime' ? 'all' : tab);
      setInspectorOpen(true);
    },
    [],
  );

  const handleRunDemoStep = useCallback(
    (step: DemoStepId) => {
      if (step === 'og') {
        setHasOpenedShareStudio(true);
        setShareModalOpen(true);
        return;
      }
      if (isStreaming) {
        return;
      }
      const playbookMap: Record<'sandbox' | 'xray' | 'failover', PlaybookId> = {
        sandbox: 'cross-channel-roas',
        xray: 'creative-404-guard',
        failover: 'paid-social-reallocation',
      };
      const pb = PLAYBOOKS.find((item) => item.id === playbookMap[step]);
      if (!pb) {
        return;
      }
      if (step === 'xray') {
        autoOpenNextXRayRef.current = true;
      }
      if (step === 'failover') {
        injectFailureRef.current = true;
        setInjectFailure(true);
      }
      handleSelectPlaybook(pb);
    },
    [handleSelectPlaybook, isStreaming],
  );

  const telemetryEntries = useMemo(() => {
    const entries: TelemetryData[] = [];
    for (const msg of messages) {
      if (msg.role !== 'assistant') {
        continue;
      }
      for (const part of msg.parts) {
        if (part.type === 'data-telemetry' && part.data) {
          entries.push(part.data);
        }
      }
    }
    return entries;
  }, [messages]);

  const totalTokensAvoided = useMemo(() => {
    let total = 0;
    for (const msg of messages) {
      if (msg.role !== 'assistant') {
        continue;
      }
      for (const part of msg.parts) {
        if (
          part.type === 'tool-analyze_in_sandbox' &&
          part.state === 'output-available' &&
          part.output &&
          typeof part.output.estTokensAvoided === 'number'
        ) {
          total += part.output.estTokensAvoided;
        } else if (
          part.type === 'dynamic-tool' &&
          part.toolName === 'analyze_in_sandbox' &&
          part.state === 'output-available' &&
          part.output &&
          typeof (part.output as SandboxToolOutput).estTokensAvoided === 'number'
        ) {
          total += (part.output as SandboxToolOutput).estTokensAvoided;
        }
      }
    }
    return total;
  }, [messages]);

  const completedDemoSteps = useMemo<Partial<Record<DemoStepId, boolean>>>(() => {
    let sandboxDone = false;
    for (const msg of messages) {
      if (msg.role !== 'assistant') {
        continue;
      }
      for (const part of msg.parts) {
        if (
          (part.type === 'tool-analyze_in_sandbox' &&
            part.state === 'output-available') ||
          (part.type === 'tool-propose_budget_reallocation' &&
            part.state === 'output-available') ||
          (part.type === 'dynamic-tool' &&
            (part.toolName === 'analyze_in_sandbox' ||
              part.toolName === 'propose_budget_reallocation') &&
            part.state === 'output-available')
        ) {
          sandboxDone = true;
        }
      }
    }
    const xrayDone =
      Object.keys(wireFramesByTurn).length > 0 || wireFramesByOrder.length > 0;
    const failoverDone = telemetryEntries.some((e) => e.failover !== 'none');
    return {
      sandbox: sandboxDone,
      xray: xrayDone,
      failover: failoverDone,
      og: hasOpenedShareStudio,
    };
  }, [
    messages,
    wireFramesByTurn,
    wireFramesByOrder,
    telemetryEntries,
    hasOpenedShareStudio,
  ]);

  const renderMessagePart = (
    part: RelayUIMessage['parts'][number],
    index: number,
    sandboxStatusByCallId: Record<string, SandboxStatusData>,
  ) => {
    switch (part.type) {
      case 'text': {
        if (!part.text.trim()) {
          return null;
        }
        return <MarkdownText key={`text-${index}`} text={part.text} />;
      }

      case 'data-telemetry':
      case 'data-sandbox-status':
      case 'data-agent-status':
      case 'step-start':
        return null;

      case 'tool-audit_campaign_hygiene': {
        const cardState = mapToolStateToCardState(part.state);
        return (
          <HygieneCard
            key={part.toolCallId}
            state={cardState}
            output={part.state === 'output-available' ? part.output : undefined}
            errorText={part.state === 'output-error' ? part.errorText : undefined}
            twinState={twinState}
            onApplyFix={handleApplyHygieneFix}
            onRetry={handleRetry}
          />
        );
      }

      case 'tool-analyze_in_sandbox': {
        const cardState = mapToolStateToCardState(part.state);
        return (
          <SandboxCard
            key={part.toolCallId}
            state={cardState}
            output={part.state === 'output-available' ? part.output : undefined}
            sandboxStatus={sandboxStatusByCallId[part.toolCallId] ?? null}
            errorText={part.state === 'output-error' ? part.errorText : undefined}
            onRetry={handleRetry}
          />
        );
      }

      case 'tool-propose_budget_reallocation': {
        const cardState = mapToolStateToCardState(part.state);
        const output = part.state === 'output-available' ? part.output : undefined;
        const decision = proposalDecisions[part.toolCallId] ?? null;
        return (
          <ReallocationCard
            key={part.toolCallId}
            state={cardState}
            output={output}
            errorText={part.state === 'output-error' ? part.errorText : undefined}
            decision={decision}
            disabled={isStreaming}
            architectMode={architectMode}
            campaigns={twinState?.campaigns}
            getMutations={readStoredMutations}
            onApprove={(proposal) =>
              handleApproveReallocation(proposal, part.toolCallId)
            }
            onDecline={(proposal) =>
              handleDeclineReallocation(proposal, part.toolCallId)
            }
            onRetry={handleRetry}
          />
        );
      }

      case 'tool-compile_workflow': {
        const cardState = mapToolStateToCardState(part.state);
        return (
          <WorkflowCard
            key={part.toolCallId}
            state={cardState}
            output={part.state === 'output-available' ? part.output : undefined}
            errorText={part.state === 'output-error' ? part.errorText : undefined}
            twinState={twinState}
            disabled={isStreaming}
            onShare={handleOpenWorkflowShare}
            onOpenInDrawer={handleOpenWorkflowInDrawer}
            onRunNextStepPrompt={handleWorkflowPromptAction}
            onRetry={handleRetry}
          />
        );
      }

      case 'dynamic-tool': {
        const cardState = mapToolStateToCardState(part.state);
        const errText = part.state === 'output-error' ? part.errorText : undefined;
        if (part.toolName === 'audit_campaign_hygiene') {
          return (
            <HygieneCard
              key={part.toolCallId}
              state={cardState}
              output={
                part.state === 'output-available'
                  ? (part.output as HygieneToolOutput)
                  : undefined
              }
              errorText={errText}
              twinState={twinState}
              onApplyFix={handleApplyHygieneFix}
              onRetry={handleRetry}
            />
          );
        }
        if (part.toolName === 'analyze_in_sandbox') {
          return (
            <SandboxCard
              key={part.toolCallId}
              state={cardState}
              output={
                part.state === 'output-available'
                  ? (part.output as SandboxToolOutput)
                  : undefined
              }
              sandboxStatus={sandboxStatusByCallId[part.toolCallId] ?? null}
              errorText={errText}
              onRetry={handleRetry}
            />
          );
        }
        if (part.toolName === 'propose_budget_reallocation') {
          const out =
            part.state === 'output-available'
              ? (part.output as ReallocationToolOutput)
              : undefined;
          const decision = proposalDecisions[part.toolCallId] ?? null;
          return (
            <ReallocationCard
              key={part.toolCallId}
              state={cardState}
              output={out}
              errorText={errText}
              decision={decision}
              disabled={isStreaming}
              architectMode={architectMode}
              campaigns={twinState?.campaigns}
              getMutations={readStoredMutations}
              onApprove={(proposal) =>
                handleApproveReallocation(proposal, part.toolCallId)
              }
              onDecline={(proposal) =>
                handleDeclineReallocation(proposal, part.toolCallId)
              }
              onRetry={handleRetry}
            />
          );
        }
        if (part.toolName === 'compile_workflow') {
          return (
            <WorkflowCard
              key={part.toolCallId}
              state={cardState}
              output={
                part.state === 'output-available'
                  ? (part.output as WorkflowToolOutput)
                  : undefined
              }
              errorText={errText}
              twinState={twinState}
              disabled={isStreaming}
              onShare={handleOpenWorkflowShare}
              onOpenInDrawer={handleOpenWorkflowInDrawer}
              onRunNextStepPrompt={handleWorkflowPromptAction}
              onRetry={handleRetry}
            />
          );
        }
        return null;
      }

      default: {
        const maybeErrorPart = part as { type?: string; errorText?: string };
        if (
          maybeErrorPart.type === 'error' &&
          typeof maybeErrorPart.errorText === 'string' &&
          maybeErrorPart.errorText !== error?.message
        ) {
          return (
            <div key={`err-${index}`} className="error-card" role="alert">
              <div className="error-card-row">
                <p className="error-card-body">{maybeErrorPart.errorText}</p>
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={handleRetry}
                >
                  Retry
                </button>
              </div>
            </div>
          );
        }
        return null;
      }
    }
  };

  const isMissingCredentialError = Boolean(
    error?.message && error.message.includes('No AI Gateway credential'),
  );

  let assistantOrderIndex = -1;

  return (
    <div className="workspace-page">
      <HeaderBar
        twinState={twinState}
        telemetryEntries={telemetryEntries}
        inspectorOpen={inspectorOpen}
        architectMode={architectMode}
        hasConversation={messages.length > 0}
        appliedMutationsCount={
          twinState?.totals.appliedMutations ?? activeMutations.length
        }
        changesOpen={changesOpen}
        workflowCount={savedWorkflows.length}
        workflowsOpen={workflowsOpen}
        onOpenShare={() => {
          setHasOpenedShareStudio(true);
          setShareModalOpen(true);
        }}
        onToggleChanges={() => setChangesOpen((prev) => !prev)}
        onToggleWorkflows={() => setWorkflowsOpen((prev) => !prev)}
        onToggleInspector={() => setInspectorOpen((prev) => !prev)}
        onToggleArchitectMode={handleToggleArchitectMode}
        onResetWorkspace={() => void handleResetDemo()}
      />

      <main className="workspace-main">
        {architectMode ? (
          <VercelArchitectureStrip
            health={health}
            healthPingMs={healthPingMs}
            injectFailure={injectFailure}
            isStreaming={isStreaming}
            completedSteps={completedDemoSteps}
            onToggleInjectFailure={setInjectFailure}
            onRunDemoStep={handleRunDemoStep}
            onOpenInspector={handleOpenInspectorFromStrip}
          />
        ) : null}

        <ChannelHealthStrip
          twinState={twinState}
          errorText={twinError}
          deltas={channelDeltas}
          trends={channelTrends}
          disabled={isStreaming}
          onRetry={() => void loadTwin()}
          onReset={() => void handleResetDemo()}
          onInspectChannel={handleInspectChannel}
          onOptimizePortfolio={handleOptimizePortfolio}
        />

        {messages.length === 0 ? (
          <PlaybookGrid
            highlightedPlaybookId={highlightedPlaybookId}
            disabled={isStreaming}
            twinState={twinState}
            workflowCount={savedWorkflows.length}
            onSelectPlaybook={handleSelectPlaybook}
          />
        ) : (
          <>
            <section
              className="playbooks-compact-bar"
              aria-label="Starter playbooks switcher"
              data-testid="playbooks-compact-bar"
            >
              <div className="playbooks-compact-header">
                <button
                  type="button"
                  className={
                    playbooksExpanded ? 'btn-chip btn-chip-active' : 'btn-chip'
                  }
                  aria-expanded={playbooksExpanded}
                  onClick={() => setPlaybooksExpanded((prev) => !prev)}
                  data-testid="playbooks-compact-toggle"
                >
                  {playbooksExpanded ? 'Hide playbooks' : 'Starter playbooks'}
                </button>
                <span className="playbooks-compact-hint">
                  Run another audit, ROAS breakdown, budget shift, or recurring check
                </span>
              </div>
              {playbooksExpanded ? (
                <PlaybookGrid
                  highlightedPlaybookId={highlightedPlaybookId}
                  disabled={isStreaming}
                  twinState={twinState}
                  workflowCount={savedWorkflows.length}
                  onSelectPlaybook={handleSelectPlaybook}
                />
              ) : null}
            </section>

            <section
              className="conversation-stream"
              aria-label="Campaign assistant conversation"
              data-testid="conversation-stream"
            >
              {(() => {
                let lastUserMsgIdx = -1;
                for (let idx = messages.length - 1; idx >= 0; idx -= 1) {
                  if (messages[idx]?.role === 'user') {
                    lastUserMsgIdx = idx;
                    break;
                  }
                }

                const renderTurn = (message: RelayUIMessage, msgIdx: number) => {
                  const isLastMessage = msgIdx === messages.length - 1;
                  if (message.role === 'user') {
                    const userText = message.parts
                      .filter(
                        (p): p is Extract<RelayUIMessage['parts'][number], { type: 'text' }> =>
                          p.type === 'text',
                      )
                      .map((p) => p.text)
                      .join('\n')
                      .trim();

                    if (!userText) {
                      return null;
                    }

                    const isLatestUser = msgIdx === lastUserMsgIdx;

                    return (
                      <article
                        key={message.id}
                        ref={isLatestUser ? latestUserRef : undefined}
                        className="message-turn message-user"
                        data-message-role="user"
                        data-latest-user={isLatestUser ? 'true' : undefined}
                      >
                        <div className="user-bubble">{userText}</div>
                      </article>
                    );
                  }

                  assistantOrderIndex += 1;
                  const currentAssistantIdx = assistantOrderIndex;

                  const sandboxStatusByCallId: Record<string, SandboxStatusData> = {};
                  const turnTelemetry: TelemetryData[] = [];
                  let latestAgentStatus: AgentStatusData | null = null;
                  let wasTruncated = false;
                  for (const part of message.parts) {
                    if (part.type === 'data-sandbox-status' && part.data?.toolCallId) {
                      sandboxStatusByCallId[part.data.toolCallId] = part.data;
                    } else if (part.type === 'data-telemetry' && part.data) {
                      turnTelemetry.push(part.data);
                    } else if (part.type === 'data-agent-status' && part.data?.label) {
                      if (part.data.phase === 'truncated') {
                        wasTruncated = true;
                      } else {
                        latestAgentStatus = part.data;
                      }
                    }
                  }

                  const succeededToolNames = collectSucceededToolNames(message.parts);
                  const renderedParts = message.parts
                    .map((part, idx) => {
                      if (
                        shouldSuppressRetriedToolError(
                          part,
                          succeededToolNames,
                          architectMode,
                        )
                      ) {
                        return null;
                      }
                      return renderMessagePart(part, idx, sandboxStatusByCallId);
                    })
                    .filter((node) => node !== null);

                  const capturedFrames = architectMode
                    ? wireFramesByTurn[message.id] ??
                      wireFramesByOrder[currentAssistantIdx] ??
                      []
                    : [];

                  if (renderedParts.length === 0 && !isStreaming) {
                    if (isLastMessage && !error && !backendAlert) {
                      return (
                        <article
                          key={message.id}
                          className="message-turn message-assistant"
                          data-message-role="assistant"
                        >
                          <BackendAlertBanner
                            alert={{
                              id: `empty-${message.id}`,
                              severity: 'error',
                              title: 'NO RESPONSE RECEIVED',
                              message:
                                'Relay did not return a reply for your last request. Click Retry to run it again.',
                              technicalDetail: 'Assistant turn completed with 0 rendered parts',
                              retryable: true,
                            }}
                            architectMode={architectMode}
                            onRetry={handleRetry}
                            testId="unanswered-turn-alert"
                          />
                        </article>
                      );
                    }
                    return null;
                  }

                  const showActiveStatus = isStreaming && isLastMessage;
                  const followUpChips =
                    isLastMessage && !isStreaming && !error && !backendAlert
                      ? buildTurnFollowUps({
                          parts: message.parts,
                          twinState,
                          proposalDecisions,
                        })
                      : [];
                  const progressSteps =
                    latestAgentStatus?.steps && latestAgentStatus.steps.length > 0
                      ? latestAgentStatus.steps
                      : OPTIMISTIC_SUBMIT_STEPS;
                  const activeFocusText =
                    latestAgentStatus?.focus ||
                    latestAgentStatus?.label ||
                    'Reviewing your active campaigns';
                  const showProgressCard =
                    showActiveStatus ||
                    Boolean(latestAgentStatus?.steps && latestAgentStatus.steps.length > 0);
                  const totalTelemetryMs = turnTelemetry.reduce(
                    (sum, entry) =>
                      sum + (Number.isFinite(entry.latencyMs) ? entry.latencyMs : 0),
                    0,
                  );

                  return (
                    <article
                      key={message.id}
                      className="message-turn message-assistant"
                      data-message-role="assistant"
                    >
                      <div className="assistant-parts-stack">
                        {showProgressCard ? (
                          <AgentProgressCard
                            steps={progressSteps}
                            focus={activeFocusText}
                            isStreaming={showActiveStatus}
                            hasError={Boolean(isLastMessage && (error || backendAlert))}
                            startedAtMs={showActiveStatus ? activeTurnStartMs : null}
                            completedDurationMs={
                              !showActiveStatus && totalTelemetryMs > 0
                                ? totalTelemetryMs
                                : null
                            }
                            testId="agent-activity-status"
                          />
                        ) : null}

                        {renderedParts}

                        {followUpChips.length > 0 ? (
                          <TurnFollowUps
                            chips={followUpChips}
                            disabled={isStreaming}
                            onSelect={handleWorkflowPromptAction}
                          />
                        ) : null}

                        {wasTruncated && !isStreaming ? (
                          <div
                            className="truncated-notice-bar"
                            role="status"
                            data-testid="truncated-response-notice"
                          >
                            <span>
                              This response reached the length limit and was cut short.
                            </span>
                            <button
                              type="button"
                              className="next-step-pill-btn"
                              onClick={() =>
                                handleWorkflowPromptAction(
                                  'Please continue your previous response from where it left off.',
                                  lastTierHintRef.current ?? 'fast',
                                )
                              }
                            >
                              <span>Continue response</span>
                              <span aria-hidden="true">→</span>
                            </button>
                          </div>
                        ) : null}

                        {architectMode && turnTelemetry.length > 0 ? (
                          <TelemetryStrip
                            entries={turnTelemetry}
                            onOpenFinOps={() => handleOpenInspectorFromStrip('runtime')}
                          />
                        ) : null}

                        {architectMode && capturedFrames.length > 0 ? (
                          <ProtocolXRay
                            frames={capturedFrames}
                            uiStreamSource={uiStreamSource}
                            defaultOpen={autoOpenXRayKey === message.id}
                          />
                        ) : null}
                      </div>
                    </article>
                  );
                };

                const splitIdx = lastUserMsgIdx >= 0 ? lastUserMsgIdx : messages.length;
                const priorNodes = messages
                  .slice(0, splitIdx)
                  .map((m, idx) => renderTurn(m, idx));
                const latestNodes = messages
                  .slice(splitIdx)
                  .map((m, offset) => renderTurn(m, splitIdx + offset));

                return (
                  <>
                    {priorNodes}
                    <div
                      className={`conversation-latest-anchor${
                        pinLatestTurn ? ' conversation-latest-anchor-pinned' : ''
                      }`}
                    >
                      {latestNodes}

                      {isStreaming && messages[messages.length - 1]?.role === 'user' ? (
                        <article
                          className="message-turn message-assistant"
                          data-message-role="assistant"
                        >
                          <AgentProgressCard
                            steps={OPTIMISTIC_SUBMIT_STEPS}
                            focus="Connecting to Relay and reviewing your campaigns"
                            isStreaming
                            startedAtMs={activeTurnStartMs}
                            testId="agent-activity-status"
                          />
                        </article>
                      ) : null}

                      {!isStreaming &&
                      !error &&
                      !backendAlert &&
                      messages.length > 0 &&
                      messages[messages.length - 1]?.role === 'user' ? (
                        <article
                          className="message-turn message-assistant"
                          data-message-role="assistant"
                        >
                          <BackendAlertBanner
                            alert={{
                              id: `unanswered-${messages[messages.length - 1].id}`,
                              severity: 'error',
                              title: 'NO RESPONSE RECEIVED',
                              message:
                                'Relay did not return a reply for your last request. Click Retry to try again.',
                              technicalDetail: 'Stream finished with no assistant message',
                              retryable: true,
                            }}
                            architectMode={architectMode}
                            onRetry={handleRetry}
                            testId="unanswered-turn-alert"
                          />
                        </article>
                      ) : null}

                      <div
                        ref={endSentinelRef}
                        className="conversation-end-sentinel"
                        aria-hidden="true"
                      />
                    </div>
                  </>
                );
              })()}
            </section>
          </>
        )}

        {syncWarning ? (
          <BackendAlertBanner
            alert={syncWarning}
            architectMode={architectMode}
            onDismiss={() => setSyncWarning(null)}
            testId="sync-warning-banner"
          />
        ) : null}

        {backendAlert ? (
          <BackendAlertBanner
            alert={backendAlert}
            architectMode={architectMode}
            onRetry={backendAlert.retryable ? handleRetry : undefined}
            onDismiss={() => {
              setBackendAlert(null);
              clearError();
            }}
            testId={
              backendAlert.title === 'SETUP REQUIRED'
                ? 'setup-error-card'
                : 'stream-error-card'
            }
          />
        ) : error ? (
          <section
            className={`error-card${isMissingCredentialError ? ' setup-card' : ''}`}
            role="alert"
            data-testid={
              isMissingCredentialError ? 'setup-error-card' : 'stream-error-card'
            }
          >
            <div className="error-card-row">
              <div>
                <div className="tool-card-eyebrow error-eyebrow">
                  {isMissingCredentialError
                    ? 'SETUP REQUIRED'
                    : 'CONNECTION ERROR'}
                </div>
                <p className="error-card-body">{error.message}</p>
              </div>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={handleRetry}
                data-testid="error-retry-button"
              >
                Retry
              </button>
            </div>
          </section>
        ) : null}
      </main>

      <div className="composer-dock">
        <ImpactToast
          toast={impactToast}
          busy={mutationBusy}
          onUndo={(snapshot) => void handleUndoSnapshot(snapshot)}
          onJumpTop={() => {
            if (typeof window !== 'undefined') {
              window.scrollTo({ top: 0, behavior: 'smooth' });
            }
          }}
          onDismiss={() => setImpactToast(null)}
        />

        {jumpPill.visible ? (
          <div className="jump-to-latest-wrap">
            <button
              type="button"
              className={`jump-to-latest-pill${
                jumpPill.isStreaming ? ' jump-to-latest-pill-streaming' : ''
              }`}
              onClick={jumpToLatest}
              aria-label={jumpPill.label}
              data-testid="jump-to-latest-pill"
            >
              {jumpPill.isStreaming ? (
                <span className="jump-to-latest-dot" aria-hidden="true" />
              ) : null}
              <span aria-hidden="true">↓</span>
              <span>{jumpPill.label}</span>
            </button>
          </div>
        ) : null}

        <Composer
          value={input}
          isStreaming={isStreaming}
          primedTierHint={primedTierHint}
          health={health}
          injectFailure={injectFailure}
          architectMode={architectMode}
          hasConversation={messages.length > 0}
          onChange={handleComposerChange}
          onSubmit={handleComposerSubmit}
          onStop={() => {
            userStoppedRef.current = true;
            void stop();
          }}
        />
      </div>

      <ShareModal
        isOpen={shareModalOpen}
        initialSlug={shareSlug}
        onClose={() => setShareModalOpen(false)}
      />

      <ChangesPopover
        isOpen={changesOpen}
        mutations={activeMutations}
        baselineTotals={baselineTotals}
        currentTotals={twinState?.totals ?? null}
        campaigns={twinState?.campaigns}
        busy={mutationBusy}
        onUndoAt={(idx) => void handleUndoMutationAt(idx)}
        onRevertAllMutations={() => void handleRevertAllMutations()}
        onResetFullWorkspace={() => void handleResetDemo()}
        onClose={() => setChangesOpen(false)}
      />

      <WorkflowsDrawer
        isOpen={workflowsOpen}
        workflows={savedWorkflows}
        selectedWorkflowId={selectedWorkflowId}
        twinState={twinState}
        isStreaming={isStreaming}
        onSelectWorkflow={setSelectedWorkflowId}
        onRenameWorkflow={handleRenameWorkflow}
        onRemoveWorkflow={handleRemoveWorkflow}
        onShareWorkflow={handleOpenWorkflowShare}
        onRunNextStepPrompt={handleWorkflowPromptAction}
        onCompileSample={handleCompileSampleWorkflow}
        onClose={() => setWorkflowsOpen(false)}
      />

      {architectMode ? (
        <InspectorDrawer
          isOpen={inspectorOpen}
          initialTab={inspectorInitialTab}
          injectFailure={injectFailure}
          telemetryEntries={telemetryEntries}
          totalTokensAvoided={totalTokensAvoided}
          messages={messages}
          uiStreamSource={uiStreamSource}
          health={health}
          healthLoading={healthLoading}
          onClose={() => setInspectorOpen(false)}
          onToggleInjectFailure={setInjectFailure}
          onRefreshHealth={() => void loadHealth()}
          onResetDemo={handleResetDemo}
        />
      ) : null}
    </div>
  );
}
