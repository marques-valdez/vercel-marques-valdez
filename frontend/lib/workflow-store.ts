import { CANONICAL_CHANNELS, PLAYBOOKS, WORKFLOW_NODE_NAMES } from './playbooks';
import { encodePlaybookSlug, PlaybookTemplateSchema, resolvePlaybookSlug } from './share';
import type {
  ChannelId,
  SavedWorkflowRecord,
  WorkflowStepSpec,
  WorkflowToolOutput,
} from './types';

export const WORKFLOW_STORAGE_KEY = 'relay.workflows.v1';
export const MAX_STORED_WORKFLOWS = 25;

const LEGACY_NODE_NAME_ALIASES: Readonly<Record<string, string>> = {
  'Fetch channels': 'Pull active campaigns & budgets',
  'Check creative URL status': 'Check landing pages for broken links',
  'Validate UTM schema': 'Verify UTM tracking tags',
  'Aggregate rows in Sandbox': 'Calculate channel spend & ROAS',
  'Threshold gate': 'Check wasted-spend alert rule',
  Digest: 'Send morning Slack & Sheets brief',
};

const LEGACY_TITLE_UPGRADES: Readonly<Record<string, string>> = {
  'Compile a daily pacing guardrail': 'Daily pacing & broken-link check',
  'Creative and UTM hygiene audit': 'Audit broken ad links & UTM tags',
  'Cross-channel return analysis': 'Compare channel spend, pipeline & ROAS',
  'Reallocate wasted paid social spend': 'Shift wasted social spend to top search',
};

export const CANONICAL_WORKFLOW_DEPENDENCIES: Readonly<Record<string, readonly string[]>> = {
  'Pull active campaigns & budgets': [],
  'Check landing pages for broken links': ['Pull active campaigns & budgets'],
  'Verify UTM tracking tags': ['Pull active campaigns & budgets'],
  'Calculate channel spend & ROAS': ['Pull active campaigns & budgets'],
  'Check wasted-spend alert rule': [
    'Check landing pages for broken links',
    'Verify UTM tracking tags',
    'Calculate channel spend & ROAS',
  ],
  'Send morning Slack & Sheets brief': ['Check wasted-spend alert rule'],
};

const CANONICAL_STAGE_BY_NODE: Readonly<Record<string, 0 | 1 | 2 | 3>> = {
  'Pull active campaigns & budgets': 0,
  'Check landing pages for broken links': 1,
  'Verify UTM tracking tags': 1,
  'Calculate channel spend & ROAS': 1,
  'Check wasted-spend alert rule': 2,
  'Send morning Slack & Sheets brief': 3,
};

const DEFAULT_STEP_DESCRIPTIONS: Readonly<Record<string, string>> = Object.fromEntries(
  PLAYBOOKS[3].steps.map((s) => [s.node, s.description]),
);

export interface ResolvedDagStep {
  index: number;
  node: string;
  description: string;
  dependsOn: string[];
  stage: 0 | 1 | 2 | 3;
}

export function normalizeWorkflowNodeName(rawNode: string): string {
  return LEGACY_NODE_NAME_ALIASES[rawNode] ?? rawNode;
}

