import type { HealthStatus, TelemetryData } from './types';

export const REASONING_KEYWORD_RE =
  /realloc|budget|shift|strategy|plan|workflow|schedule|guardrail/i;

export interface GatewayRoutePreview {
  tier: 'fast' | 'reasoning';
  routedBy: 'card' | 'keyword';
  matchedKeyword: string | null;
  primaryModel: string;
  fallbackModels: string[];
}

export interface EnterpriseCounterfactual {
  actualUsd: number;
  enterpriseTwoTierUsd: number;
  naiveReasoningPlusCsvUsd: number;
  totalTokensProcessed: number;
  totalTokensAvoided: number;
  savingsPct: number;
}

const DEFAULT_PREVIEW_FAST = [
  'nvidia/nemotron-3.5-lightning-free',
  'reflection/beam-free',
  'stealth/glyph-cluster',
];

const DEFAULT_PREVIEW_REASONING = [
  'reflection/beam-free',
  'humansand/ampersand-v0.1',
  'recursive/flint-v1.0',
];

// Reference paid-tier rates (per token USD) matching backend/app/pricing.py
const REF_FAST_INPUT = 0.00000025;
const REF_FAST_OUTPUT = 0.0000015;
const REF_FAST_CACHE_READ = 0.00000003;

const REF_REASONING_INPUT = 0.000002;
const REF_REASONING_OUTPUT = 0.00001;
const REF_REASONING_CACHE_READ = 0.0000001;

export function previewGatewayRoute(
  input: string,
  tierHint: 'fast' | 'reasoning' | null,
  health: HealthStatus | null,
): GatewayRoutePreview {
  const fastChain =
    health?.fastModels && health.fastModels.length > 0
      ? health.fastModels
      : DEFAULT_PREVIEW_FAST;
  const reasoningChain =
    health?.reasoningModels && health.reasoningModels.length > 0
      ? health.reasoningModels
      : DEFAULT_PREVIEW_REASONING;

  if (tierHint === 'fast' || tierHint === 'reasoning') {
    const chain = tierHint === 'reasoning' ? reasoningChain : fastChain;
    return {
      tier: tierHint,
      routedBy: 'card',
      matchedKeyword: null,
      primaryModel: chain[0],
      fallbackModels: chain.slice(1),
    };
  }

  const match = input.match(REASONING_KEYWORD_RE);
  if (match) {
    return {
      tier: 'reasoning',
      routedBy: 'keyword',
      matchedKeyword: match[0].toLowerCase(),
      primaryModel: reasoningChain[0],
      fallbackModels: reasoningChain.slice(1),
    };
  }

  return {
    tier: 'fast',
    routedBy: 'keyword',
    matchedKeyword: null,
    primaryModel: fastChain[0],
    fallbackModels: fastChain.slice(1),
  };
}

export function computeEnterpriseCounterfactual(
  turns: TelemetryData[],
  totalTokensAvoided: number,
): EnterpriseCounterfactual {
  let actualUsd = 0;
  let enterpriseTwoTierUsd = 0;
  let naiveReasoningPlusCsvUsd = 0;
  let totalTokensProcessed = 0;

  for (const turn of turns) {
    const inputTokens = Math.max(0, turn.inputTokens || 0);
    const cachedTokens = Math.min(inputTokens, Math.max(0, turn.cachedTokens || 0));
    const uncachedInput = Math.max(0, inputTokens - cachedTokens);
    const outputTokens = Math.max(0, turn.outputTokens || 0);

    actualUsd += Math.max(0, turn.costUsd || 0);
    totalTokensProcessed += inputTokens + outputTokens;

    if (turn.tier === 'fast') {
      enterpriseTwoTierUsd +=
        uncachedInput * REF_FAST_INPUT +
        cachedTokens * REF_FAST_CACHE_READ +
        outputTokens * REF_FAST_OUTPUT;
    } else {
      enterpriseTwoTierUsd +=
        uncachedInput * REF_REASONING_INPUT +
        cachedTokens * REF_REASONING_CACHE_READ +
        outputTokens * REF_REASONING_OUTPUT;
    }

    naiveReasoningPlusCsvUsd +=
      uncachedInput * REF_REASONING_INPUT +
      cachedTokens * REF_REASONING_CACHE_READ +
      outputTokens * REF_REASONING_OUTPUT;
  }

  const safeAvoided = Math.max(0, Math.round(totalTokensAvoided || 0));
  naiveReasoningPlusCsvUsd += safeAvoided * REF_REASONING_INPUT;

  const savingsPct =
    naiveReasoningPlusCsvUsd > 0
      ? Math.max(
          0,
          Math.min(
            99.9,
            ((naiveReasoningPlusCsvUsd - enterpriseTwoTierUsd) /
              naiveReasoningPlusCsvUsd) *
              100,
          ),
        )
      : 0;

  return {
    actualUsd,
    enterpriseTwoTierUsd,
    naiveReasoningPlusCsvUsd,
    totalTokensProcessed,
    totalTokensAvoided: safeAvoided,
    savingsPct,
  };
}
