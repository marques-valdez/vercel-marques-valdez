/**
 * Root Next.js App Router layout for Relay Studio.
 *
 * Loads Vercel's Geist Sans + Geist Mono via `next/font/google` as CSS
 * variables (zero external CDN flicker) and resolves `metadataBase` from
 * Vercel deployment env vars so Open Graph `/api/og` links unfurl with
 * absolute HTTPS URLs in Slack, LinkedIn, and X.
 */
import type { Metadata } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import { resolveMetadataBase } from '@/lib/share';
import './globals.css';

const geistSans = Geist({
  subsets: ['latin'],
  variable: '--font-geist-sans',
  display: 'swap',
});

const geistMono = Geist_Mono({
  subsets: ['latin'],
  variable: '--font-geist-mono',
  display: 'swap',
});

export const metadata: Metadata = {
  metadataBase: resolveMetadataBase(),
  title: 'Fieldstone / Relay Studio',
  description:
    'Option A capability showcase for Fieldstone Relay: Next.js App Router workspace paired with a Python FastAPI and LangGraph agent over AI Gateway and Vercel Sandbox.',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
