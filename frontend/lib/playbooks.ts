import type { ChannelId, PlaybookDefinition, PlaybookId, PlaybookStepInfo } from './types';

export const CANONICAL_CHANNELS: readonly ChannelId[] = [
  'google_ads',
  'linkedin_ads',
  'meta_ads',
] as const;

export const CHANNEL_LABELS: Record<ChannelId, string> = {
  google_ads: 'Google Ads',
  linkedin_ads: 'LinkedIn Ads',
  meta_ads: 'Meta Ads',
};

export const WORKFLOW_NODE_NAMES: readonly string[] = [
  'Fetch channels',
  'Check creative URL status',
  'Validate UTM schema',
  'Aggregate rows in Sandbox',
  'Threshold gate',
  'Digest',
] as const;

function buildPlaybookSteps(focusNote: string): PlaybookStepInfo[] {
  return [
    {
      node: 'Fetch channels',
      description: 'Load active campaign and ad group snapshots for the selected paid media channels.',
    },
    {
      node: 'Check creative URL status',
      description: 'Inspect destination status flags across active ad creatives without external HTTP calls.',
    },
    {
      node: 'Validate UTM schema',
      description: 'Verify utm_source, utm_medium, and utm_campaign parameters against canonical channel rules.',
    },
    {
      node: 'Aggregate rows in Sandbox',
      description: `Execute parameterized SQLite rollups inside an isolated microVM (${focusNote}).`,
    },
    {
      node: 'Threshold gate',
      description: 'Evaluate spend-at-risk and return ratios against the configured percentage guardrail.',
    },
    {
      node: 'Digest',
      description: 'Format an operator summary preview for Slack and Sheets review without sending external messages.',
    },
  ];
}

export const PLAYBOOKS: readonly PlaybookDefinition[] = [
  {
    id: 'creative-404-guard',
    eyebrow: 'FAST TIER',
    title: 'Creative and UTM hygiene audit',
    summary:
      'Scan active ad groups across search and paid social for broken destination URLs and non-canonical UTM tags, ranked by daily spend at risk.',
    prompt:
      'Audit all active campaigns for broken 404 destination URLs and UTM taxonomy violations, grouped by channel with daily spend at risk.',
    tierHint: 'fast',
    accent: 'blue',
    actionLabel: 'Run hygiene audit',
    defaultChannels: ['google_ads', 'linkedin_ads', 'meta_ads'],
    defaultThreshold: 10,
    steps: buildPlaybookSteps('channel spend at risk'),
  },
  {
    id: 'cross-channel-roas',
    eyebrow: 'SANDBOX + FAST TIER',
    title: 'Cross-channel return analysis',
    summary:
      'Run parameterized SQLite aggregations over daily performance rows inside an isolated microVM and return channel-level return on ad spend.',
    prompt:
      'Run an isolated sandbox SQL aggregation across all channels to compare total spend, clicks, conversions, pipeline value, and return on ad spend by channel.',
    tierHint: 'fast',
    accent: 'green',
    actionLabel: 'Run sandbox SQL',
    defaultChannels: ['google_ads', 'linkedin_ads', 'meta_ads'],
    defaultThreshold: 15,
    steps: buildPlaybookSteps('channel ROAS and pipeline efficiency'),
  },
  {
    id: 'paid-social-reallocation',
    eyebrow: 'REASONING TIER + APPROVAL',
    title: 'Reallocate wasted paid social spend',
    summary:
      'Compare campaign-level return on ad spend and propose a daily budget shift from the lowest-return social campaign to top-performing search for approval.',
    prompt:
      'Analyze campaign return on ad spend and propose a daily budget reallocation from the lowest-performing paid social campaign to the highest-performing exact-match search campaign.',
    tierHint: 'reasoning',
    accent: 'amber',
    actionLabel: 'Draft budget proposal',
    defaultChannels: ['google_ads', 'linkedin_ads', 'meta_ads'],
    defaultThreshold: 20,
    steps: buildPlaybookSteps('campaign marginal return ranking'),
  },
  {
    id: 'daily-pacing-guardrail',
    eyebrow: 'REASONING TIER + WORKFLOW',
    title: 'Compile a daily pacing guardrail',
    summary:
      'Generate a six-step scheduled check for creative status, UTM schema drift, and return thresholds with an in-app dry run and shareable link.',
    prompt:
      'Compile a daily pacing and creative hygiene guardrail workflow across Google Ads, LinkedIn Ads, and Meta Ads with a spend-at-risk threshold gate and scheduled digest.',
    tierHint: 'reasoning',
    accent: 'blue',
    actionLabel: 'Compile guardrail',
    defaultChannels: ['google_ads', 'linkedin_ads', 'meta_ads'],
    defaultThreshold: 15,
    steps: buildPlaybookSteps('daily pacing and spend-at-risk rollup'),
  },
] as const;

export const PLAYBOOKS_BY_ID: Record<PlaybookId, PlaybookDefinition> = {
  'creative-404-guard': PLAYBOOKS[0],
  'cross-channel-roas': PLAYBOOKS[1],
  'paid-social-reallocation': PLAYBOOKS[2],
  'daily-pacing-guardrail': PLAYBOOKS[3],
};
