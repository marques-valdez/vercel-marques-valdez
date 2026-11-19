import type { UIMessage } from 'ai';

export type ChannelId = 'google_ads' | 'linkedin_ads' | 'meta_ads';
export type IssueType = 'broken_404' | 'utm_violation';
export type IssueStatus = 'active' | 'paused' | 'fixed';

export interface PauseBrokenCreativesMutation {
  type: 'pause_broken_creatives';
}

export interface FixUtmTaxonomyMutation {
  type: 'fix_utm_taxonomy';
}

export interface ReallocateBudgetMutation {
  type: 'reallocate_budget';
  from_campaign: string;
  to_campaign: string;
  amount_per_day: number;
}

export type Mutation =
  | PauseBrokenCreativesMutation
  | FixUtmTaxonomyMutation
  | ReallocateBudgetMutation;

export interface TwinTotals {
  campaignCount: number;
  adGroupCount: number;
  rowCount: number;
  dailyBudget: number;
  monthlyBudget: number;
  brokenCreatives: number;
  utmViolations: number;
  spendAtRiskPerDay: number;
  blendedRoas: number;
  appliedMutations: number;
}

export interface ChannelSummary {
  channel: string;
  channelId: ChannelId;
  campaignCount: number;
  adGroupCount: number;
  dailyBudget: number;
  brokenCreatives: number;
  utmViolations: number;
  spendAtRiskPerDay: number;
  totalSpend: number;
  totalPipelineValue: number;
  roas: number;
}

export interface CampaignSummary {
  campaignId: string;
  name: string;
  channel: string;
  channelId: ChannelId;
  matchType: string;
  adGroupCount: number;
  dailyBudget: number;
  totalSpend: number;
  totalClicks: number;
  totalConversions: number;
  totalPipelineValue: number;
  roas: number;
  brokenCreatives: number;
  utmViolations: number;
}

export interface HygieneIssue {
  issueId: string;
  issueType: IssueType;
  status: IssueStatus;
  channel: string;
  channelId: ChannelId;
  campaignId: string;
  campaignName: string;
  adGroupId: string;
  value: string;
  recommendedFix: string;
  dailySpendAtRisk: number;
}

export interface DerivedTwinState {
  totals: TwinTotals;
  channels: ChannelSummary[];
  campaigns: CampaignSummary[];
  hygieneIssues: HygieneIssue[];
}

export interface HealthStatus {
  status: string;
  pythonVersion: string;
  vercelEnv: string;
  deploymentId: string;
  commitSha: string;
  pricingSource: string;
  sandboxAvailable: boolean;
  fastModels?: string[];
  reasoningModels?: string[];
  baselineModel?: string;
  serviceTopology?: {
    frontend: string;
    rewrite: string;
    backend: string;
  };
}

export interface SandboxStatusData {
  toolCallId: string;
  stage: 'provisioning' | 'executing_sql' | 'completed';
  label: string;
}

export interface WireFrameRecord {
  id: string;
  offsetMs: number;
  type: string;
  raw: string;
  payload: Record<string, unknown> | null;
}

export interface ChannelDelta {
  dailyBudgetDelta: number;
  brokenCreativesDelta: number;
  utmViolationsDelta: number;
}

export interface HygieneToolOutput {
  brokenCount: number;
  utmCount: number;
  totalSpendAtRiskPerDay: number;
  channels?: ChannelSummary[];
  flaggedItems?: HygieneIssue[];
  items?: HygieneIssue[];
}

export interface SandboxToolOutput {
  templateId?: string;
  mode: 'sandbox' | 'in-process';
  sandboxMs: number;
  rowsScanned: number;
  rowsReturned: number;
  sql: string;
  table: Array<Record<string, string | number | boolean | null>>;
  estTokensAvoided: number;
}

export interface ReallocationWindowMetrics {
  fromDailyBudget: number;
  toDailyBudget: number;
  fromRoas: number;
  toRoas: number;
  totalDailyBudget: number;
}

export interface ReallocationToolOutput {
  proposalId: string;
  fromCampaign: string;
  fromCampaignName?: string;
  fromChannel?: string;
  toCampaign: string;
  toCampaignName?: string;
  toChannel?: string;
  amountPerDay: number;
  before: ReallocationWindowMetrics;
  after: ReallocationWindowMetrics;
  blendedRoasBefore: number;
  blendedRoasAfter: number;
  formula?: string;
}

export interface WorkflowStepSpec {
  index?: number;
  node: string;
  description?: string;
}

export interface WorkflowToolOutput {
  workflowId: string;
  title: string;
  template: string;
  slug: string;
  channels: ChannelId[];
  threshold: number;
  schedule?: string;
  steps: WorkflowStepSpec[];
  temporalCode: string;
}

export interface WorkflowRunStepEvent {
  stepIndex?: number;
  node: string;
  status: 'completed' | 'failed';
  ms: number;
  mode?: 'sandbox' | 'in-process' | 'twin' | string;
  detail: string | Record<string, unknown>;
  summary?: Record<string, unknown>;
}

export interface TelemetryData {
  tier: 'fast' | 'reasoning';
  routedBy: 'card' | 'keyword';
  primaryModel: string;
  servedModel: string;
  failover: 'none' | 'gateway' | 'simulated';
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
  costUsd: number;
  baselineCostUsd: number;
  latencyMs: number;
}

export type RelayDataParts = {
  telemetry: TelemetryData;
  'sandbox-status': SandboxStatusData;
};

export type RelayUITools = {
  audit_campaign_hygiene: {
    input: Record<string, unknown>;
    output: HygieneToolOutput;
  };
  analyze_in_sandbox: {
    input: Record<string, unknown>;
    output: SandboxToolOutput;
  };
  propose_budget_reallocation: {
    input: Record<string, unknown>;
    output: ReallocationToolOutput;
  };
  compile_workflow: {
    input: Record<string, unknown>;
    output: WorkflowToolOutput;
  };
};

export type RelayUIMessage = UIMessage<unknown, RelayDataParts, RelayUITools>;

export type PlaybookId =
  | 'creative-404-guard'
  | 'cross-channel-roas'
  | 'paid-social-reallocation'
  | 'daily-pacing-guardrail';

export interface PlaybookStepInfo {
  node: string;
  description: string;
}

export interface PlaybookDefinition {
  id: PlaybookId;
  eyebrow: string;
  title: string;
  summary: string;
  prompt: string;
  tierHint: 'fast' | 'reasoning';
  accent: 'blue' | 'green' | 'amber';
  actionLabel: string;
  defaultChannels: ChannelId[];
  defaultThreshold: number;
  steps: PlaybookStepInfo[];
}

export interface ResolvedPlaybook {
  slug: string;
  template: PlaybookId;
  eyebrow: string;
  title: string;
  summary: string;
  prompt: string;
  tierHint: 'fast' | 'reasoning';
  channels: ChannelId[];
  threshold: number;
  steps: PlaybookStepInfo[];
}
