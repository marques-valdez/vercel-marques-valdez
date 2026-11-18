/** @type {import('next').NextConfig} */
const nextConfig = {
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
