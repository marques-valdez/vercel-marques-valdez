/**
 * Pure helpers for suppressing self-corrected tool retry errors in default UI mode.
 *
 * When a tool-calling LLM fails parameter validation on attempt 1 and retries
 * the same tool successfully within the same assistant turn, default Marketing
 * Manager mode hides the superseded `output-error` card so the operator sees
 * only the final working card. In `Architect X-Ray` mode every attempt stays
 * visible for debugging, and unrecovered failures always remain visible.
 */

import type { RelayUIMessage } from './types';

export type RelayMessagePart = RelayUIMessage['parts'][number];

export function extractPartToolName(part: RelayMessagePart): string | null {
  if (part.type === 'dynamic-tool') {
    return part.toolName;
  }
  if (part.type.startsWith('tool-')) {
    return part.type.slice('tool-'.length);
  }
  return null;
}

export function collectSucceededToolNames(
  parts: ReadonlyArray<RelayMessagePart>,
): Set<string> {
  const succeeded = new Set<string>();
  for (const part of parts) {
    const toolName = extractPartToolName(part);
    if (!toolName) {
      continue;
    }
    if ('state' in part && part.state === 'output-available') {
      succeeded.add(toolName);
    }
  }
  return succeeded;
}

export function shouldSuppressRetriedToolError(
  part: RelayMessagePart,
  succeededToolNames: ReadonlySet<string>,
  architectMode: boolean,
): boolean {
  if (architectMode) {
    return false;
  }
  const toolName = extractPartToolName(part);
  if (!toolName) {
    return false;
  }
  return (
    'state' in part &&
    part.state === 'output-error' &&
    succeededToolNames.has(toolName)
  );
}
