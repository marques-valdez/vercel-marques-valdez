import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';
import {
  createFrontendRequestListener,
  isAgentProxyPath,
  parseServerCliArgs,
} from '../lib/start-server.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const frontendRoot = path.resolve(__dirname, '..');
const requireFromFrontend = createRequire(path.join(frontendRoot, 'package.json'));

const moduleCache = new Map();

function loadTsModule(relPath) {
  const fullPath = path.resolve(frontendRoot, relPath);
  if (moduleCache.has(fullPath)) {
    return moduleCache.get(fullPath).exports;
  }

  const source = fs.readFileSync(fullPath, 'utf8');
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: fullPath,
  });

  const mod = { exports: {} };
  moduleCache.set(fullPath, mod);

  const localRequire = (specifier) => {
    if (specifier.startsWith('.')) {
      const candidate = path.resolve(path.dirname(fullPath), `${specifier}.ts`);
      return loadTsModule(path.relative(frontendRoot, candidate));
    }
    return requireFromFrontend(specifier);
  };

  const wrapper = vm.compileFunction(
    transpiled.outputText,
    ['exports', 'require', 'module', '__filename', '__dirname'],
    { filename: fullPath },
  );
  wrapper(mod.exports, localRequire, mod, fullPath, path.dirname(fullPath));
  return mod.exports;
}

const playbooksMod = loadTsModule('lib/playbooks.ts');
const shareMod = loadTsModule('lib/share.ts');
const twinClientMod = loadTsModule('lib/twin-client.ts');
const uiStreamSourceMod = loadTsModule('lib/ui-stream-source.ts');

test('resolvePlaybookSlug resolves all four canonical playbook IDs with six steps', () => {
  const ids = [
    'creative-404-guard',
    'cross-channel-roas',
    'paid-social-reallocation',
    'daily-pacing-guardrail',
  ];

  for (const id of ids) {
    const resolved = shareMod.resolvePlaybookSlug(id);
    assert.ok(resolved, `Expected ${id} to resolve`);
    assert.equal(resolved.template, id);
    assert.equal(resolved.steps.length, 6);
    assert.deepEqual(
      resolved.steps.map((s) => s.node),
      playbooksMod.WORKFLOW_NODE_NAMES,
    );
  }
});

test('encodeCustomPlaybookSlug round-trips custom channels and thresholds and accepts sorted JSON keys', () => {
  const customSlug = shareMod.encodeCustomPlaybookSlug({
    template: 'daily-pacing-guardrail',
    channels: ['meta_ads', 'google_ads'],
    threshold: 35,
  });

  const resolved = shareMod.resolvePlaybookSlug(customSlug);
  assert.ok(resolved);
  assert.equal(resolved.template, 'daily-pacing-guardrail');
  assert.deepEqual(resolved.channels, ['google_ads', 'meta_ads']);
  assert.equal(resolved.threshold, 35);

  const sortedJson = JSON.stringify({
    channels: ['linkedin_ads'],
    template: 'cross-channel-roas',
    threshold: 25,
  });
  const sortedSlug = Buffer.from(sortedJson, 'utf8').toString('base64url');
  const resolvedSorted = shareMod.resolvePlaybookSlug(sortedSlug);
  assert.ok(resolvedSorted);
  assert.equal(resolvedSorted.template, 'cross-channel-roas');
  assert.deepEqual(resolvedSorted.channels, ['linkedin_ads']);
  assert.equal(resolvedSorted.threshold, 25);
});

