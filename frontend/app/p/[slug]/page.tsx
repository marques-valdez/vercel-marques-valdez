import React from 'react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { CHANNEL_LABELS } from '@/lib/playbooks';
import { resolvePlaybookSlug } from '@/lib/share';

interface SharedPlaybookPageProps {
  params: Promise<{
    slug: string;
  }>;
}

export async function generateMetadata({
  params,
}: SharedPlaybookPageProps): Promise<Metadata> {
  const { slug } = await params;
  const resolved = resolvePlaybookSlug(slug);
  if (!resolved) {
    return {
      title: 'Playbook Not Found · Fieldstone / Relay Studio',
    };
  }
  const encodedSlug = encodeURIComponent(slug);
  return {
    title: `${resolved.title} · Fieldstone / Relay Studio`,
    description: resolved.summary,
    openGraph: {
      title: `${resolved.title} · Fieldstone / Relay Studio`,
      description: resolved.summary,
      images: [
        {
          url: `/api/og?slug=${encodedSlug}`,
          width: 1200,
          height: 630,
          alt: resolved.title,
        },
      ],
    },
  };
}

export default async function SharedPlaybookPage({
  params,
}: SharedPlaybookPageProps) {
  const { slug } = await params;
  const resolved = resolvePlaybookSlug(slug);

  if (!resolved) {
    notFound();
  }

  const remixHref = `/?remix=${encodeURIComponent(slug)}`;

  return (
    <div className="public-playbook-shell">
      <header className="header-bar">
        <div className="header-inner">
          <div className="header-left">
            <span className="brand-mark" aria-hidden="true">
              <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
                <rect
                  x="2"
                  y="2"
                  width="16"
                  height="16"
                  rx="4"
                  stroke="#171717"
                  strokeWidth="1.5"
                />
                <path
                  d="M6 10H10M10 10L13 6M10 10L13 15"
                  stroke="#171717"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </span>
            <span className="brand-title">Fieldstone / Relay Studio</span>
            <span className="pill">Shared Playbook</span>
          </div>
        </div>
      </header>

      <main className="public-playbook-main">
        <article className="public-playbook-card" data-testid="shared-playbook-card">
          <div>
            <div className="playbook-eyebrow">{resolved.eyebrow}</div>
            <h1 className="public-playbook-title">{resolved.title}</h1>
          </div>

          <p className="public-playbook-summary">{resolved.summary}</p>

          <div className="channel-pill-row tabular-nums">
            {resolved.channels.map((ch) => (
              <span key={ch} className="pill channel-pill">
                {CHANNEL_LABELS[ch]}
              </span>
            ))}
            <span className="pill">
              {`Threshold guardrail: ${resolved.threshold}%`}
            </span>
            <span className="pill">{`${resolved.steps.length} steps`}</span>
            <span className="pill mono-text">Zod validated · 0 DB reads</span>
          </div>

          <details className="technical-drawer">
            <summary>Live next/og social card preview (1200×630 PNG)</summary>
            <div className="og-unfurl-card">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={`/api/og?slug=${encodeURIComponent(slug)}`}
                width={1200}
                height={630}
                alt={`${resolved.title} Open Graph preview`}
                className="og-preview-img"
              />
            </div>
          </details>

          <ol className="workflow-step-list tabular-nums">
            {resolved.steps.map((step, index) => (
              <li key={step.node} className="workflow-step-item">
                <div className="workflow-step-top">
                  <div className="workflow-step-title-group">
                    <span className="workflow-step-index">{index + 1}</span>
                    <strong className="workflow-step-name">{step.node}</strong>
                  </div>
                </div>
                <p className="workflow-step-desc">{step.description}</p>
              </li>
            ))}
          </ol>

          <div className="tool-card-footer">
            <Link
              href={remixHref}
              className="btn btn-primary"
              data-testid="open-in-relay-studio"
            >
              Open in Relay Studio
            </Link>
          </div>
        </article>
      </main>
    </div>
  );
}
