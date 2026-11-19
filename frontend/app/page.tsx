/**
 * Primary workspace Server Component (`/`).
 *
 * `force-dynamic` is required so query parameters (`?remix=<slug>` from shared
 * playbook links and `?xray=1` for Architect X-Ray mode) resolve fresh on each
 * request. Reads `backend/app/ui_stream.py` on the server once so the optional
 * X-Ray Inspector can display the live Python SSE adapter source without an
 * extra client fetch.
 */
import React from 'react';
import { WorkspaceClient } from '@/components/WorkspaceClient';
import { resolvePlaybookSlug } from '@/lib/share';
import { loadUiStreamSource } from '@/lib/ui-stream-source';

export const dynamic = 'force-dynamic';

interface WorkspacePageProps {
  searchParams: Promise<{
    remix?: string | string[];
    xray?: string | string[];
  }>;
}

export default async function WorkspacePage({ searchParams }: WorkspacePageProps) {
  const resolvedSearchParams = await searchParams;
  const rawRemix =
    typeof resolvedSearchParams.remix === 'string'
      ? resolvedSearchParams.remix
      : Array.isArray(resolvedSearchParams.remix)
        ? resolvedSearchParams.remix[0]
        : undefined;

  const rawXray =
    typeof resolvedSearchParams.xray === 'string'
      ? resolvedSearchParams.xray
      : Array.isArray(resolvedSearchParams.xray)
        ? resolvedSearchParams.xray[0]
        : undefined;

  const initialRemix = rawRemix ? resolvePlaybookSlug(rawRemix) : null;
  const initialArchitectMode = rawXray === '1' || rawXray === 'true';
  const uiStreamSource = loadUiStreamSource();

  return (
    <WorkspaceClient
      initialRemix={initialRemix}
      initialArchitectMode={initialArchitectMode}
      uiStreamSource={uiStreamSource}
    />
  );
}
