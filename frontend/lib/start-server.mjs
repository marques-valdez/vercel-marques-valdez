/**
 * Local production server wrapper mirroring Vercel Services routing.
 *
 * On Vercel, `vercel.json` routes `/api/agent/*` to the Python FastAPI service
 * at the platform layer. Locally (`npm start`), this lightweight Node HTTP
 * server forwards `/api/agent/*` directly to `BACKEND_URL` in memory—preserving
 * streaming SSE responses and zero disk writes—while serving all other routes
 * through Next.js.
 */
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import next from 'next';

const currentFilePath = fileURLToPath(import.meta.url);
const currentDir = path.dirname(currentFilePath);
const frontendRoot = path.resolve(currentDir, '..');

export function parseServerCliArgs(argv, env = process.env) {
  let port = Number.parseInt(env.PORT || '3000', 10);
  if (!Number.isFinite(port) || port < 0) {
    port = 3000;
  }
  let hostname = env.HOSTNAME || '0.0.0.0';

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if ((arg === '-p' || arg === '--port') && typeof argv[i + 1] === 'string') {
      const parsed = Number.parseInt(argv[i + 1], 10);
      if (Number.isFinite(parsed) && parsed >= 0) {
        port = parsed;
      }
      i += 1;
    } else if (arg.startsWith('--port=')) {
      const parsed = Number.parseInt(arg.slice('--port='.length), 10);
      if (Number.isFinite(parsed) && parsed >= 0) {
        port = parsed;
      }
    } else if (arg.startsWith('-p=')) {
      const parsed = Number.parseInt(arg.slice('-p='.length), 10);
      if (Number.isFinite(parsed) && parsed >= 0) {
        port = parsed;
      }
    } else if (
      (arg === '-H' || arg === '--hostname') &&
      typeof argv[i + 1] === 'string'
    ) {
      hostname = argv[i + 1];
      i += 1;
    } else if (arg.startsWith('--hostname=')) {
      hostname = arg.slice('--hostname='.length);
    } else if (arg.startsWith('-H=')) {
      hostname = arg.slice('-H='.length);
    }
  }

  return { port, hostname };
}

export function isAgentProxyPath(rawUrl) {
  if (typeof rawUrl !== 'string') {
    return false;
  }
  return (
    rawUrl === '/api/agent' ||
    rawUrl.startsWith('/api/agent/') ||
    rawUrl.startsWith('/api/agent?')
  );
}

export function proxyAgentRequest(req, res, backendOriginRaw) {
  const backendOrigin = (backendOriginRaw || 'http://127.0.0.1:8000').replace(
    /\/+$/,
    '',
  );
  const parsedBackend = new URL(backendOrigin);
  const isTls = parsedBackend.protocol === 'https:';
  const transport = isTls ? https : http;

  const basePath = parsedBackend.pathname.replace(/\/+$/, '');
  const incomingUrl = req.url || '/api/agent';
  const targetPath = `${basePath}${incomingUrl}`;

  const remoteAddr = req.socket?.remoteAddress || '127.0.0.1';
  const priorXff = req.headers['x-forwarded-for'];
  const forwardedFor =
    typeof priorXff === 'string' && priorXff.trim().length > 0
      ? `${priorXff}, ${remoteAddr}`
      : Array.isArray(priorXff) && priorXff.length > 0
        ? `${priorXff.join(', ')}, ${remoteAddr}`
        : remoteAddr;

  const outgoingHeaders = {
    ...req.headers,
    host: parsedBackend.host,
    'x-forwarded-for': forwardedFor,
  };

  const upstreamReq = transport.request(
    {
      protocol: parsedBackend.protocol,
      hostname: parsedBackend.hostname,
      port: parsedBackend.port || (isTls ? 443 : 80),
      method: req.method || 'GET',
      path: targetPath,
      headers: outgoingHeaders,
    },
    (upRes) => {
      res.socket?.setNoDelay?.(true);
      res.writeHead(upRes.statusCode ?? 502, upRes.headers);
      res.flushHeaders();
      upRes.on('error', () => {
        if (!res.writableEnded && !res.destroyed) {
          res.destroy();
        }
      });
      upRes.pipe(res);
    },
  );

  upstreamReq.on('error', (err) => {
    if (res.writableEnded || res.destroyed) {
      return;
    }
    if (!res.headersSent) {
      const payload = JSON.stringify({
        error: 'Upstream Python agent service is unreachable.',
        detail: err instanceof Error ? err.message : 'Connection failed',
      });
      res.writeHead(502, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'Content-Length': Buffer.byteLength(payload),
      });
      res.end(payload);
    } else {
      res.destroy();
    }
  });

  req.on('aborted', () => {
    upstreamReq.destroy();
  });
  req.on('close', () => {
    if (!req.complete) {
      upstreamReq.destroy();
    }
  });
  res.on('close', () => {
    if (!res.writableEnded) {
      upstreamReq.destroy();
    }
  });

  req.pipe(upstreamReq);
}

export function createFrontendRequestListener({ handle, env = process.env }) {
  return (req, res) => {
    const rawPathname = (req.url || '/').split('?')[0];
    try {
      decodeURIComponent(rawPathname);
    } catch {
      const normalizedPath = rawPathname.replace(/^\/+/, '/');
      if (normalizedPath.startsWith('/p/') && normalizedPath.length > 3) {
        res.writeHead(404, {
          'Content-Type': 'text/plain; charset=utf-8',
          'Cache-Control': 'no-store',
        });
        res.end('Playbook not found');
        return;
      }
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Bad Request');
      return;
    }

    if (!env.VERCEL && isAgentProxyPath(req.url)) {
      proxyAgentRequest(req, res, env.BACKEND_URL || 'http://127.0.0.1:8000');
      return;
    }

    Promise.resolve(handle(req, res)).catch(() => {
      if (!res.headersSent && !res.writableEnded && !res.destroyed) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Internal Server Error');
      } else if (!res.writableEnded && !res.destroyed) {
        res.end();
      }
    });
  };
}

export async function startFrontendServer(options = {}) {
  const argv = options.argv ?? process.argv.slice(2);
  const env = options.env ?? process.env;
  const { port, hostname } = parseServerCliArgs(argv, env);

  const app = next({
    dev: false,
    dir: frontendRoot,
    hostname,
    port,
  });

  await app.prepare();
  const handle = app.getRequestHandler();

  const server = http.createServer(
    createFrontendRequestListener({ handle, env }),
  );

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, hostname, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  const address = server.address();
  const boundPort =
    typeof address === 'object' && address !== null ? address.port : port;
  console.log(`▲ Next.js Ready on http://${hostname}:${boundPort}`);

  if (options.registerSignals !== false) {
    let shuttingDown = false;
    const shutdown = () => {
      if (shuttingDown) {
        return;
      }
      shuttingDown = true;
      server.close(() => {
        process.exit(0);
      });
      if (typeof server.closeAllConnections === 'function') {
        server.closeAllConnections();
      }
      setTimeout(() => {
        process.exit(0);
      }, 1500).unref();
    };

    for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
      process.on(sig, shutdown);
    }
  }

  return { server, app, port: boundPort, hostname };
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === currentFilePath) {
  startFrontendServer().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
