/**
 * Dynamic Open Graph image generator (`/api/og?slug=...`) powered by `next/og`.
 *
 * Renders a 1200x630 PNG social unfurl card directly from a Zod-validated
 * playbook slug with zero database reads. Rejects duplicate `slug` query
 * parameters or invalid/tampered payloads with HTTP 404 to prevent arbitrary
 * text injection onto generated brand cards.
 */
import React from 'react';
import { ImageResponse } from 'next/og';
import type { NextRequest } from 'next/server';
import { CHANNEL_LABELS } from '@/lib/playbooks';
import { resolvePlaybookSlug } from '@/lib/share';

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;

  const allValues = searchParams.getAll('slug');
  if (allValues.length !== 1) {
    return new Response('Playbook not found', { status: 404 });
  }

  const resolved = resolvePlaybookSlug(allValues[0]);
  if (!resolved) {
    return new Response('Playbook not found', { status: 404 });
  }

  const channelNames = resolved.channels.map((ch) => CHANNEL_LABELS[ch]);

  return new ImageResponse(
    (
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          width: '100%',
          height: '100%',
          backgroundColor: '#FFFFFF',
          color: '#171717',
          padding: 56,
          border: '1px solid #EAEAEA',
          fontFamily: 'sans-serif',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            width: '100%',
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 16,
            }}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: 36,
                height: 36,
                borderRadius: 8,
                border: '2px solid #171717',
                fontSize: 18,
                fontWeight: 700,
              }}
            >
              R
            </div>
            <div
              style={{
                display: 'flex',
                fontSize: 24,
                fontWeight: 600,
                color: '#171717',
              }}
            >
              Fieldstone / Relay Studio
            </div>
          </div>

          <div
            style={{
              display: 'flex',
              padding: '8px 16px',
              backgroundColor: '#FFFFFF',
              border: '1px solid #0070F3',
              borderRadius: 8,
              fontSize: 16,
              fontWeight: 600,
              color: '#171717',
            }}
          >
            {resolved.eyebrow}
          </div>
        </div>

        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 20,
          }}
        >
          <div
            style={{
              display: 'flex',
              fontSize: 56,
              fontWeight: 700,
              lineHeight: 1.15,
              color: '#171717',
              letterSpacing: '-0.02em',
            }}
          >
            {resolved.title}
          </div>

          <div
            style={{
              display: 'flex',
              fontSize: 24,
              lineHeight: 1.45,
              color: '#666666',
            }}
          >
            {resolved.summary}
          </div>
        </div>

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            width: '100%',
            paddingTop: 28,
            borderTop: '1px solid #EAEAEA',
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
            }}
          >
            <div
              style={{
                display: 'flex',
                padding: '8px 16px',
                backgroundColor: '#FAFAFA',
                border: '1px solid #EAEAEA',
                borderRadius: 6,
                fontSize: 18,
                fontWeight: 600,
                color: '#171717',
              }}
            >
              {`${resolved.steps.length} steps`}
            </div>

            {channelNames.map((name) => (
              <div
                key={name}
                style={{
                  display: 'flex',
                  padding: '8px 16px',
                  backgroundColor: '#FAFAFA',
                  border: '1px solid #EAEAEA',
                  borderRadius: 6,
                  fontSize: 18,
                  color: '#171717',
                }}
              >
                {name}
              </div>
            ))}

            <div
              style={{
                display: 'flex',
                padding: '8px 16px',
                backgroundColor: '#FAFAFA',
                border: '1px solid #EAEAEA',
                borderRadius: 6,
                fontSize: 18,
                color: '#666666',
              }}
            >
              {`Threshold: ${resolved.threshold}%`}
            </div>
          </div>

          <div
            style={{
              display: 'flex',
              fontSize: 20,
              fontWeight: 600,
              color: '#171717',
            }}
          >
            Built in Relay Studio
          </div>
        </div>
      </div>
    ),
    {
      width: 1200,
      height: 630,
    },
  );
}