export function formatScheduleForMarketer(schedule?: string): string {
  if (!schedule || !schedule.trim()) {
    return 'Daily at 7:00 AM UTC';
  }
  const parts = schedule.trim().split(/\s+/);
  if (parts.length === 5) {
    const [minStr, hourStr, dom, month, dow] = parts;
    const min = Number.parseInt(minStr, 10);
    const hour = Number.parseInt(hourStr, 10);
    if (
      Number.isInteger(min) &&
      min >= 0 &&
      min <= 59 &&
      Number.isInteger(hour) &&
      hour >= 0 &&
      hour <= 23 &&
      dom === '*' &&
      month === '*'
    ) {
      const period = hour >= 12 ? 'PM' : 'AM';
      const displayHour = hour % 12 === 0 ? 12 : hour % 12;
      const displayMin = String(min).padStart(2, '0');
      const timeText = `${displayHour}:${displayMin} ${period} UTC`;
      if (dow === '*') {
        return `Daily at ${timeText}`;
      }
      if (dow === '1-5') {
        return `Weekdays at ${timeText}`;
      }
      if (dow === '1') {
        return `Mondays at ${timeText}`;
      }
    }
  }
  return `Scheduled (${schedule.trim()})`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isValidStepSpec(value: unknown): value is WorkflowStepSpec {
  if (!isPlainObject(value)) {
    return false;
  }
  if (typeof value.node !== 'string' || value.node.trim().length === 0) {
    return false;
  }
  if (
    value.description !== undefined &&
    typeof value.description !== 'string'
  ) {
    return false;
  }
  if (
    value.dependsOn !== undefined &&
    (!Array.isArray(value.dependsOn) ||
      !value.dependsOn.every((dep) => typeof dep === 'string'))
  ) {
    return false;
  }
  return true;
}

export function isValidWorkflowOutput(value: unknown): value is WorkflowToolOutput {
  if (!isPlainObject(value)) {
    return false;
  }
  if (typeof value.workflowId !== 'string' || value.workflowId.trim().length === 0) {
    return false;
  }
  if (typeof value.title !== 'string' || value.title.trim().length === 0) {
    return false;
  }
  if (typeof value.template !== 'string' || value.template.trim().length === 0) {
    return false;
  }
  if (typeof value.slug !== 'string') {
    return false;
  }
  if (
    !Array.isArray(value.channels) ||
    !value.channels.every(
      (ch) => typeof ch === 'string' && (CANONICAL_CHANNELS as readonly string[]).includes(ch),
    )
  ) {
    return false;
  }
  if (
    typeof value.threshold !== 'number' ||
    !Number.isFinite(value.threshold) ||
    value.threshold < 1 ||
    value.threshold > 100
  ) {
    return false;
  }
  if (value.schedule !== undefined && typeof value.schedule !== 'string') {
    return false;
  }
  if (!Array.isArray(value.steps) || !value.steps.every(isValidStepSpec)) {
    return false;
  }
  if (typeof value.temporalCode !== 'string') {
    return false;
  }
  return true;
}

export function isValidSavedWorkflow(item: unknown): item is SavedWorkflowRecord {
  if (!isPlainObject(item)) {
    return false;
  }
  if (!isValidWorkflowOutput(item.workflow)) {
    return false;
  }
  if (typeof item.savedAt !== 'string' || item.savedAt.trim().length === 0) {
    return false;
  }
  if (
    item.customName !== undefined &&
    (typeof item.customName !== 'string' || item.customName.length > 80)
  ) {
    return false;
  }
  return true;
}

export function resolveValidWorkflowShareSlug(output: WorkflowToolOutput): string {
  if (output.slug && resolvePlaybookSlug(output.slug)) {
    return output.slug;
  }
  const parsedTemplate = PlaybookTemplateSchema.safeParse(output.template);
  const template = parsedTemplate.success
    ? parsedTemplate.data
    : 'daily-pacing-guardrail';
  const validChannels: ChannelId[] = Array.isArray(output.channels)
    ? CANONICAL_CHANNELS.filter((c) => output.channels.includes(c))
    : [];
  const rawThreshold = Number(output.threshold);
  const clampedThreshold = Number.isFinite(rawThreshold)
    ? Math.min(100, Math.max(1, Math.round(rawThreshold)))
    : 15;

  return encodePlaybookSlug({
    template,
    channels:
      validChannels.length > 0
        ? validChannels
        : ['google_ads', 'linkedin_ads', 'meta_ads'],
    threshold: clampedThreshold,
  });
}

export function resolveWorkflowDagSteps(output: WorkflowToolOutput): ResolvedDagStep[] {
  return WORKFLOW_NODE_NAMES.map((canonicalNode, idx) => {
    const matched =
      output.steps?.find(
        (s) => normalizeWorkflowNodeName(s.node) === canonicalNode,
      ) ?? output.steps?.[idx];
    const isLegacyNode = Boolean(
      matched?.node && LEGACY_NODE_NAME_ALIASES[matched.node],
    );
    const explicitDeps =
      matched?.dependsOn && Array.isArray(matched.dependsOn)
        ? matched.dependsOn
            .map(normalizeWorkflowNodeName)
            .filter((dep) =>
              (WORKFLOW_NODE_NAMES as readonly string[]).includes(dep),
            )
        : null;
    const fallbackDeps = CANONICAL_WORKFLOW_DEPENDENCIES[canonicalNode] ?? [];
    const description = isLegacyNode
      ? DEFAULT_STEP_DESCRIPTIONS[canonicalNode] || matched?.description || ''
      : matched?.description || DEFAULT_STEP_DESCRIPTIONS[canonicalNode] || '';

    return {
      index: idx,
      node: canonicalNode,
      description,
      dependsOn:
        explicitDeps !== null ? [...explicitDeps] : [...fallbackDeps],
      stage: CANONICAL_STAGE_BY_NODE[canonicalNode] ?? 0,
    };
  });
}

export function getWorkflowDisplayName(record: SavedWorkflowRecord): string {
  const trimmedCustom = record.customName?.trim();
  if (trimmedCustom) {
    return trimmedCustom;
  }
  return LEGACY_TITLE_UPGRADES[record.workflow.title] ?? record.workflow.title;
}

export function readStoredWorkflows(): SavedWorkflowRecord[] {
  if (typeof window === 'undefined') {
    return [];
  }
  try {
    const raw = window.localStorage.getItem(WORKFLOW_STORAGE_KEY);
    if (!raw) {
      return [];
    }
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length > MAX_STORED_WORKFLOWS) {
      return [];
    }
    if (!parsed.every(isValidSavedWorkflow)) {
      return [];
    }
    return parsed;
  } catch {
    return [];
  }
}

