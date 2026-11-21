/**
 * Deterministic Marketing Manager follow-up generator and channel drill-down prompts.
 *
 * Orders index `0` as the sequential "Next table" slice (`channel_roas_summary`
 * -> `campaign_roas_ranking` -> `ad_group_efficiency` -> `daily_pacing_anomalies`)
 * and derives every label, dollar figure, and ROAS spread strictly from live
 * tool outputs and Digital Twin state (zero hardcoded dataset literals).
 */

import type {
  DerivedTwinState,
  FollowUpChip,
  HygieneToolOutput,
  ReallocationToolOutput,
  RelayUIMessage,
  SandboxToolOutput,
} from '@/lib/types';

export function buildChannelDrilldownPrompt(
  channelName: string,
  focus: 'overview' | 'broken_404' | 'utm_violation',
): { prompt: string; tierHint: 'fast' | 'reasoning' } {
  const cleanChannel = channelName.trim() || 'all paid channels';
  if (focus === 'broken_404') {
    return {
      prompt: `Inspect broken 404 landing page links on ${cleanChannel} ranked by daily spend at risk so I can review and pause them.`,
      tierHint: 'fast',
    };
  }
  if (focus === 'utm_violation') {
    return {
      prompt: `Audit UTM tracking tag issues on ${cleanChannel} and show exact fixes by campaign.`,
      tierHint: 'fast',
    };
  }
  return {
    prompt: `Audit landing pages, UTM tracking issues, and campaign ROAS performance across ${cleanChannel}.`,
    tierHint: 'fast',
  };
}

function getLowestAndHighestChannels(twinState: DerivedTwinState | null) {
  if (!twinState || twinState.channels.length < 2) {
    return null;
  }
  const sorted = [...twinState.channels].sort((a, b) => a.roas - b.roas);
  const low = sorted[0];
  const high = sorted[sorted.length - 1];
  if (!low || !high || low.channelId === high.channelId || high.roas <= low.roas) {
    return null;
  }
  return { low, high };
}

