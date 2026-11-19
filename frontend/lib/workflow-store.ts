import { CANONICAL_CHANNELS, WORKFLOW_NODE_NAMES } from './playbooks';
import { encodePlaybookSlug, PlaybookTemplateSchema, resolvePlaybookSlug } from './share';
import type {
  ChannelId,
  SavedWorkflowRecord,
  WorkflowStepSpec,
  WorkflowToolOutput,
} from './types';

export const WORKFLOW_STORAGE_KEY = 'relay.workflows.v1';
export const MAX_STORED_WORKFLOWS = 25;

export const CANONICAL_WORKFLOW_DEPENDENCIES: Readonly<Record<string, readonly string[]>> = {
  'Fetch channels': [],
  'Check creative URL status': ['Fetch channels'],
  'Validate UTM schema': ['Fetch channels'],
  'Aggregate rows in Sandbox': ['Fetch channels'],
  'Threshold gate': [
    'Check creative URL status',
    'Validate UTM schema',
    'Aggregate rows in Sandbox',
  ],
  Digest: ['Threshold gate'],
};

const CANONICAL_STAGE_BY_NODE: Readonly<Record<string, 0 | 1 | 2 | 3>> = {
  'Fetch channels': 0,
  'Check creative URL status': 1,
  'Validate UTM schema': 1,
  'Aggregate rows in Sandbox': 1,
  'Threshold gate': 2,
  Digest: 3,
};

export interface ResolvedDagStep {
  index: number;
  node: string;
  description: string;
  dependsOn: string[];
  stage: 0 | 1 | 2 | 3;
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
      output.steps?.find((s) => s.node === canonicalNode) ?? output.steps?.[idx];
    const explicitDeps =
      matched?.dependsOn && Array.isArray(matched.dependsOn)
        ? matched.dependsOn.filter((dep) =>
            (WORKFLOW_NODE_NAMES as readonly string[]).includes(dep),
          )
        : null;
    const fallbackDeps = CANONICAL_WORKFLOW_DEPENDENCIES[canonicalNode] ?? [];
    return {
      index: idx,
      node: canonicalNode,
      description: matched?.description || '',
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
  return record.workflow.title;
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
