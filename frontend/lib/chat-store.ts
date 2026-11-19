import type { RelayUIMessage } from './types';

export const CHAT_STORAGE_KEY = 'relay.chat.messages.v1';
export const MAX_STORED_MESSAGES = 30;

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

function isStoredMessage(value: unknown): value is RelayUIMessage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const rec = value as Record<string, unknown>;
  if (typeof rec.id !== 'string' || !rec.id.trim()) {
    return false;
  }
  if (rec.role !== 'user' && rec.role !== 'assistant' && rec.role !== 'system') {
    return false;
  }
  return Array.isArray(rec.parts);
}

export function readStoredChatMessages(): RelayUIMessage[] {
  const storage = getStorage();
  if (!storage) {
    return [];
  }
  try {
    const raw = storage.getItem(CHAT_STORAGE_KEY);
    if (!raw) {
      return [];
    }
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    const valid = parsed.filter(isStoredMessage).slice(-MAX_STORED_MESSAGES);
    const firstUserIdx = valid.findIndex((m) => m.role === 'user');
    return firstUserIdx > 0 ? valid.slice(firstUserIdx) : valid;
  } catch {
    return [];
  }
}

export function writeStoredChatMessages(messages: RelayUIMessage[]): void {
  const storage = getStorage();
  if (!storage) {
    return;
  }
  try {
    const cleaned = messages
      .filter((msg) => msg.role !== 'assistant' || msg.parts.length > 0)
      .slice(-MAX_STORED_MESSAGES);
    if (cleaned.length === 0) {
      storage.removeItem(CHAT_STORAGE_KEY);
      return;
    }
    storage.setItem(CHAT_STORAGE_KEY, JSON.stringify(cleaned));
  } catch {
    // Ignore quota or storage restriction errors
  }
}

export function clearStoredChatMessages(): void {
  const storage = getStorage();
  if (!storage) {
    return;
  }
  try {
    storage.removeItem(CHAT_STORAGE_KEY);
  } catch {
    // Ignore storage failures
  }
}
