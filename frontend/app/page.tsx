import React from 'react';
import { WorkspaceClient } from '@/components/WorkspaceClient';
import { resolvePlaybookSlug } from '@/lib/share';
import { loadUiStreamSource } from '@/lib/ui-stream-source';

export const dynamic = 'force-dynamic';

interface WorkspacePageProps {
  searchParams: Promise<{
    remix?: string | string[];
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

  const initialRemix = rawRemix ? resolvePlaybookSlug(rawRemix) : null;
  const uiStreamSource = loadUiStreamSource();

  return (
    <WorkspaceClient
      initialRemix={initialRemix}
      uiStreamSource={uiStreamSource}
    />
  );
}