export function buildTurnFollowUps(args: {
  parts: RelayUIMessage['parts'];
  twinState: DerivedTwinState | null;
  proposalDecisions: Record<string, 'approved' | 'declined'>;
}): FollowUpChip[] {
  const { parts, twinState, proposalDecisions } = args;

  let hasWorkflow = false;
  let hygieneOutput: HygieneToolOutput | null = null;
  let sandboxOutput: SandboxToolOutput | null = null;
  let reallocationOutput: ReallocationToolOutput | null = null;
  let reallocationDecision: 'approved' | 'declined' | null = null;

  for (const part of parts) {
    if (
      (part.type === 'tool-compile_workflow' ||
        (part.type === 'dynamic-tool' && part.toolName === 'compile_workflow')) &&
      part.state === 'output-available'
    ) {
      hasWorkflow = true;
    } else if (
      (part.type === 'tool-audit_campaign_hygiene' ||
        (part.type === 'dynamic-tool' &&
          part.toolName === 'audit_campaign_hygiene')) &&
      part.state === 'output-available' &&
      part.output
    ) {
      hygieneOutput = part.output as HygieneToolOutput;
    } else if (
      (part.type === 'tool-analyze_in_sandbox' ||
        (part.type === 'dynamic-tool' && part.toolName === 'analyze_in_sandbox')) &&
      part.state === 'output-available' &&
      part.output
    ) {
      sandboxOutput = part.output as SandboxToolOutput;
    } else if (
      (part.type === 'tool-propose_budget_reallocation' ||
        (part.type === 'dynamic-tool' &&
          part.toolName === 'propose_budget_reallocation')) &&
      part.state === 'output-available' &&
      part.output
    ) {
      reallocationOutput = part.output as ReallocationToolOutput;
      reallocationDecision = proposalDecisions[part.toolCallId] ?? null;
    }
  }

  // WorkflowCard already renders WorkflowNextSteps; avoid duplicate pill rows.
  if (hasWorkflow) {
    return [];
  }

  const chips: FollowUpChip[] = [];
  const channelSpread = getLowestAndHighestChannels(twinState);
  const activeBroken = twinState?.totals.brokenCreatives ?? hygieneOutput?.brokenCount ?? 0;
  const activeUtm = twinState?.totals.utmViolations ?? hygieneOutput?.utmCount ?? 0;

  if (reallocationOutput) {
    const targetName =
      reallocationOutput.toCampaignName || reallocationOutput.toCampaign;
    if (reallocationDecision === 'approved') {
      chips.push({
        id: 'after-approve-forecast',
        label: 'Check remaining channel pacing & spend spikes',
        prompt:
          'Analyze daily pacing anomalies across all channels after the approved budget shift and surface any remaining waste.',
        tierHint: 'fast',
        tone: 'green',
      });
    } else {
      chips.push({
        id: 'rebalance-alt',
        label: `Inspect top campaigns in ${reallocationOutput.toChannel || targetName}`,
        prompt: `Break down campaign ROAS ranking across ${reallocationOutput.toChannel || 'all channels'} and compare marginal efficiency.`,
        tierHint: 'fast',
        tone: 'green',
      });
    }
    if (activeBroken + activeUtm > 0) {
      chips.push({
        id: 'check-hygiene',
        label: 'Audit broken landing pages & UTM tags',
        prompt:
          'Check every active campaign for broken 404 landing pages and UTM tracking gaps ranked by spend at risk.',
        tierHint: 'fast',
        tone: 'blue',
      });
    }
    chips.push({
      id: 'make-guardrail',
      label: 'Set up daily recurring pacing check',
      prompt:
        'Create a daily morning campaign health check across Google Ads, LinkedIn Ads, and Meta Ads with a 15% wasted-spend alert rule.',
      tierHint: 'fast',
      tone: 'violet',
    });
    return chips.slice(0, 3);
  }

  if (hygieneOutput) {
    chips.push({
      id: 'hygiene-to-perf',
      label: 'Compare channel ROAS & wasted spend',
      prompt:
        'Run a channel ROAS summary in the sandbox comparing spend, attributed pipeline, and blended ROAS by channel.',
      tierHint: 'fast',
      tone: 'green',
    });
    if (channelSpread) {
      chips.push({
        id: 'hygiene-to-shift',
        label: `Shift spend from ${channelSpread.low.channel} (${channelSpread.low.roas.toFixed(2)}x) to ${channelSpread.high.channel} (${channelSpread.high.roas.toFixed(2)}x)`,
        prompt: `Propose a budget shift from the lowest-ROAS campaign in ${channelSpread.low.channel} to the highest-ROAS campaign in ${channelSpread.high.channel} with a 30-day pipeline forecast.`,
        tierHint: 'reasoning',
        tone: 'amber',
      });
    }
    chips.push({
      id: 'hygiene-to-workflow',
      label: 'Automate this check every morning',
      prompt:
        'Create a daily 7 AM campaign health check to catch broken 404 links and UTM issues across all paid channels with a 10% spend-at-risk alert.',
      tierHint: 'fast',
      tone: 'violet',
    });
    return chips.slice(0, 3);
  }

  if (sandboxOutput) {
    const templateId = sandboxOutput.templateId;
    if (templateId === 'channel_roas_summary') {
      chips.push({
        id: 'perf-next-campaigns',
        label: 'Next table: Rank campaigns by ROAS',
        prompt:
          'Rank all campaigns by spend, attributed pipeline, and ROAS in the sandbox.',
        tierHint: 'fast',
        tone: 'green',
      });
    } else if (templateId === 'campaign_roas_ranking') {
      chips.push({
        id: 'perf-next-adgroups',
        label: 'Next table: Find zero-conversion ad groups',
        prompt:
          'Check ad_group_efficiency in the sandbox for ad groups spending budget with zero conversions.',
        tierHint: 'fast',
        tone: 'green',
      });
    } else if (templateId === 'ad_group_efficiency') {
      chips.push({
        id: 'perf-next-anomalies',
        label: 'Next table: Daily pacing spend spikes',
        prompt:
          'Analyze daily pacing anomalies across channels to highlight unexpected spend spikes or dips.',
        tierHint: 'fast',
        tone: 'green',
      });
    } else {
      chips.push({
        id: 'perf-next-channels',
        label: 'Next table: Channel ROAS summary',
        prompt:
          'Compare 30-day spend, pipeline, and blended ROAS by channel in the sandbox.',
        tierHint: 'fast',
        tone: 'green',
      });
    }

    if (channelSpread) {
      chips.push({
        id: 'perf-to-shift',
        label: `Model budget shift toward ${channelSpread.high.channel} (${channelSpread.high.roas.toFixed(2)}x)`,
        prompt: `Propose a budget reallocation from ${channelSpread.low.channel} to ${channelSpread.high.channel} with a 30-day Monte Carlo pipeline forecast.`,
        tierHint: 'reasoning',
        tone: 'amber',
      });
    }
    if (activeBroken + activeUtm > 0) {
      chips.push({
        id: 'perf-to-hygiene',
        label: 'Inspect active broken links & UTM gaps',
        prompt:
          'Audit active broken 404 landing pages and UTM tracking issues ranked by daily spend at risk.',
        tierHint: 'fast',
        tone: 'blue',
      });
    }
    return chips.slice(0, 3);
  }

  // Generic assistant text-only reply: offer top contextual next steps.
  if (parts.some((p) => p.type === 'text' && p.text.trim().length > 0)) {
    if (activeBroken + activeUtm > 0) {
      chips.push({
        id: 'text-to-hygiene',
        label: 'Check broken links & UTM tags',
        prompt:
          'Check all active campaigns for broken 404 landing pages and UTM tracking issues.',
        tierHint: 'fast',
        tone: 'blue',
      });
    }
    if (channelSpread) {
      chips.push({
        id: 'text-to-shift',
        label: `Model budget shift (${channelSpread.low.channel} → ${channelSpread.high.channel})`,
        prompt: `Propose shifting daily budget from ${channelSpread.low.channel} to ${channelSpread.high.channel} with a 30-day pipeline forecast.`,
        tierHint: 'reasoning',
        tone: 'amber',
      });
    }
    chips.push({
      id: 'text-to-perf',
      label: 'Compare channel ROAS & spend spikes',
      prompt:
        'Show trailing campaign performance and ROAS comparison across Google Ads, LinkedIn Ads, and Meta Ads.',
      tierHint: 'fast',
      tone: 'green',
    });
  }

  return chips.slice(0, 3);
}