test('resolvePlaybookSlug rejects prototype keys, tampered base64url, extra JSON properties, out-of-range thresholds, and UTF-8 BOM prefixes', () => {
  const validSlug = shareMod.encodeCustomPlaybookSlug({
    template: 'creative-404-guard',
    channels: ['google_ads'],
    threshold: 20,
  });

  const extraKeySlug = Buffer.from(
    JSON.stringify({
      template: 'creative-404-guard',
      channels: ['google_ads'],
      threshold: 20,
      injectedTitle: 'bad',
    }),
    'utf8',
  ).toString('base64url');

  const duplicateChannelsSlug = Buffer.from(
    JSON.stringify({
      template: 'creative-404-guard',
      channels: ['google_ads', 'google_ads'],
      threshold: 20,
    }),
    'utf8',
  ).toString('base64url');

  const zeroThresholdSlug = Buffer.from(
    JSON.stringify({
      template: 'creative-404-guard',
      channels: ['google_ads'],
      threshold: 0,
    }),
    'utf8',
  ).toString('base64url');

  const floatThresholdSlug = Buffer.from(
    JSON.stringify({
      template: 'creative-404-guard',
      channels: ['google_ads'],
      threshold: 20.5,
    }),
    'utf8',
  ).toString('base64url');

  const invalidUtf8Slug = Buffer.from([255, 254, 253]).toString('base64url');

  const utf8BomPrefixedSlug = Buffer.concat([
    Buffer.from([239, 187, 191]),
    Buffer.from(
      JSON.stringify({
        template: 'creative-404-guard',
        channels: ['google_ads'],
        threshold: 20,
      }),
      'utf8',
    ),
  ]).toString('base64url');

  const trailingSpaceSlug = Buffer.from(
    '{"template":"creative-404-guard","channels":["google_ads"],"threshold":20} ',
    'utf8',
  ).toString('base64url');

  const trailingNewlineSlug = Buffer.from(
    '{"template":"creative-404-guard","channels":["google_ads"],"threshold":20}\n',
    'utf8',
  ).toString('base64url');

  const leadingSpaceSlug = Buffer.from(
    ' {"template":"creative-404-guard","channels":["google_ads"],"threshold":20}',
    'utf8',
  ).toString('base64url');

  const internalWhitespaceSlug = Buffer.from(
    '{ "template": "creative-404-guard", "channels": ["google_ads"], "threshold": 20 }',
    'utf8',
  ).toString('base64url');

  const duplicateJsonKeySlug = Buffer.from(
    '{"template":"injected","template":"creative-404-guard","channels":["google_ads"],"threshold":20}',
    'utf8',
  ).toString('base64url');

  const integerFloatTokenSlug = Buffer.from(
    '{"template":"creative-404-guard","channels":["google_ads"],"threshold":20.0}',
    'utf8',
  ).toString('base64url');

  const scientificTokenSlug = Buffer.from(
    '{"template":"creative-404-guard","channels":["google_ads"],"threshold":2e1}',
    'utf8',
  ).toString('base64url');

  const negativeZeroTokenSlug = Buffer.from(
    '{"template":"creative-404-guard","channels":["google_ads"],"threshold":-0}',
    'utf8',
  ).toString('base64url');

  const rejectedCandidates = [
    '',
    '__proto__',
    'constructor',
    'toString',
    'unknown-template',
    `${validSlug}!`,
    `${validSlug}=`,
    'a'.repeat(520),
    extraKeySlug,
    duplicateChannelsSlug,
    zeroThresholdSlug,
    floatThresholdSlug,
    invalidUtf8Slug,
    utf8BomPrefixedSlug,
    trailingSpaceSlug,
    trailingNewlineSlug,
    leadingSpaceSlug,
    internalWhitespaceSlug,
    duplicateJsonKeySlug,
    integerFloatTokenSlug,
    scientificTokenSlug,
    negativeZeroTokenSlug,
  ];

  for (const candidate of rejectedCandidates) {
    assert.equal(
      shareMod.resolvePlaybookSlug(candidate),
      null,
      `Expected ${candidate} to be rejected`,
    );
  }
});

