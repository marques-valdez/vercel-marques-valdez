/**
 * Next.js configuration for Relay Studio's two-service Vercel deployment.
 *
 * - `outputFileTracingRoot` spans the monorepo root and bundles
 *   `backend/app/ui_stream.py` into `/` SSR so `ProtocolXRay` and
 *   `InspectorDrawer` can display the live Python SSE adapter on serverless.
 * - Local `npm run dev` proxies `/api/agent/*` to `BACKEND_URL`; on Vercel
 *   (`process.env.VERCEL`), `vercel.json` Services routes `/api/agent/*` natively.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  outputFileTracingRoot: path.resolve(__dirname, '..'),
  outputFileTracingIncludes: {
    '/': ['../backend/app/ui_stream.py'],
  },
  async rewrites() {
    if (process.env.VERCEL) {
      return [];
    }
    const backendOrigin = (
      process.env.BACKEND_URL || 'http://127.0.0.1:8000'
    ).replace(/\/+$/, '');
    return [
      {
        source: '/api/agent/:path*',
        destination: `${backendOrigin}/api/agent/:path*`,
      },
    ];
  },
};

export default nextConfig;
