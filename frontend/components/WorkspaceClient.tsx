'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport } from 'ai';
import { ChannelHealthStrip } from './ChannelHealthStrip';
import { Composer } from './Composer';
import { HeaderBar } from './HeaderBar';
import { HygieneCard } from './HygieneCard';
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
import { PLAYBOOKS } from '@/lib/playbooks';
import {
  appendTwinMutations,
  fetchTwinState,
  readStoredMutations,
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
import type {
  ChannelDelta,
  DerivedTwinState,
  HealthStatus,
  HygieneToolOutput,
  PlaybookDefinition,
  PlaybookId,
  ReallocationToolOutput,
  RelayUIMessage,
  ResolvedPlaybook,
  SandboxStatusData,
  SandboxToolOutput,
  SavedWorkflowRecord,
  TelemetryData,
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
  uiStreamSource: string;
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
  uiStreamSource,
}: WorkspaceClientProps) {
  const [twinState, setTwinState] = useState<DerivedTwinState | null>(null);
  const [channelDeltas, setChannelDeltas] = useState<Record<string, ChannelDelta>>({});
  const [twinError, setTwinError] = useState<string | null>(null);
  const [health, setHealth] = useState<HealthStatus | null>(null);
  const [healthPingMs, setHealthPingMs] = useState<number | null>(null);
  const [healthLoading, setHealthLoading] = useState(false);

  const [input, setInput] = useState<string>(() => initialRemix?.prompt ?? '');
  const [highlightedPlaybookId, setHighlightedPlaybookId] =
    useState<PlaybookId | null>(() => initialRemix?.template ?? null);
  const [primedTierHint, setPrimedTierHint] = useState<'fast' | 'reasoning' | null>(
    () => initialRemix?.tierHint ?? null,
  );

  const [injectFailure, setInjectFailure] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [inspectorInitialTab, setInspectorInitialTab] = useState<
    'all' | 'adapter' | 'deployment'
  >('all');
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
  const [proposalDecisions, setProposalDecisions] = useState<
    Record<string, 'approved' | 'declined'>
  >({});

  const injectFailureRef = useRef(injectFailure);
  injectFailureRef.current = injectFailure;
  const twinStateRef = useRef<DerivedTwinState | null>(twinState);
  twinStateRef.current = twinState;
  const turnCaptureCounterRef = useRef(0);
  const autoOpenNextXRayRef = useRef(false);
  const seenWorkflowCallIdsRef = useRef<Set<string>>(new Set());

  const lastTierHintRef = useRef<'fast' | 'reasoning' | null>(
    initialRemix?.tierHint ?? null,
  );
  const lastUserPromptRef = useRef<string>('');

  const loadTwin = useCallback(async () => {
    setTwinError(null);
    try {
      const stored = readStoredMutations();
      const derived = await fetchTwinState(stored);
      setTwinState(derived);
    } catch (err) {
      setTwinError(
        err instanceof Error
          ? err.message
          : 'Failed to load Digital Twin state from Python service.',
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
    void loadTwin();
    void loadHealth();
    setSavedWorkflows(readStoredWorkflows());
  }, [loadTwin, loadHealth]);

  const transport = useMemo(
    () =>
      new DefaultChatTransport<RelayUIMessage>({
        api: '/api/agent/chat',
        fetch: async (inputUrl, init) => {
          const response = await globalThis.fetch(inputUrl, init);
          const contentType = response.headers.get('content-type') || '';
          if (!response.body || !contentType.toLowerCase().includes('text/event-stream')) {
            return response;
          }
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

            const pushFrame = (rawData: string) => {
              const now =
                typeof performance !== 'undefined' ? performance.now() : Date.now();
              const offsetMs = Math.max(0, Math.round(now - startedAt));
              let frameType = rawData === '[DONE]' ? '[DONE]' : 'data';
              let parsedObj: Record<string, unknown> | null = null;
              if (rawData !== '[DONE]') {
                try {
                  const candidate = JSON.parse(rawData) as unknown;
                  if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
                    parsedObj = candidate as Record<string, unknown>;
                    if (typeof parsedObj.type === 'string') {
                      frameType = parsedObj.type;
                    }
                    if (
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
              frameSeq += 1;
              collected.push({
                id: `${captureOrderIdx}-${frameSeq}`,
                offsetMs,
                type: frameType,
                raw: rawData,
                payload: parsedObj,
              });
            };

            try {
              while (true) {
                const { value, done } = await reader.read();
                buffer += value
                  ? decoder.decode(value, { stream: !done })
                  : decoder.decode();
                buffer = buffer.replace(/\r\n/g, '\n');

                let boundary = buffer.indexOf('\n\n');
                while (boundary !== -1) {
                  const block = buffer.slice(0, boundary);
                  buffer = buffer.slice(boundary + 2);
                  const dataPayload = block
                    .split('\n')
                    .filter((line) => line.startsWith('data:'))
                    .map((line) => line.slice(5).trimStart())
                    .join('\n')
                    .trim();
                  if (dataPayload) {
                    pushFrame(dataPayload);
                  }
                  boundary = buffer.indexOf('\n\n');
                }
                if (done) {
                  break;
                }
              }
            } catch {
              // Ignore aborted stream taps
            } finally {
              if (collected.length > 0) {
                const snapshot = [...collected];
                setWireFramesByOrder((prev) => {
                  const next = [...prev];
                  next[captureOrderIdx] = snapshot;
                  return next;
                });
                if (messageIdKey) {
                  const resolvedKey = messageIdKey;
                  setWireFramesByTurn((prev) => ({
                    ...prev,
                    [resolvedKey]: snapshot,
                  }));
                  if (autoOpenNextXRayRef.current) {
                    autoOpenNextXRayRef.current = false;
                    setAutoOpenXRayKey(resolvedKey);
                  }
                }
              }
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

          const nonEmptyMessages = messages.filter(
            (msg) => msg.role !== 'assistant' || msg.parts.length > 0,
          );
          const sliced = nonEmptyMessages.slice(-30);
          const firstUserIdx = sliced.findIndex((m) => m.role === 'user');
          const bounded =
            firstUserIdx > 0 ? sliced.slice(firstUserIdx) : sliced;

          return {
            body: {
              id,
              trigger,
              messages: bounded,
              twinMutations: readStoredMutations(),
              injectFailure: injectFailureRef.current,
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
  } = useChat<RelayUIMessage>({ transport });

  const isStreaming = status === 'submitted' || status === 'streaming';

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
      if (latestUpsertedId) {
        setSelectedWorkflowId(latestUpsertedId);
      }
    }
  }, [messages]);

  const allTelemetryEntries = useMemo(() => {
    const entries: TelemetryData[] = [];
    for (const msg of messages) {
      if (msg.role !== 'assistant') {
        continue;
      }
      for (const part of msg.parts) {
        if (part.type === 'data-telemetry') {
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
          part.output
        ) {
          total += part.output.estTokensAvoided || 0;
        } else if (
          part.type === 'dynamic-tool' &&
          part.toolName === 'analyze_in_sandbox' &&
          part.state === 'output-available' &&
          part.output
        ) {
          const out = part.output as SandboxToolOutput;
          total += out.estTokensAvoided || 0;
        }
      }
    }
    return total;
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
      setInput('');
      void sendMessage(
        { text: playbook.prompt },
        {
          body: {
            tierHint: playbook.tierHint,
            twinMutations: readStoredMutations(),
            injectFailure: injectFailureRef.current,
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
          injectFailure: injectFailureRef.current,
        },
      },
    );
  }, [clearError, input, isStreaming, primedTierHint, sendMessage]);

  const handleRetry = useCallback(() => {
    clearError();
    const hasUserMessage = messages.some((m) => m.role === 'user');
    if (hasUserMessage) {
      void regenerate({
        body: {
          tierHint: lastTierHintRef.current,
          twinMutations: readStoredMutations(),
          injectFailure: injectFailureRef.current,
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
            injectFailure: injectFailureRef.current,
          },
        },
      );
    }
  }, [clearError, messages, regenerate, sendMessage]);

  const handleApplyHygieneFix = useCallback(async () => {
    const { state } = await appendTwinMutations([
      { type: 'fix_utm_taxonomy' },
      { type: 'pause_broken_creatives' },
    ]);
    setChannelDeltas(computeChannelDeltas(twinStateRef.current, state));
    setTwinState(state);
    setTwinError(null);
  }, []);

  const handleApproveReallocation = useCallback(
    async (proposal: ReallocationToolOutput, decisionKey: string) => {
      const { mutations, state } = await appendTwinMutations([
        {
          type: 'reallocate_budget',
          from_campaign: proposal.fromCampaign,
          to_campaign: proposal.toCampaign,
          amount_per_day: proposal.amountPerDay,
        },
      ]);
      setChannelDeltas(computeChannelDeltas(twinStateRef.current, state));
      setTwinState(state);
      setTwinError(null);
      setProposalDecisions((prev) => ({
        ...prev,
        [decisionKey]: 'approved',
      }));
      clearError();
      const approvalText = `Approved proposal ${proposal.proposalId}.`;
      lastTierHintRef.current = 'reasoning';
      lastUserPromptRef.current = approvalText;
      void sendMessage(
        { text: approvalText },
        {
          body: {
            tierHint: 'reasoning',
            twinMutations: mutations,
            injectFailure: injectFailureRef.current,
          },
        },
      );
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
      const declineText = `Declined proposal ${proposal.proposalId}.`;
      lastTierHintRef.current = 'reasoning';
      lastUserPromptRef.current = declineText;
      void sendMessage(
        { text: declineText },
        {
          body: {
            tierHint: 'reasoning',
            twinMutations: readStoredMutations(),
            injectFailure: injectFailureRef.current,
          },
        },
      );
    },
    [clearError, sendMessage],
  );

  const handleResetDemo = useCallback(async () => {
    void stop();
    lastTierHintRef.current = null;
    lastUserPromptRef.current = '';
    clearError();
    setMessages([]);
    setProposalDecisions({});
    setInjectFailure(false);
    setChannelDeltas({});
    setWireFramesByTurn({});
    setWireFramesByOrder([]);
    setAutoOpenXRayKey(null);
    turnCaptureCounterRef.current = 0;
    seenWorkflowCallIdsRef.current.clear();
    clearStoredWorkflows();
    setSavedWorkflows([]);
    setSelectedWorkflowId(null);
    setWorkflowsOpen(false);
    setTwinError(null);
    setHighlightedPlaybookId(null);
    setPrimedTierHint(null);
    setInput('');
    try {
      const freshState = await resetTwinMutations();
      setTwinState(freshState);
    } catch (err) {
      setTwinError(
        err instanceof Error ? err.message : 'Unable to reset Digital Twin state.',
      );
    }
  }, [clearError, setMessages, stop]);

  const handleOpenWorkflowShare = useCallback((slug: string) => {
    setShareSlug(slug);
    setShareModalOpen(true);
  }, []);

  const handleOpenWorkflowInDrawer = useCallback((workflowId: string) => {
    setInspectorOpen(false);
    setSelectedWorkflowId(workflowId);
    setWorkflowsOpen(true);
  }, []);

  const handleRenameWorkflow = useCallback((workflowId: string, nextName: string) => {
    setSavedWorkflows(renameStoredWorkflow(workflowId, nextName));
  }, []);

  const handleRemoveWorkflow = useCallback((workflowId: string) => {
    const updated = removeStoredWorkflow(workflowId);
    setSavedWorkflows(updated);
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

  const handleOpenInspectorTab = useCallback(
    (tab: 'all' | 'adapter' | 'deployment') => {
      setWorkflowsOpen(false);
      setInspectorInitialTab(tab);
      setInspectorOpen(true);
    },
    [],
  );

  const handleRunDemoStep = useCallback(
    (step: 'sandbox' | 'xray' | 'failover' | 'og') => {
      if (step === 'og') {
        setShareModalOpen(true);
        return;
      }
      if (isStreaming) {
        return;
      }
      if (step === 'sandbox') {
        const pb = PLAYBOOKS.find((p) => p.id === 'cross-channel-roas');
        if (pb) {
          handleSelectPlaybook(pb);
        }
        return;
      }
      if (step === 'xray') {
        const latestAssistant = [...messages]
          .reverse()
          .find((m) => m.role === 'assistant');
        if (latestAssistant && wireFramesByTurn[latestAssistant.id]?.length) {
          setAutoOpenXRayKey(latestAssistant.id);
          return;
        }
        autoOpenNextXRayRef.current = true;
        const pb = PLAYBOOKS.find((p) => p.id === 'creative-404-guard');
        if (pb) {
          handleSelectPlaybook(pb);
        }
        return;
      }
      if (step === 'failover') {
        injectFailureRef.current = true;
        setInjectFailure(true);
        const pb = PLAYBOOKS.find((p) => p.id === 'paid-social-reallocation');
        if (pb) {
          handleSelectPlaybook(pb);
        }
      }
    },
    [handleSelectPlaybook, isStreaming, messages, wireFramesByTurn],
  );

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
            onShare={handleOpenWorkflowShare}
            onOpenInDrawer={handleOpenWorkflowInDrawer}
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
              onShare={handleOpenWorkflowShare}
              onOpenInDrawer={handleOpenWorkflowInDrawer}
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

  return (
    <div className="workspace-page">
      <HeaderBar
        twinState={twinState}
        telemetryEntries={allTelemetryEntries}
        inspectorOpen={inspectorOpen}
        workflowCount={savedWorkflows.length}
        workflowsOpen={workflowsOpen}
        onOpenShare={() => setShareModalOpen(true)}
        onToggleWorkflows={() => {
          setInspectorOpen(false);
          setWorkflowsOpen((prev) => !prev);
        }}
        onToggleInspector={() => {
          setWorkflowsOpen(false);
          setInspectorOpen((prev) => !prev);
        }}
      />

      <main className="workspace-main">
        <VercelArchitectureStrip
          health={health}
          healthPingMs={healthPingMs}
          injectFailure={injectFailure}
          isStreaming={isStreaming}
          onToggleInjectFailure={setInjectFailure}
          onRunDemoStep={handleRunDemoStep}
          onOpenInspector={(tab) =>
            handleOpenInspectorTab(tab === 'runtime' ? 'all' : tab)
          }
        />

        <ChannelHealthStrip
          twinState={twinState}
          errorText={twinError}
          deltas={channelDeltas}
          onRetry={() => void loadTwin()}
          onReset={() => void handleResetDemo()}
        />

        {messages.length === 0 ? (
          <PlaybookGrid
            highlightedPlaybookId={highlightedPlaybookId}
            disabled={isStreaming}
            onSelectPlaybook={handleSelectPlaybook}
          />
        ) : (
          <section
            className="conversation-stream"
            aria-label="Agent conversation"
            data-testid="conversation-stream"
          >
            {(() => {
              let assistantOrdinal = -1;
              return messages.map((message) => {
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

                  return (
                    <article
                      key={message.id}
                      className="message-turn message-user"
                      data-message-role="user"
                    >
                      <div className="user-bubble">{userText}</div>
                    </article>
                  );
                }

                assistantOrdinal += 1;
                const turnTelemetry = message.parts
                  .filter(
                    (
                      p,
                    ): p is Extract<
                      RelayUIMessage['parts'][number],
                      { type: 'data-telemetry' }
                    > => p.type === 'data-telemetry',
                  )
                  .map((p) => p.data);

                const sandboxStatusByCallId: Record<string, SandboxStatusData> = {};
                for (const part of message.parts) {
                  if (part.type === 'data-sandbox-status' && part.data?.toolCallId) {
                    sandboxStatusByCallId[part.data.toolCallId] = part.data;
                  }
                }

                const renderedParts = message.parts
                  .map((part, idx) =>
                    renderMessagePart(part, idx, sandboxStatusByCallId),
                  )
                  .filter((node) => node !== null);

                const turnWireFrames =
                  wireFramesByTurn[message.id] ??
                  wireFramesByOrder[assistantOrdinal] ??
                  [];

                if (
                  turnTelemetry.length === 0 &&
                  renderedParts.length === 0 &&
                  !isStreaming
                ) {
                  return null;
                }

                return (
                  <article
                    key={message.id}
                    className="message-turn message-assistant"
                    data-message-role="assistant"
                  >
                    <TelemetryStrip
                      entries={turnTelemetry}
                      onOpenFinOps={() => handleOpenInspectorTab('all')}
                    />
                    {turnWireFrames.length > 0 ? (
                      <ProtocolXRay
                        key={`${message.id}-${autoOpenXRayKey === message.id ? 'open' : 'closed'}`}
                        frames={turnWireFrames}
                        uiStreamSource={uiStreamSource}
                        defaultOpen={autoOpenXRayKey === message.id}
                      />
                    ) : null}
                    {renderedParts.length > 0 ? (
                      <div className="assistant-parts-stack">{renderedParts}</div>
                    ) : isStreaming ? (
                      <div className="assistant-streaming-placeholder" aria-live="polite">
                        Streaming response from Python FastAPI + LangGraph service…
                      </div>
                    ) : null}
                  </article>
                );
              });
            })()}
          </section>
        )}

        {error ? (
          <section
            className={`error-card${isMissingCredentialError ? ' setup-card' : ''}`}
            role="alert"
            data-testid={isMissingCredentialError ? 'setup-error-card' : 'stream-error-card'}
          >
            <div className="error-card-row">
              <div>
                <div className="tool-card-eyebrow error-eyebrow">
                  {isMissingCredentialError
                    ? 'AI GATEWAY CREDENTIAL SETUP REQUIRED'
                    : 'AGENT STREAM ERROR'}
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

      <Composer
        value={input}
        isStreaming={isStreaming}
        primedTierHint={primedTierHint}
        health={health}
        injectFailure={injectFailure}
        onChange={handleComposerChange}
        onSubmit={handleComposerSubmit}
        onStop={() => void stop()}
      />

      <ShareModal
        isOpen={shareModalOpen}
        initialSlug={shareSlug}
        onClose={() => setShareModalOpen(false)}
      />

      <WorkflowsDrawer
        isOpen={workflowsOpen}
        workflows={savedWorkflows}
        selectedWorkflowId={selectedWorkflowId}
        onSelectWorkflow={setSelectedWorkflowId}
        onRenameWorkflow={handleRenameWorkflow}
        onRemoveWorkflow={handleRemoveWorkflow}
        onShareWorkflow={handleOpenWorkflowShare}
        onCompileSample={handleCompileSampleWorkflow}
        onClose={() => setWorkflowsOpen(false)}
      />

      <InspectorDrawer
        isOpen={inspectorOpen}
        initialTab={inspectorInitialTab}
        injectFailure={injectFailure}
        telemetryEntries={allTelemetryEntries}
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
    </div>
  );
}
