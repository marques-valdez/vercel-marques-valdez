/**
 * Browser-side Digital Twin mutation store (`localStorage`) and Python replay client.
 *
 * Zero-DB state model: rather than writing visitor edits to a shared database,
 * approved budget shifts and hygiene fixes append to `relay.twin.mutations.v1`
 * (capped at 50 validated entries). Every mutation immediately replays against
 * `POST /api/agent/twin/state`; if Python rejects the log (HTTP 422), local
 * storage rolls back atomically so UI and backend never diverge.
 */
import type { DerivedTwinState, Mutation } from './types';

export const TWIN_STORAGE_KEY = 'relay.twin.mutations.v1';
export const MAX_TWIN_MUTATIONS = 50;

export class TwinStateError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'TwinStateError';
    this.status = status;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export function isValidMutation(item: unknown): item is Mutation {
  if (!isPlainObject(item) || !Object.hasOwn(item, 'type')) {
    return false;
  }
  const keys = Object.keys(item);
  if (item.type === 'pause_broken_creatives') {
    return keys.length === 1;
  }
  if (item.type === 'fix_utm_taxonomy') {
    return keys.length === 1;
  }
  if (item.type === 'reallocate_budget') {
    if (
      keys.length !== 4 ||
      !Object.hasOwn(item, 'from_campaign') ||
      !Object.hasOwn(item, 'to_campaign') ||
      !Object.hasOwn(item, 'amount_per_day')
    ) {
      return false;
    }
    const fromCampaign = item.from_campaign;
    const toCampaign = item.to_campaign;
    const amount = item.amount_per_day;
    if (
      typeof fromCampaign !== 'string' ||
      fromCampaign.trim().length === 0 ||
      fromCampaign.trim() !== fromCampaign
    ) {
      return false;
    }
    if (
      typeof toCampaign !== 'string' ||
      toCampaign.trim().length === 0 ||
      toCampaign.trim() !== toCampaign ||
      fromCampaign === toCampaign
    ) {
      return false;
    }
    if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0.000001) {
      return false;
    }
    return true;
  }
  return false;
}

export function readStoredMutations(): Mutation[] {
  if (typeof window === 'undefined') {
    return [];
  }
  try {
    const raw = window.localStorage.getItem(TWIN_STORAGE_KEY);
    if (!raw) {
      return [];
    }
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length > MAX_TWIN_MUTATIONS) {
      return [];
    }
    if (!parsed.every(isValidMutation)) {
      return [];
    }
    return parsed;
  } catch {
    return [];
  }
}

export function writeStoredMutations(mutations: Mutation[]): void {
  if (typeof window === 'undefined') {
    return;
  }
  try {
    if (mutations.length === 0) {
      window.localStorage.removeItem(TWIN_STORAGE_KEY);
      return;
    }
    window.localStorage.setItem(TWIN_STORAGE_KEY, JSON.stringify(mutations));
  } catch {
    // Ignore storage quota or private-browsing write rejections
  }
}

export function clearStoredMutations(): void {
  if (typeof window === 'undefined') {
    return;
  }
  try {
    window.localStorage.removeItem(TWIN_STORAGE_KEY);
  } catch {
    // Ignore private-browsing storage errors
  }
}

export async function fetchTwinState(mutations: Mutation[]): Promise<DerivedTwinState> {
  const response = await fetch('/api/agent/twin/state', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ mutations }),
    cache: 'no-store',
  });

  if (!response.ok) {
    let detail = `Twin state request failed (${response.status})`;
    try {
      const payload = (await response.json()) as { detail?: unknown; error?: string };
      if (typeof payload.detail === 'string') {
        detail = payload.detail;
      } else if (Array.isArray(payload.detail) && payload.detail.length > 0) {
        const first = payload.detail[0] as { msg?: string };
        if (typeof first?.msg === 'string') {
          detail = first.msg;
        }
      } else if (typeof payload.error === 'string') {
        detail = payload.error;
      }
    } catch {
      // Fall back to status message
    }
    throw new TwinStateError(detail, response.status);
  }

  return (await response.json()) as DerivedTwinState;
}

export async function appendTwinMutations(
  newItems: Mutation[],
): Promise<{ mutations: Mutation[]; state: DerivedTwinState }> {
  if (!Array.isArray(newItems) || !newItems.every(isValidMutation)) {
    throw new TwinStateError('Invalid twin mutation payload.', 422);
  }

  const current = readStoredMutations();
  const dedupedToAdd: Mutation[] = [];

  for (const item of newItems) {
    if (
      (item.type === 'pause_broken_creatives' || item.type === 'fix_utm_taxonomy') &&
      (current.some((existing) => existing.type === item.type) ||
        dedupedToAdd.some((existing) => existing.type === item.type))
    ) {
      continue;
    }
    dedupedToAdd.push(item);
  }

  const candidate = [...current, ...dedupedToAdd];
  if (candidate.length > MAX_TWIN_MUTATIONS) {
    throw new TwinStateError(
      `Mutation log cap (${MAX_TWIN_MUTATIONS}) reached. Open Inspector and select Reset demo to continue.`,
      422,
    );
  }

  try {
    const state = await fetchTwinState(candidate);
    writeStoredMutations(candidate);
    return { mutations: candidate, state };
  } catch (err) {
    writeStoredMutations(current);
    throw err;
  }
}

/**
 * Atomically replaces the stored mutation log after replaying `nextMutations`
 * against Python (`POST /api/agent/twin/state`), rolling back `localStorage` if
 * validation fails. Powers 1-click Undo snapshots and campaign-only resets.
 */
export async function replaceTwinMutations(
  nextMutations: Mutation[],
): Promise<{ mutations: Mutation[]; state: DerivedTwinState }> {
  if (!Array.isArray(nextMutations) || !nextMutations.every(isValidMutation)) {
    throw new TwinStateError('Invalid twin mutation payload.', 422);
  }
  if (nextMutations.length > MAX_TWIN_MUTATIONS) {
    throw new TwinStateError(
      `Mutation log cap (${MAX_TWIN_MUTATIONS}) reached. Open Inspector and select Reset demo to continue.`,
      422,
    );
  }

  const previous = readStoredMutations();
  try {
    const state = await fetchTwinState(nextMutations);
    writeStoredMutations(nextMutations);
    return { mutations: nextMutations, state };
  } catch (err) {
    writeStoredMutations(previous);
    throw err;
  }
}

export async function removeTwinMutationAt(
  index: number,
): Promise<{
  mutations: Mutation[];
  state: DerivedTwinState;
  removed: Mutation | null;
}> {
  const current = readStoredMutations();
  if (!Number.isInteger(index) || index < 0 || index >= current.length) {
    const state = await fetchTwinState(current);
    return { mutations: current, state, removed: null };
  }
  const removed = current[index] ?? null;
  const next = current.filter((_, idx) => idx !== index);
  const res = await replaceTwinMutations(next);
  return { ...res, removed };
}

export async function resetTwinMutations(): Promise<DerivedTwinState> {
  clearStoredMutations();
  return fetchTwinState([]);
}
