/**
 * Workspace session identity and Neon Postgres sync client.
 *
 * Isolates each visitor's persisted state without requiring a login wall by
 * generating a stable `ws_<uuid>` identifier stored in `localStorage` (or
 * overridden via `/?workspace=<id>` for cross-device continuity). When the
 * Python backend has Neon Postgres connected (`DATABASE_URL`), mutations,
 * saved workflows, and chat history sync to Postgres; otherwise the app runs
 * cleanly in browser-local mode.
 */
import type {
  DerivedTwinState,
  Mutation,
  RelayUIMessage,
  SavedWorkflowRecord,
} from './types';

export const WORKSPACE_ID_STORAGE_KEY = 'relay.workspace.id.v1';
const WORKSPACE_ID_RE = /^[A-Za-z0-9_-]{8,80}$/;

export interface WorkspaceSnapshot {
  workspaceId: string;
  databaseConnected: boolean;
  mutations: Mutation[];
  workflows: SavedWorkflowRecord[];
  messages: RelayUIMessage[];
  telemetryCount: number;
}

function getStorage(): Storage | null {
  if (typeof window === 'undefined') {
    return null;
  }
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function generateWorkspaceId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `ws_${crypto.randomUUID().replace(/-/g, '')}`;
  }
  const randomPart = Math.random().toString(36).slice(2, 12);
  return `ws_${Date.now().toString(36)}_${randomPart}`;
}

export function getOrCreateWorkspaceId(): string {
  const storage = getStorage();
  if (typeof window !== 'undefined') {
    try {
      const fromUrl = new URLSearchParams(window.location.search).get('workspace');
      if (fromUrl && WORKSPACE_ID_RE.test(fromUrl.trim())) {
        const clean = fromUrl.trim();
        storage?.setItem(WORKSPACE_ID_STORAGE_KEY, clean);
        return clean;
      }
    } catch {
      // Ignore URL parsing errors
    }
  }

  try {
    const existing = storage?.getItem(WORKSPACE_ID_STORAGE_KEY);
    if (existing && WORKSPACE_ID_RE.test(existing.trim())) {
      return existing.trim();
    }
  } catch {
    // Ignore storage read errors
  }

  const created = generateWorkspaceId();
  try {
    storage?.setItem(WORKSPACE_ID_STORAGE_KEY, created);
  } catch {
    // Ignore storage write errors
  }
  return created;
}

export async function fetchWorkspaceSnapshot(
  workspaceId: string,
): Promise<WorkspaceSnapshot | null> {
  try {
    const response = await fetch('/api/agent/workspace', {
      method: 'GET',
      cache: 'no-store',
      headers: {
        'X-Relay-Workspace': workspaceId,
      },
    });
    if (!response.ok) {
      return null;
    }
    return (await response.json()) as WorkspaceSnapshot;
  } catch {
    return null;
  }
}

export async function syncWorkspaceMutations(
  workspaceId: string,
  mutations: Mutation[],
): Promise<DerivedTwinState | null> {
  try {
    const response = await fetch('/api/agent/workspace/mutations', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'X-Relay-Workspace': workspaceId,
      },
      body: JSON.stringify({ mutations }),
    });
    if (!response.ok) {
      return null;
    }
    return (await response.json()) as DerivedTwinState;
  } catch {
    return null;
  }
}

export async function syncWorkspaceWorkflows(
  workspaceId: string,
  workflows: SavedWorkflowRecord[],
): Promise<boolean> {
  try {
    const response = await fetch('/api/agent/workspace/workflows', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'X-Relay-Workspace': workspaceId,
      },
      body: JSON.stringify({ workflows }),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export async function syncWorkspaceMessages(
  workspaceId: string,
  messages: RelayUIMessage[],
): Promise<boolean> {
  try {
    const response = await fetch('/api/agent/workspace/messages', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'X-Relay-Workspace': workspaceId,
      },
      body: JSON.stringify({ messages: messages.slice(-30) }),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export async function resetRemoteWorkspace(workspaceId: string): Promise<boolean> {
  try {
    const response = await fetch('/api/agent/workspace', {
      method: 'DELETE',
      headers: {
        'X-Relay-Workspace': workspaceId,
      },
    });
    return response.ok;
  } catch {
    return false;
  }
}