test('twin-client validates mutation shapes strictly, blocks dedupe/prototype/NaN bypasses, and rolls back localStorage on 422', async () => {
  assert.equal(
    twinClientMod.isValidMutation({ type: 'pause_broken_creatives' }),
    true,
  );
  assert.equal(
    twinClientMod.isValidMutation({ type: 'pause_broken_creatives', extra: 1 }),
    false,
  );
  assert.equal(
    twinClientMod.isValidMutation(
      Object.create({ type: 'pause_broken_creatives' }),
    ),
    false,
  );
  assert.equal(
    twinClientMod.isValidMutation(
      Object.assign(Object.create({ type: 'pause_broken_creatives' }), {
        extra: 1,
      }),
    ),
    false,
  );
  assert.equal(
    twinClientMod.isValidMutation({
      type: 'reallocate_budget',
      from_campaign: 'cmp_linkedin_01',
      to_campaign: 'cmp_google_01',
      amount_per_day: 250,
    }),
    true,
  );
  assert.equal(
    twinClientMod.isValidMutation({
      type: 'reallocate_budget',
      from_campaign: 'cmp_google_01',
      to_campaign: 'cmp_google_01',
      amount_per_day: 250,
    }),
    false,
  );
  assert.equal(
    twinClientMod.isValidMutation({
      type: 'reallocate_budget',
      from_campaign: ' cmp_linkedin_01 ',
      to_campaign: 'cmp_google_01',
      amount_per_day: 250,
    }),
    false,
  );

  const storageMap = new Map();
  globalThis.window = {
    localStorage: {
      getItem: (k) => (storageMap.has(k) ? storageMap.get(k) : null),
      setItem: (k, v) => storageMap.set(k, String(v)),
      removeItem: (k) => storageMap.delete(k),
    },
  };

  const originalFetch = globalThis.fetch;
  try {
    const fakeState = {
      totals: {
        campaignCount: 5,
        adGroupCount: 50,
        rowCount: 500,
        dailyBudget: 1000,
        monthlyBudget: 30000,
        brokenCreatives: 0,
        utmViolations: 0,
        spendAtRiskPerDay: 0,
        blendedRoas: 3.5,
        appliedMutations: 1,
      },
      channels: [],
      campaigns: [],
      hygieneIssues: [],
    };

    let shouldFail = false;
    let fetchCalls = 0;
    globalThis.fetch = async (_url, init) => {
      fetchCalls += 1;
      const parsedBody = JSON.parse(init.body);
      assert.deepEqual(Object.keys(parsedBody), ['mutations']);
      if (shouldFail) {
        return new Response(JSON.stringify({ detail: 'Insufficient budget' }), {
          status: 422,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify(fakeState), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    await twinClientMod.appendTwinMutations([
      { type: 'fix_utm_taxonomy' },
      { type: 'pause_broken_creatives' },
    ]);
    assert.deepEqual(twinClientMod.readStoredMutations(), [
      { type: 'fix_utm_taxonomy' },
      { type: 'pause_broken_creatives' },
    ]);

    const callsBeforeInvalid = fetchCalls;
    await assert.rejects(
      () =>
        twinClientMod.appendTwinMutations([
          { type: 'pause_broken_creatives', extra: 'disallowed' },
        ]),
      (err) => err instanceof twinClientMod.TwinStateError && err.status === 422,
    );
    await assert.rejects(
      () =>
        twinClientMod.appendTwinMutations([
          Object.assign(Object.create({ type: 'pause_broken_creatives' }), {
            extra: 1,
          }),
        ]),
      (err) => err instanceof twinClientMod.TwinStateError && err.status === 422,
    );
    await assert.rejects(
      () =>
        twinClientMod.appendTwinMutations([
          {
            type: 'reallocate_budget',
            from_campaign: 'cmp_linkedin_01',
            to_campaign: 'cmp_google_01',
            amount_per_day: Number.NaN,
          },
        ]),
      (err) => err instanceof twinClientMod.TwinStateError && err.status === 422,
    );
    assert.equal(fetchCalls, callsBeforeInvalid);
    assert.deepEqual(twinClientMod.readStoredMutations(), [
      { type: 'fix_utm_taxonomy' },
      { type: 'pause_broken_creatives' },
    ]);

    shouldFail = true;
    await assert.rejects(() =>
      twinClientMod.appendTwinMutations([
        {
          type: 'reallocate_budget',
          from_campaign: 'cmp_linkedin_01',
          to_campaign: 'cmp_google_01',
          amount_per_day: 50000,
        },
      ]),
    );

    assert.deepEqual(twinClientMod.readStoredMutations(), [
      { type: 'fix_utm_taxonomy' },
      { type: 'pause_broken_creatives' },
    ]);

    shouldFail = false;
    await twinClientMod.resetTwinMutations();
    assert.deepEqual(twinClientMod.readStoredMutations(), []);
  } finally {
    globalThis.fetch = originalFetch;
    delete globalThis.window;
  }
});

test('start-server.mjs proxies /api/agent/* in memory with SSE streaming, 502 error handling, and zero manifest writes', async () => {
  const serverScriptSource = fs.readFileSync(
    path.join(frontendRoot, 'lib', 'start-server.mjs'),
    'utf8',
  );
  assert.equal(serverScriptSource.includes('routes-manifest.json'), false);
  assert.equal(serverScriptSource.includes('writeFileSync'), false);

  assert.deepEqual(
    parseServerCliArgs(['-p', '4050', '-H', '127.0.0.1'], {}),
    { port: 4050, hostname: '127.0.0.1' },
  );
  assert.equal(isAgentProxyPath('/api/agent/health'), true);
  assert.equal(isAgentProxyPath('/api/agent'), true);
  assert.equal(isAgentProxyPath('/api/agent?probe=1'), true);
  assert.equal(isAgentProxyPath('/api/og'), false);
  assert.equal(isAgentProxyPath('/'), false);

  const manifestPath = path.join(frontendRoot, '.next', 'routes-manifest.json');
  const hashBefore = fs.existsSync(manifestPath)
    ? crypto.createHash('sha256').update(fs.readFileSync(manifestPath)).digest('hex')
    : null;

  const upstreamServer = http.createServer((req, res) => {
    if (req.url === '/api/agent/health') {
      const body = JSON.stringify({
        status: 'ok',
        forwardedFor: req.headers['x-forwarded-for'] ?? '',
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(body);
      return;
    }
    if (req.url === '/api/agent/stream') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
      });
      res.write('data: {"type":"start"}\n\n');
      setTimeout(() => {
        res.end('data: [DONE]\n\n');
      }, 15);
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise((resolve) => upstreamServer.listen(0, '127.0.0.1', resolve));
  const upstreamPort = upstreamServer.address().port;

  const proxyServer = http.createServer(
    createFrontendRequestListener({
      handle: async (req, res) => {
        if (req.url === '/boom') {
          throw new Error('Simulated handler rejection');
        }
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('frontend-route');
      },
      env: { BACKEND_URL: `http://127.0.0.1:${upstreamPort}///` },
    }),
  );

  await new Promise((resolve) => proxyServer.listen(0, '127.0.0.1', resolve));
  const proxyPort = proxyServer.address().port;

  try {
    const malformedHexRes = await fetch(
      `http://127.0.0.1:${proxyPort}/p/%FF`,
    );
    assert.equal(malformedHexRes.status, 400);

    const truncatedUtf8Res = await fetch(
      `http://127.0.0.1:${proxyPort}/p/%E0%A4%A`,
    );
    assert.equal(truncatedUtf8Res.status, 400);

    const rejectedHandlerRes = await fetch(
      `http://127.0.0.1:${proxyPort}/boom`,
    );
    assert.equal(rejectedHandlerRes.status, 500);

    const healthRes = await fetch(
      `http://127.0.0.1:${proxyPort}/api/agent/health`,
    );
    assert.equal(healthRes.status, 200);
    const healthJson = await healthRes.json();
    assert.equal(healthJson.status, 'ok');
    assert.ok(healthJson.forwardedFor.length > 0);

    const sseRes = await fetch(
      `http://127.0.0.1:${proxyPort}/api/agent/stream`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: [] }),
      },
    );
    assert.equal(sseRes.status, 200);
    const sseText = await sseRes.text();
    assert.ok(sseText.includes('data: {"type":"start"}'));
    assert.ok(sseText.includes('data: [DONE]'));

    await new Promise((resolve) => upstreamServer.close(resolve));

    const badGatewayRes = await fetch(
      `http://127.0.0.1:${proxyPort}/api/agent/health`,
    );
    assert.equal(badGatewayRes.status, 502);
    const badGatewayJson = await badGatewayRes.json();
    assert.equal(typeof badGatewayJson.error, 'string');
  } finally {
    await new Promise((resolve) => proxyServer.close(resolve));
    if (upstreamServer.listening) {
      await new Promise((resolve) => upstreamServer.close(resolve));
    }
  }

  const buildIdPath = path.join(frontendRoot, '.next', 'BUILD_ID');
  if (fs.existsSync(buildIdPath)) {
    const portProbe = http.createServer();
    await new Promise((resolve) => portProbe.listen(0, '127.0.0.1', resolve));
    const livePort = portProbe.address().port;
    await new Promise((resolve) => portProbe.close(resolve));

    const child = spawn(
      process.execPath,
      [
        path.join(frontendRoot, 'lib', 'start-server.mjs'),
        '-p',
        String(livePort),
        '-H',
        '127.0.0.1',
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );

    let stderrLog = '';
    child.stderr.on('data', (chunk) => {
      stderrLog += chunk.toString('utf8');
    });

    try {
      await new Promise((resolve, reject) => {
        const onEarlyExit = (code) => {
          reject(new Error(`start-server exited early (${code}): ${stderrLog}`));
        };
        child.once('exit', onEarlyExit);
        child.stdout.on('data', (chunk) => {
          if (chunk.toString('utf8').includes('Ready on')) {
            child.removeListener('exit', onEarlyExit);
            resolve();
          }
        });
      });

      const liveBadHex = await fetch(`http://127.0.0.1:${livePort}/p/%FF`);
      assert.equal(liveBadHex.status, 400);

      const liveTruncated = await fetch(
        `http://127.0.0.1:${livePort}/p/%E0%A4%A`,
      );
      assert.equal(liveTruncated.status, 400);

      assert.equal(stderrLog.trim(), '');
    } finally {
      child.kill('SIGTERM');
      await new Promise((resolve) => child.once('exit', resolve));
    }
  }

  const hashAfter = fs.existsSync(manifestPath)
    ? crypto.createHash('sha256').update(fs.readFileSync(manifestPath)).digest('hex')
    : null;
  assert.equal(hashAfter, hashBefore);
});

test('globals.css preserves full contrast on .btn-primary:hover without opacity drop', () => {
  const cssSource = fs.readFileSync(
    path.join(frontendRoot, 'app', 'globals.css'),
    'utf8',
  );
  const hoverMatch = cssSource.match(
    /\.btn-primary:hover:not\(:disabled\)\s*\{([^}]*)\}/,
  );
  assert.ok(hoverMatch, 'Expected .btn-primary:hover:not(:disabled) rule');
  const ruleBody = hoverMatch[1];
  assert.equal(ruleBody.includes('opacity'), false);
  assert.equal(ruleBody.includes('background-color: #0070F3;'), true);
  assert.equal(ruleBody.includes('border-color: #171717;'), true);
  assert.equal(ruleBody.includes('color: #FFFFFF;'), true);
});

test('loadUiStreamSource returns non-empty Python string from disk or fallback', () => {
  const source = uiStreamSourceMod.loadUiStreamSource();
  assert.equal(typeof source, 'string');
  assert.ok(source.length > 0);
});
