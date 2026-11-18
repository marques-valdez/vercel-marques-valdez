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
