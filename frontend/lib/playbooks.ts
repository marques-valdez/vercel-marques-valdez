/**
 * Canonical starter playbooks and 6-step workflow taxonomy for Relay Studio.
 *
 * Eliminates blank-screen cold-start drop-off by giving marketers four
 * concrete entry points paired with explicit `tierHint` values (`fast` vs.
 * `reasoning`) so card clicks route deterministically through AI Gateway.
 */
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
  'Pull active campaigns & budgets',
  'Check landing pages for broken links',
  'Verify UTM tracking tags',
  'Calculate channel spend & ROAS',
  'Check wasted-spend alert rule',
  'Send morning Slack & Sheets brief',
] as const;

function buildPlaybookSteps(focusNote: string): PlaybookStepInfo[] {
  return [
    {
      node: 'Pull active campaigns & budgets',
      description: 'Pull active campaigns, ad groups, and daily budget caps across your selected paid channels.',
    },
    {
      node: 'Check landing pages for broken links',
      description: 'Scan ad destination URLs to flag broken 404 landing pages wasting paid clicks.',
    },
    {
      node: 'Verify UTM tracking tags',
      description: 'Check utm_source, utm_medium, and utm_campaign tags so leads attribute cleanly in CRM.',
    },
    {
      node: 'Calculate channel spend & ROAS',
      description: `Roll up trailing spend, pipeline, and return on ad spend (${focusNote}).`,
    },
    {
      node: 'Check wasted-spend alert rule',
      description: 'Flag an alert if daily spend on broken links or untagged ads crosses your threshold.',
    },
    {
      node: 'Send morning Slack & Sheets brief',
      description: 'Prepare a morning summary of broken ads to pause, UTMs to fix, and channel ROAS.',
    },
  ];
}

export const PLAYBOOKS: readonly PlaybookDefinition[] = [
  {
    id: 'creative-404-guard',
    eyebrow: 'AD & TRACKING QA',
    title: 'Audit broken ad links & UTM tags',
    summary:
      'Find active ads across Google, LinkedIn, and Meta sending paid clicks to 404 pages or missing UTM tracking tags, ranked by wasted daily spend.',
    prompt:
      'Audit all active campaigns for broken 404 landing pages and UTM tracking issues, grouped by channel with daily spend at risk.',
    tierHint: 'fast',
    accent: 'blue',
    actionLabel: 'Audit live ads',
    defaultChannels: ['google_ads', 'linkedin_ads', 'meta_ads'],
    defaultThreshold: 10,
    steps: buildPlaybookSteps('daily spend at risk by channel'),
  },
  {
    id: 'cross-channel-roas',
    eyebrow: 'PERFORMANCE & ROAS',
    title: 'Compare channel spend, pipeline & ROAS',
    summary:
      'Break down total spend, clicks, conversions, attributed pipeline, and return on ad spend across Google Ads, LinkedIn Ads, and Meta Ads.',
    prompt:
      'Compare total spend, clicks, conversions, pipeline value, and return on ad spend across Google Ads, LinkedIn Ads, and Meta Ads.',
    tierHint: 'fast',
    accent: 'green',
    actionLabel: 'Compare channel ROAS',
    defaultChannels: ['google_ads', 'linkedin_ads', 'meta_ads'],
    defaultThreshold: 15,
    steps: buildPlaybookSteps('channel ROAS and pipeline efficiency'),
  },
  {
    id: 'paid-social-reallocation',
    eyebrow: 'BUDGET OPTIMIZATION',
    title: 'Shift wasted social spend to top search',
    summary:
      'Compare campaign-level return on ad spend and draft a daily budget shift from your lowest-return social campaign to top-performing search for approval.',
    prompt:
      'Analyze campaign return on ad spend and propose a daily budget reallocation from the lowest-performing paid social campaign to the highest-performing search campaign.',
    tierHint: 'reasoning',
    accent: 'amber',
    actionLabel: 'Draft budget shift',
    defaultChannels: ['google_ads', 'linkedin_ads', 'meta_ads'],
    defaultThreshold: 20,
    steps: buildPlaybookSteps('campaign return ranking'),
  },
  {
    id: 'daily-pacing-guardrail',
    eyebrow: 'RECURRING CHECK',
    title: 'Daily pacing & broken-link check',
    summary:
      'Schedule a recurring morning check across Google, LinkedIn, and Meta that flags broken landing pages, UTM gaps, and wasted daily spend.',
    prompt:
      'Set up a daily morning pacing and broken-link check across Google Ads, LinkedIn Ads, and Meta Ads with a 15% wasted-spend alert rule and morning brief.',
    tierHint: 'reasoning',
    accent: 'violet',
    actionLabel: 'Set up morning check',
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