export function writeStoredWorkflows(records: SavedWorkflowRecord[]): void {
  if (typeof window === 'undefined') {
    return;
  }
  try {
    if (records.length === 0) {
      window.localStorage.removeItem(WORKFLOW_STORAGE_KEY);
      return;
    }
    window.localStorage.setItem(
      WORKFLOW_STORAGE_KEY,
      JSON.stringify(records.slice(0, MAX_STORED_WORKFLOWS)),
    );
  } catch {
    // Ignore storage quota or private-browsing write rejections
  }
}

export function upsertStoredWorkflow(
  workflow: WorkflowToolOutput,
  nowIso?: string,
): SavedWorkflowRecord[] {
  const existing = readStoredWorkflows();
  const normalizedChannels = CANONICAL_CHANNELS.filter((ch) =>
    (workflow.channels ?? []).includes(ch),
  );
  const sanitizedWorkflow: WorkflowToolOutput = {
    ...workflow,
    title: LEGACY_TITLE_UPGRADES[workflow.title] ?? workflow.title,
    channels:
      normalizedChannels.length > 0
        ? normalizedChannels
        : ['google_ads', 'linkedin_ads', 'meta_ads'],
    slug: resolveValidWorkflowShareSlug(workflow),
  };

  const matchIdx = existing.findIndex(
    (item) => item.workflow.workflowId === sanitizedWorkflow.workflowId,
  );
  let next: SavedWorkflowRecord[];
  if (matchIdx !== -1) {
    next = existing.map((item, idx) =>
      idx === matchIdx
        ? {
            ...item,
            workflow: sanitizedWorkflow,
          }
        : item,
    );
  } else {
    const created: SavedWorkflowRecord = {
      workflow: sanitizedWorkflow,
      savedAt: nowIso ?? new Date().toISOString(),
    };
    next = [created, ...existing].slice(0, MAX_STORED_WORKFLOWS);
  }
  writeStoredWorkflows(next);
  return next;
}

export function renameStoredWorkflow(
  workflowId: string,
  customName: string,
): SavedWorkflowRecord[] {
  const existing = readStoredWorkflows();
  const cleaned = customName.trim().replace(/\s+/g, ' ').slice(0, 80);
  const next = existing.map((item) => {
    if (item.workflow.workflowId !== workflowId) {
      return item;
    }
    if (!cleaned || cleaned === item.workflow.title) {
      const rest: SavedWorkflowRecord = {
        workflow: item.workflow,
        savedAt: item.savedAt,
      };
      return rest;
    }
    return {
      ...item,
      customName: cleaned,
    };
  });
  writeStoredWorkflows(next);
  return next;
}

export function removeStoredWorkflow(workflowId: string): SavedWorkflowRecord[] {
  const existing = readStoredWorkflows();
  const next = existing.filter((item) => item.workflow.workflowId !== workflowId);
  writeStoredWorkflows(next);
  return next;
}

export function clearStoredWorkflows(): void {
  if (typeof window === 'undefined') {
    return;
  }
  try {
    window.localStorage.removeItem(WORKFLOW_STORAGE_KEY);
  } catch {
    // Ignore private-browsing storage errors
  }
}
