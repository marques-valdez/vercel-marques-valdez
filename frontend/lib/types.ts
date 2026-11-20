/**
 * Shared TypeScript contracts bridging Python FastAPI payloads and AI SDK 7 UI.
 *
 * `RelayUIMessage` parameterizes `ai`'s `UIMessage<Metadata, DataParts, Tools>`
 * so `useChat()` produces strictly typed tool outputs (`HygieneToolOutput`,
 * `SandboxToolOutput`, `ReallocationToolOutput`, `WorkflowToolOutput`) and
 * custom SSE data parts (`data-telemetry`, `data-sandbox-status`).
 */
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
  databaseConnected?: boolean;
  databaseProvider?: 'neon-postgres' | 'browser-local';
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

export type AgentProgressStepStatus = 'pending' | 'in_progress' | 'done' | 'failed';

export interface AgentProgressStep {
  id: string;
  title: string;
  status: AgentProgressStepStatus;
}

export interface AgentStatusData {
  phase: 'connecting' | 'planning' | 'tool' | 'synthesizing' | 'truncated';
  label: string;
  focus?: string;
  steps?: AgentProgressStep[];
}

export interface BackendAlert {
  id: string;
  severity: 'error' | 'warning';
  title: string;
  message: string;
  technicalDetail?: string;
  retryable?: boolean;
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
  mode: 'neon-postgres' | 'sandbox' | 'in-process';
  sandboxMs: number;
  rowsScanned: number;
  rowsReturned: number;
  sql: string;
  table: Array<Record<string, string | number | boolean | null>>;
  estTokensAvoided: number;
}

export interface MonteCarloSimulation {
  mode: 'sandbox' | 'in-process';
  trials: number;
  horizonDays: number;
  sandboxMs: number;
  incrementalPipelineP10: number;
  incrementalPipelineP50: number;
  incrementalPipelineP90: number;
  blendedRoasP10: number;
  blendedRoasP50: number;
  blendedRoasP90: number;
  probabilityOfPositiveLiftPct: number;
  targetSaturationDragPct: number;
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
  simulation?: MonteCarloSimulation;
}

export interface WorkflowStepSpec {
  index?: number;
  node: string;
  description?: string;
  dependsOn?: string[];
}

export interface SavedWorkflowRecord {
  workflow: WorkflowToolOutput;
  customName?: string;
  savedAt: string;
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

export interface WorkflowChannelRoasRef {
  channel: string;
  channelId: ChannelId;
  roas: number;
}

export interface WorkflowDigestSummary {
  previewText?: string;
  delivery?: string;
  brokenCreatives: number;
  utmViolations: number;
  spendAtRiskPerDay: number;
  spendAtRiskPct?: number;
  thresholdPct?: number;
  gateTriggered?: boolean;
  blendedRoas?: number;
  lowestRoasChannel?: WorkflowChannelRoasRef | null;
  highestRoasChannel?: WorkflowChannelRoasRef | null;
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
  routedBy: 'card' | 'decision' | 'semantic' | 'keyword';
  routingConfidence?: number;
  routerModel?: string;
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
  'agent-status': AgentStatusData;
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
  accent: 'blue' | 'green' | 'amber' | 'violet';
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

export interface ChannelTrendPoint {
  date: string;
  spend: number;
  pipelineValue: number;
  roas: number;
}

export interface ChannelTrendSeries {
  channelId: ChannelId;
  channel: string;
  firstWindowRoas: number;
  lastWindowRoas: number;
  deltaPct: number;
  points: ChannelTrendPoint[];
}

export interface ChannelTrendsResponse {
  days: number;
  mode: 'neon-postgres' | 'in-process';
  channels: Partial<Record<ChannelId, ChannelTrendSeries>>;
}

export interface FollowUpChip {
  id: string;
  label: string;
  prompt: string;
  tierHint: 'fast' | 'reasoning';
  tone: 'blue' | 'green' | 'amber' | 'violet';
}

export interface ImpactToastData {
  id: string;
  title: string;
  detail: string;
  tone: 'green' | 'blue' | 'amber';
  undoSnapshot?: Mutation[];
}

export type DemoStepId = 'sandbox' | 'xray' | 'failover' | 'og';
