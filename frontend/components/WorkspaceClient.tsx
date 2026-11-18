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
import { ReallocationCard } from './ReallocationCard';
import { SandboxCard } from './SandboxCard';
import { ShareModal } from './ShareModal';
import { TelemetryStrip } from './TelemetryStrip';
import { WorkflowCard } from './WorkflowCard';
import {
  appendTwinMutations,
  fetchTwinState,
  readStoredMutations,
  resetTwinMutations,
} from '@/lib/twin-client';
import type {
  DerivedTwinState,
  HealthStatus,
  HygieneToolOutput,
  PlaybookDefinition,
  PlaybookId,
  ReallocationToolOutput,
  RelayUIMessage,
  ResolvedPlaybook,
  SandboxToolOutput,
  TelemetryData,
  WorkflowToolOutput,
} from '@/lib/types';

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
  const [twinError, setTwinError] = useState<string | null>(null);
  const [health, setHealth] = useState<HealthStatus | null>(null);
  const [healthLoading, setHealthLoading] = useState(false);

  const [input, setInput] = useState<string>(() => initialRemix?.prompt ?? '');
  const [highlightedPlaybookId, setHighlightedPlaybookId] =
    useState<PlaybookId | null>(() => initialRemix?.template ?? null);
  const [primedTierHint, setPrimedTierHint] = useState<'fast' | 'reasoning' | null>(
    () => initialRemix?.tierHint ?? null,
  );

  const [injectFailure, setInjectFailure] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [shareSlug, setShareSlug] = useState<string>(
    () => initialRemix?.slug ?? 'creative-404-guard',
  );
  const [shareModalOpen, setShareModalOpen] = useState(false);
  const [proposalDecisions, setProposalDecisions] = useState<
    Record<string, 'approved' | 'declined'>
  >({});

  const injectFailureRef = useRef(injectFailure);
  injectFailureRef.current = injectFailure;

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
    try {
      const response = await fetch('/api/agent/health', { cache: 'no-store' });
      if (response.ok) {
        const data = (await response.json()) as HealthStatus;
        setHealth(data);
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
  }, [loadTwin, loadHealth]);

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
    setTwinState(state);
    setTwinError(null);
  }, []);

  const handleApproveReallocation = useCallback(
    async (proposal: ReallocationToolOutput) => {
      const { mutations, state } = await appendTwinMutations([
        {
          type: 'reallocate_budget',
          from_campaign: proposal.fromCampaign,
          to_campaign: proposal.toCampaign,
          amount_per_day: proposal.amountPerDay,
        },
      ]);
      setTwinState(state);
      setTwinError(null);
      setProposalDecisions((prev) => ({
        ...prev,
        [proposal.proposalId]: 'approved',
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
    (proposal: ReallocationToolOutput) => {
      setProposalDecisions((prev) => ({
        ...prev,
        [proposal.proposalId]: 'declined',
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

  const renderMessagePart = (
    part: RelayUIMessage['parts'][number],
    index: number,
  ) => {
    switch (part.type) {
      case 'text': {
        if (!part.text.trim()) {
          return null;
        }
        return (
          <div key={`text-${index}`} className="assistant-prose">
            {part.text}
          </div>
        );
      }

      case 'data-telemetry':
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
            errorText={part.state === 'output-error' ? part.errorText : undefined}
            onRetry={handleRetry}
          />
        );
      }

      case 'tool-propose_budget_reallocation': {
        const cardState = mapToolStateToCardState(part.state);
        const output = part.state === 'output-available' ? part.output : undefined;
        const decision = output ? proposalDecisions[output.proposalId] ?? null : null;
        return (
          <ReallocationCard
            key={part.toolCallId}
            state={cardState}
            output={output}
            errorText={part.state === 'output-error' ? part.errorText : undefined}
            decision={decision}
            disabled={isStreaming}
            onApprove={handleApproveReallocation}
            onDecline={handleDeclineReallocation}
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
          const decision = out ? proposalDecisions[out.proposalId] ?? null : null;
          return (
            <ReallocationCard
              key={part.toolCallId}
              state={cardState}
              output={out}
              errorText={errText}
              decision={decision}
              disabled={isStreaming}
              onApprove={handleApproveReallocation}
              onDecline={handleDeclineReallocation}
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
        onOpenShare={() => setShareModalOpen(true)}
        onToggleInspector={() => setInspectorOpen((prev) => !prev)}
      />

      <main className="workspace-main">
        <ChannelHealthStrip
          twinState={twinState}
          errorText={twinError}
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

              const renderedParts = message.parts
                .map((part, idx) => renderMessagePart(part, idx))
                .filter((node) => node !== null);

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
                  <TelemetryStrip entries={turnTelemetry} />
                  {renderedParts.length > 0 ? (
                    <div className="assistant-parts-stack">{renderedParts}</div>
                  ) : isStreaming ? (
                    <div className="assistant-streaming-placeholder" aria-live="polite">
                      Streaming response from Python FastAPI + LangGraph service…
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
        onChange={handleComposerChange}
        onSubmit={handleComposerSubmit}
        onStop={() => void stop()}
      />

      <ShareModal
        isOpen={shareModalOpen}
        initialSlug={shareSlug}
        onClose={() => setShareModalOpen(false)}
      />

      <InspectorDrawer
        isOpen={inspectorOpen}
        injectFailure={injectFailure}
        telemetryEntries={allTelemetryEntries}
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
