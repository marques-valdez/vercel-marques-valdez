'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport } from 'ai';
import { ChannelHealthStrip } from './ChannelHealthStrip';
import { Composer } from './Composer';
import { HeaderBar } from './HeaderBar';
import { HygieneCard } from './HygieneCard';
import { PlaybookGrid } from './PlaybookGrid';
import { ReallocationCard } from './ReallocationCard';
import { SandboxCard } from './SandboxCard';
import { ShareModal } from './ShareModal';
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
  HygieneToolOutput,
  PlaybookDefinition,
  PlaybookId,
  ReallocationToolOutput,
  RelayUIMessage,
  ResolvedPlaybook,
  SandboxStatusData,
  SandboxToolOutput,
  SavedWorkflowRecord,
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

export function WorkspaceClient({ initialRemix }: WorkspaceClientProps) {
  const [twinState, setTwinState] = useState<DerivedTwinState | null>(null);
  const [channelDeltas, setChannelDeltas] = useState<Record<string, ChannelDelta>>({});
  const [twinError, setTwinError] = useState<string | null>(null);

  const [input, setInput] = useState<string>(() => initialRemix?.prompt ?? '');
  const [highlightedPlaybookId, setHighlightedPlaybookId] =
    useState<PlaybookId | null>(() => initialRemix?.template ?? null);
  const [primedTierHint, setPrimedTierHint] = useState<'fast' | 'reasoning' | null>(
    () => initialRemix?.tierHint ?? null,
  );

  const [savedWorkflows, setSavedWorkflows] = useState<SavedWorkflowRecord[]>([]);
  const [workflowsOpen, setWorkflowsOpen] = useState(false);
  const [selectedWorkflowId, setSelectedWorkflowId] = useState<string | null>(null);
  const [shareSlug, setShareSlug] = useState<string>(
    () => initialRemix?.slug ?? 'creative-404-guard',
  );
  const [shareModalOpen, setShareModalOpen] = useState(false);
  const [proposalDecisions, setProposalDecisions] = useState<
    Record<string, 'approved' | 'declined'>
  >({});

  const twinStateRef = useRef<DerivedTwinState | null>(twinState);
  twinStateRef.current = twinState;
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
          : 'Unable to load campaign workspace.',
      );
    }
  }, []);

  useEffect(() => {
    void loadTwin();
    setSavedWorkflows(readStoredWorkflows());
  }, [loadTwin]);

  const transport = useMemo(
    () =>
      new DefaultChatTransport<RelayUIMessage>({
        api: '/api/agent/chat',
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
              injectFailure: false,
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
            injectFailure: false,
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
          injectFailure: false,
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
      const approvalText = `Approved budget shift from ${proposal.fromCampaignName || proposal.fromCampaign} to ${proposal.toCampaignName || proposal.toCampaign}.`;
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

  const handleResetDemo = useCallback(async () => {
    void stop();
    lastTierHintRef.current = null;
    lastUserPromptRef.current = '';
    clearError();
    setMessages([]);
    setProposalDecisions({});
    setChannelDeltas({});
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
        err instanceof Error ? err.message : 'Unable to reset campaign workspace.',
      );
    }
  }, [clearError, setMessages, stop]);

  const handleOpenWorkflowShare = useCallback((slug: string) => {
    setShareSlug(slug);
    setShareModalOpen(true);
  }, []);

  const handleOpenWorkflowInDrawer = useCallback((workflowId: string) => {
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
        workflowCount={savedWorkflows.length}
        workflowsOpen={workflowsOpen}
        onOpenShare={() => setShareModalOpen(true)}
        onToggleWorkflows={() => setWorkflowsOpen((prev) => !prev)}
        onResetWorkspace={() => void handleResetDemo()}
      />

      <main className="workspace-main">
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
            aria-label="Campaign assistant conversation"
            data-testid="conversation-stream"
          >
            {messages.map((message) => {
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

              if (renderedParts.length === 0 && !isStreaming) {
                return null;
              }

              return (
                <article
                  key={message.id}
                  className="message-turn message-assistant"
                  data-message-role="assistant"
                >
                  {renderedParts.length > 0 ? (
                    <div className="assistant-parts-stack">{renderedParts}</div>
                  ) : isStreaming ? (
                    <div
                      className="assistant-streaming-placeholder"
                      aria-live="polite"
                    >
                      Reviewing your active campaigns…
                    </div>
                  ) : null}
                </article>
              );
            })}
          </section>
        )}

        {error ? (
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

      <Composer
        value={input}
        isStreaming={isStreaming}
        primedTierHint={primedTierHint}
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
    </div>
  );
}
