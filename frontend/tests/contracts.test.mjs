/**
 * Frontend contract & SSR component verification suite (`node --test`).
 *
 * Validates zero-DB share slug codecs, Digital Twin client rollback on 422,
 * local `/api/agent/*` SSE proxy behavior, approval `toolCallId` isolation,
 * chart geometry, progressive card disclosure, What-If simulator math,
 * closed-loop Undo popovers, and zero hardcoded dataset literals.
 */
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
      jsx: fullPath.endsWith('.tsx') ? ts.JsxEmit.ReactJSX : undefined,
      esModuleInterop: true,
    },
    fileName: fullPath,
  });

  const mod = { exports: {} };
  moduleCache.set(fullPath, mod);

  const localRequire = (specifier) => {
    if (specifier.startsWith('.')) {
      const base = path.resolve(path.dirname(fullPath), specifier);
      const cand = fs.existsSync(`${base}.tsx`) ? `${base}.tsx` : `${base}.ts`;
      return loadTsModule(path.relative(frontendRoot, cand));
    }
    if (specifier.startsWith('@/')) {
      const base = path.resolve(frontendRoot, specifier.slice(2));
      const cand = fs.existsSync(`${base}.tsx`) ? `${base}.tsx` : `${base}.ts`;
      return loadTsModule(path.relative(frontendRoot, cand));
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
    assert.equal(malformedHexRes.status, 404);
    assert.equal(malformedHexRes.headers.get('cache-control'), 'no-store');
    assert.equal(await malformedHexRes.text(), 'Playbook not found');

    const truncatedUtf8Res = await fetch(
      `http://127.0.0.1:${proxyPort}/p/%E0%A4%A`,
    );
    assert.equal(truncatedUtf8Res.status, 404);
    assert.equal(await truncatedUtf8Res.text(), 'Playbook not found');

    const malformedSlugRes = await fetch(
      `http://127.0.0.1:${proxyPort}/p/%%%invalid$$$slug===`,
    );
    assert.equal(malformedSlugRes.status, 404);
    assert.equal(await malformedSlugRes.text(), 'Playbook not found');

    const doubleSlashSlugRes = await fetch(
      `http://127.0.0.1:${proxyPort}//p/%FF`,
    );
    assert.equal(doubleSlashSlugRes.status, 404);
    assert.equal(await doubleSlashSlugRes.text(), 'Playbook not found');

    const rootMalformedRes = await fetch(
      `http://127.0.0.1:${proxyPort}/%FF`,
    );
    assert.equal(rootMalformedRes.status, 400);
    assert.equal(await rootMalformedRes.text(), 'Bad Request');

    const agentMalformedRes = await fetch(
      `http://127.0.0.1:${proxyPort}/api/agent/%FF`,
    );
    assert.equal(agentMalformedRes.status, 400);
    assert.equal(await agentMalformedRes.text(), 'Bad Request');

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
      assert.equal(liveBadHex.status, 404);

      const liveTruncated = await fetch(
        `http://127.0.0.1:${livePort}/p/%E0%A4%A`,
      );
      assert.equal(liveTruncated.status, 404);

      const liveMalformedSlug = await fetch(
        `http://127.0.0.1:${livePort}/p/%%%invalid$$$slug===`,
      );
      assert.equal(liveMalformedSlug.status, 404);

      const liveRootMalformed = await fetch(
        `http://127.0.0.1:${livePort}/%FF`,
      );
      assert.equal(liveRootMalformed.status, 400);

      const liveAgentMalformed = await fetch(
        `http://127.0.0.1:${livePort}/api/agent/%FF`,
      );
      assert.equal(liveAgentMalformed.status, 400);

      const liveOgMissingSlug = await fetch(
        `http://127.0.0.1:${livePort}/api/og`,
      );
      assert.equal(liveOgMissingSlug.status, 404);

      const liveOgEmptySlug = await fetch(
        `http://127.0.0.1:${livePort}/api/og?slug=`,
      );
      assert.equal(liveOgEmptySlug.status, 404);

      const liveOgDuplicateSlug = await fetch(
        `http://127.0.0.1:${livePort}/api/og?slug=creative-404-guard&slug=cross-channel-roas`,
      );
      assert.equal(liveOgDuplicateSlug.status, 404);

      const liveOgValid = await fetch(
        `http://127.0.0.1:${livePort}/api/og?slug=creative-404-guard`,
      );
      assert.equal(liveOgValid.status, 200);
      assert.ok(
        (liveOgValid.headers.get('content-type') || '').includes('image/png'),
      );

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

test('ReallocationCard and WorkspaceClient isolate approval decisions per toolCallId across repeated proposalIds', () => {
  const React = requireFromFrontend('react');
  const ReactDOMServer = requireFromFrontend('react-dom/server');
  const { ReallocationCard } = loadTsModule('components/ReallocationCard.tsx');

  const sharedOutput = {
    proposalId: 'prop_repeat_check',
    fromCampaign: 'cmp_social_low',
    fromCampaignName: 'Paid Social Broad',
    fromChannel: 'LinkedIn Ads',
    toCampaign: 'cmp_search_high',
    toCampaignName: 'Search Exact Core',
    toChannel: 'Google Ads',
    amountPerDay: 250,
    before: {
      fromDailyBudget: 800,
      toDailyBudget: 500,
      fromRoas: 1.5,
      toRoas: 4.5,
      totalDailyBudget: 2500,
    },
    after: {
      fromDailyBudget: 550,
      toDailyBudget: 750,
      fromRoas: 1.5,
      toRoas: 4.5,
      totalDailyBudget: 2500,
    },
    blendedRoasBefore: 3.1,
    blendedRoasAfter: 3.4,
  };

  const decisionsByToolCallId = { call_first: 'declined' };

  const firstCardHtml = ReactDOMServer.renderToStaticMarkup(
    React.createElement(ReallocationCard, {
      state: 'completed',
      output: sharedOutput,
      decision: decisionsByToolCallId.call_first ?? null,
      disabled: false,
      onApprove: async () => {},
      onDecline: () => {},
      onRetry: () => {},
    }),
  );
  assert.equal(firstCardHtml.includes('Declined · budgets unchanged'), true);
  assert.equal(firstCardHtml.includes('reallocation-approve-button'), false);

  const secondCardHtml = ReactDOMServer.renderToStaticMarkup(
    React.createElement(ReallocationCard, {
      state: 'completed',
      output: sharedOutput,
      decision: decisionsByToolCallId.call_second ?? null,
      disabled: false,
      onApprove: async () => {},
      onDecline: () => {},
      onRetry: () => {},
    }),
  );
  assert.equal(secondCardHtml.includes('reallocation-approve-button'), true);
  assert.equal(secondCardHtml.includes('reallocation-decline-button'), true);

  const workspaceSource = fs.readFileSync(
    path.join(frontendRoot, 'components', 'WorkspaceClient.tsx'),
    'utf8',
  );
  const toolCallIdLookups =
    workspaceSource.match(/proposalDecisions\[part\.toolCallId\]/g) ?? [];
  assert.equal(toolCallIdLookups.length, 2);
  assert.equal(workspaceSource.includes('proposalDecisions[output.proposalId]'), false);
  assert.equal(workspaceSource.includes('proposalDecisions[out.proposalId]'), false);
  assert.equal(workspaceSource.includes('[proposal.proposalId]:'), false);
});

test('MarkdownText renders headings, lists, inline formatting, and blocks unsafe hrefs', () => {
  const React = requireFromFrontend('react');
  const ReactDOMServer = requireFromFrontend('react-dom/server');
  const { MarkdownText } = loadTsModule('components/MarkdownText.tsx');
  const sample = [
    '#### Google Ads (active overview)',
    '- **Broken 404s:** 4 creatives across *cmp_google_02* (`utm_source=google`)',
    '',
    '### Immediate Recommendations',
    '1. **Pause broken ads** and see [Playbook](/p/creative-404-guard) or [Bad](javascript:alert(1)).',
  ].join('\n');

  const html = ReactDOMServer.renderToStaticMarkup(
    React.createElement(MarkdownText, { text: sample }),
  );
  assert.equal(html.includes('<h4 class="md-h4">Google Ads (active overview)</h4>'), true);
  assert.equal(html.includes('<h3 class="md-h3">Immediate Recommendations</h3>'), true);
  assert.equal(html.includes('<strong>Broken 404s:</strong>'), true);
  assert.equal(html.includes('<em>cmp_google_02</em>'), true);
  assert.equal(html.includes('<code class="md-inline-code">utm_source=google</code>'), true);
  assert.equal(html.includes('<ul class="md-list">'), true);
  assert.equal(html.includes('<ol class="md-list md-list-ordered">'), true);
  assert.equal(html.includes('href="/p/creative-404-guard"'), true);
  assert.equal(html.includes('javascript:'), false);
});


test('V2 Vercel showcase modules: gateway-preview, ProtocolXRay, VercelArchitectureStrip, and SandboxCard context meter', () => {
  const React = requireFromFrontend('react');
  const ReactDOMServer = requireFromFrontend('react-dom/server');
  const { previewGatewayRoute, computeEnterpriseCounterfactual } = loadTsModule(
    'lib/gateway-preview.ts',
  );
  const { ProtocolXRay } = loadTsModule('components/ProtocolXRay.tsx');
  const { VercelArchitectureStrip } = loadTsModule(
    'components/VercelArchitectureStrip.tsx',
  );
  const { SandboxCard } = loadTsModule('components/SandboxCard.tsx');

  const fastRoute = previewGatewayRoute('Check broken creative URLs', null, null);
  assert.equal(fastRoute.tier, 'fast');
  assert.equal(fastRoute.routedBy, 'keyword');

  const reasoningRoute = previewGatewayRoute(
    'Reallocate wasted budget to top search campaigns',
    null,
    null,
  );
  assert.equal(reasoningRoute.tier, 'reasoning');
  assert.equal(reasoningRoute.matchedKeyword, 'realloc');

  const cf = computeEnterpriseCounterfactual(
    [
      {
        tier: 'fast',
        routedBy: 'card',
        primaryModel: 'nvidia/nemotron-3.5-lightning-free',
        servedModel: 'nvidia/nemotron-3.5-lightning-free',
        failover: 'none',
        inputTokens: 1200,
        cachedTokens: 200,
        outputTokens: 300,
        costUsd: 0,
        baselineCostUsd: 0,
        latencyMs: 420,
      },
    ],
    120000,
  );
  assert.equal(cf.actualUsd, 0);
  assert.ok(cf.naiveReasoningPlusCsvUsd > cf.enterpriseTwoTierUsd);
  assert.ok(cf.savingsPct > 90);

  const archHtml = ReactDOMServer.renderToStaticMarkup(
    React.createElement(VercelArchitectureStrip, {
      health: {
        status: 'ok',
        pythonVersion: '3.12.4',
        vercelEnv: 'development',
        deploymentId: 'local',
        commitSha: 'local',
        pricingSource: 'live',
        sandboxAvailable: false,
      },
      healthPingMs: 14,
      injectFailure: false,
      isStreaming: false,
      onToggleInjectFailure: () => {},
      onRunDemoStep: () => {},
      onOpenInspector: () => {},
    }),
  );
  assert.equal(archHtml.includes('Next.js App Router'), true);
  assert.equal(archHtml.includes('Primary 503 drill: Off'), true);
  assert.equal(archHtml.includes('Gateway failover'), false);
  assert.equal(archHtml.includes('Simulated outage'), false);

  const xrayHtml = ReactDOMServer.renderToStaticMarkup(
    React.createElement(ProtocolXRay, {
      frames: [
        {
          id: '0-1',
          offsetMs: 12,
          type: 'start',
          raw: '{"type":"start","messageId":"msg_1"}',
          payload: { type: 'start', messageId: 'msg_1' },
        },
      ],
      uiStreamSource: 'yield format_sse({"type": "start", "messageId": msg_id})',
      defaultOpen: true,
    }),
  );
  assert.equal(xrayHtml.includes('x-vercel-ai-ui-message-stream: v1'), true);
  assert.equal(xrayHtml.includes('backend/app/ui_stream.py'), true);

    const sandboxHtml = ReactDOMServer.renderToStaticMarkup(
    React.createElement(SandboxCard, {
      state: 'completed',
      output: {
        templateId: 'channel_roas_summary',
        mode: 'in-process',
        sandboxMs: 28,
        rowsScanned: 1000,
        rowsReturned: 3,
        sql: 'SELECT channel, SUM(spend) FROM perf GROUP BY channel',
        table: [{ channel: 'Google Ads', roas: 4.1 }],
        estTokensAvoided: 95000,
      },
      onRetry: () => {},
    }),
  );
  assert.equal(sandboxHtml.includes('sandbox-preset-bar'), true);
  assert.equal(sandboxHtml.includes('Spend, pipeline &amp; return on ad spend'), true);
});

test('Workflow store, WorkflowDagView 4-stage fan-out/fan-in topology, WorkflowsDrawer flyout, and HeaderBar counter', () => {
  const React = requireFromFrontend('react');
  const ReactDOMServer = requireFromFrontend('react-dom/server');
  const {
    WORKFLOW_STORAGE_KEY,
    clearStoredWorkflows,
    formatScheduleForMarketer,
    getWorkflowDisplayName,
    readStoredWorkflows,
    removeStoredWorkflow,
    renameStoredWorkflow,
    resolveWorkflowDagSteps,
    upsertStoredWorkflow,
  } = loadTsModule('lib/workflow-store.ts');
  const { WorkflowDagView } = loadTsModule('components/WorkflowDagView.tsx');
  const { WorkflowsDrawer } = loadTsModule('components/WorkflowsDrawer.tsx');
  const { WorkflowCard } = loadTsModule('components/WorkflowCard.tsx');
  const { HeaderBar } = loadTsModule('components/HeaderBar.tsx');

  const backing = new Map();
  const prevWindow = globalThis.window;
  globalThis.window = {
    localStorage: {
      getItem: (k) => (backing.has(k) ? backing.get(k) : null),
      setItem: (k, v) => backing.set(k, String(v)),
      removeItem: (k) => backing.delete(k),
    },
    addEventListener: () => {},
    removeEventListener: () => {},
  };

  try {
    assert.equal(formatScheduleForMarketer('0 7 * * *'), 'Daily at 7:00 AM UTC');
    assert.equal(formatScheduleForMarketer('15 14 * * 1-5'), 'Weekdays at 2:15 PM UTC');

    // Legacy workflow steps & title upgrade cleanly for Marketing Manager UI
    const sampleWf = {
      workflowId: 'wf_1234567890',
      title: 'Compile a daily pacing guardrail',
      template: 'daily-pacing-guardrail',
      slug: '',
      channels: ['linkedin_ads', 'meta_ads'],
      threshold: 12,
      schedule: '0 7 * * *',
      steps: [
        { index: 0, node: 'Fetch channels', description: 'Load snapshot' },
        { index: 1, node: 'Check creative URL status', description: 'Check 404s' },
        { index: 2, node: 'Validate UTM schema', description: 'Check UTMs' },
        { index: 3, node: 'Aggregate rows in Sandbox', description: 'Run SQLite' },
        { index: 4, node: 'Threshold gate', description: 'Evaluate gate' },
        { index: 5, node: 'Digest', description: 'Format digest' },
      ],
      temporalCode: '@workflow.defn\nclass RelayCampaignGuardrailWorkflow:\n    pass\n',
    };

    const resolvedSteps = resolveWorkflowDagSteps(sampleWf);
    assert.equal(resolvedSteps.length, 6);
    assert.deepEqual(resolvedSteps[0].dependsOn, []);
    assert.deepEqual(resolvedSteps[1].dependsOn, ['Pull active campaigns & budgets']);
    assert.deepEqual(resolvedSteps[2].dependsOn, ['Pull active campaigns & budgets']);
    assert.deepEqual(resolvedSteps[3].dependsOn, ['Pull active campaigns & budgets']);
    assert.deepEqual(resolvedSteps[4].dependsOn, [
      'Check landing pages for broken links',
      'Verify UTM tracking tags',
      'Calculate channel spend & ROAS',
    ]);
    assert.deepEqual(resolvedSteps[5].dependsOn, ['Check wasted-spend alert rule']);

    assert.deepEqual(readStoredWorkflows(), []);
    const afterInsert = upsertStoredWorkflow(sampleWf, '2026-11-19T06:00:00Z');
    assert.equal(afterInsert.length, 1);
    assert.ok(backing.has(WORKFLOW_STORAGE_KEY));
    assert.equal(
      getWorkflowDisplayName(afterInsert[0]),
      'Daily pacing & broken-link check',
    );

    const afterRename = renameStoredWorkflow('wf_1234567890', 'Weekday Paid Social Check');
    assert.equal(getWorkflowDisplayName(afterRename[0]), 'Weekday Paid Social Check');

    const dagHtml = ReactDOMServer.renderToStaticMarkup(
      React.createElement(WorkflowDagView, {
        workflow: afterRename[0].workflow,
        stepStates: {
          'Pull active campaigns & budgets': { status: 'completed', ms: 5 },
          'Calculate channel spend & ROAS': { status: 'completed', ms: 24 },
        },
      }),
    );
    assert.equal(dagHtml.includes('data-testid="workflow-dag-view"'), true);
    assert.equal(
      dagHtml.includes(
        'data-dag-edge="Pull active campaigns &amp; budgets-&gt;Check landing pages for broken links"',
      ),
      true,
    );
    assert.equal(
      dagHtml.includes(
        'data-dag-edge="Calculate channel spend &amp; ROAS-&gt;Check wasted-spend alert rule"',
      ),
      true,
    );
    assert.equal(
      dagHtml.includes(
        'data-dag-edge="Check wasted-spend alert rule-&gt;Send morning Slack &amp; Sheets brief"',
      ),
      true,
    );
    assert.equal(dagHtml.includes('✓ Checked'), true);
    assert.equal(dagHtml.includes('Vercel Sandbox'), false);

    const emptyDrawerHtml = ReactDOMServer.renderToStaticMarkup(
      React.createElement(WorkflowsDrawer, {
        isOpen: true,
        workflows: [],
        selectedWorkflowId: null,
        onSelectWorkflow: () => {},
        onRenameWorkflow: () => {},
        onRemoveWorkflow: () => {},
        onShareWorkflow: () => {},
        onCompileSample: () => {},
        onClose: () => {},
      }),
    );
    assert.equal(emptyDrawerHtml.includes('workflows-empty-state'), true);

    const drawerHtml = ReactDOMServer.renderToStaticMarkup(
      React.createElement(WorkflowsDrawer, {
        isOpen: true,
        workflows: afterRename,
        selectedWorkflowId: 'wf_1234567890',
        onSelectWorkflow: () => {},
        onRenameWorkflow: () => {},
        onRemoveWorkflow: () => {},
        onShareWorkflow: () => {},
        onCompileSample: () => {},
        onClose: () => {},
      }),
    );
    assert.equal(drawerHtml.includes('Weekday Paid Social Check'), true);
    assert.equal(drawerHtml.includes('Daily at 7:00 AM UTC'), true);
    assert.equal(drawerHtml.includes('Temporal'), false);

    const cardWithDagBtnHtml = ReactDOMServer.renderToStaticMarkup(
      React.createElement(WorkflowCard, {
        state: 'completed',
        output: afterRename[0].workflow,
        onShare: () => {},
        onOpenInDrawer: () => {},
        onRetry: () => {},
      }),
    );
    assert.equal(cardWithDagBtnHtml.includes('Open visual flow'), true);

    const headerHtml = ReactDOMServer.renderToStaticMarkup(
      React.createElement(HeaderBar, {
        twinState: null,
        workflowCount: 2,
        workflowsOpen: true,
        onOpenShare: () => {},
        onToggleWorkflows: () => {},
      }),
    );
    assert.equal(headerHtml.includes('Workflows (2)'), true);

    const afterRemove = removeStoredWorkflow('wf_1234567890');
    assert.equal(afterRemove.length, 0);
    clearStoredWorkflows();
    assert.equal(backing.has(WORKFLOW_STORAGE_KEY), false);
  } finally {
    globalThis.window = prevWindow;
  }
});

test('chat-store persistence and opt-in Architect X-Ray controls in HeaderBar and Composer', async () => {
  const React = (await import('react')).default;
  const ReactDOMServer = (await import('react-dom/server')).default;
  const {
    CHAT_STORAGE_KEY,
    readStoredChatMessages,
    writeStoredChatMessages,
    clearStoredChatMessages,
  } = loadTsModule('lib/chat-store.ts');
  const { HeaderBar } = loadTsModule('components/HeaderBar.tsx');
  const { Composer } = loadTsModule('components/Composer.tsx');

  const backing = new Map();
  const prevWindow = globalThis.window;
  globalThis.window = {
    localStorage: {
      getItem: (k) => (backing.has(k) ? backing.get(k) : null),
      setItem: (k, v) => backing.set(k, String(v)),
      removeItem: (k) => backing.delete(k),
    },
  };

  try {
    assert.deepEqual(readStoredChatMessages(), []);
    const sampleMessages = [
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'Audit campaigns' }] },
      { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: 'Found active landing page issues.' }] },
    ];
    writeStoredChatMessages(sampleMessages);
    assert.equal(backing.has(CHAT_STORAGE_KEY), true);
    assert.equal(readStoredChatMessages().length, 2);

    clearStoredChatMessages();
    assert.equal(readStoredChatMessages().length, 0);

    const customerHeader = ReactDOMServer.renderToStaticMarkup(
      React.createElement(HeaderBar, {
        twinState: null,
        architectMode: false,
        onOpenShare: () => {},
        onToggleInspector: () => {},
        onToggleArchitectMode: () => {},
      }),
    );
    assert.equal(customerHeader.includes('X-Ray'), true);
    assert.equal(customerHeader.includes('Inspector'), false);

    const xrayHeader = ReactDOMServer.renderToStaticMarkup(
      React.createElement(HeaderBar, {
        twinState: null,
        architectMode: true,
        onOpenShare: () => {},
        onToggleInspector: () => {},
        onToggleArchitectMode: () => {},
      }),
    );
    assert.equal(xrayHeader.includes('X-Ray: On'), true);
    assert.equal(xrayHeader.includes('Inspector'), true);

    const customerComposer = ReactDOMServer.renderToStaticMarkup(
      React.createElement(Composer, {
        value: 'Shift budget across paid social',
        isStreaming: false,
        architectMode: false,
        onChange: () => {},
        onSubmit: () => {},
        onStop: () => {},
      }),
    );
    assert.equal(customerComposer.includes('Google Ads · LinkedIn Ads · Meta Ads'), true);
    assert.equal(customerComposer.includes('AI Gateway ->'), false);

    const xrayComposer = ReactDOMServer.renderToStaticMarkup(
      React.createElement(Composer, {
        value: 'Shift budget across paid social',
        isStreaming: false,
        architectMode: true,
        onChange: () => {},
        onSubmit: () => {},
        onStop: () => {},
      }),
    );
    assert.equal(
      xrayComposer.includes('AI Gateway -&gt; REASONING') ||
        xrayComposer.includes('AI Gateway -> REASONING'),
      true,
    );
  } finally {
    globalThis.window = prevWindow;
  }
});

test('workspace-store ID persistence and Neon Postgres badge in VercelArchitectureStrip', async () => {
  const React = (await import('react')).default;
  const ReactDOMServer = (await import('react-dom/server')).default;
  const { WORKSPACE_ID_STORAGE_KEY, getOrCreateWorkspaceId } = loadTsModule(
    'lib/workspace-store.ts',
  );
  const { VercelArchitectureStrip } = loadTsModule(
    'components/VercelArchitectureStrip.tsx',
  );

  const backing = new Map();
  const prevWindow = globalThis.window;
  globalThis.window = {
    location: { search: '' },
    localStorage: {
      getItem: (k) => (backing.has(k) ? backing.get(k) : null),
      setItem: (k, v) => backing.set(k, String(v)),
      removeItem: (k) => backing.delete(k),
    },
  };

  try {
    const id1 = getOrCreateWorkspaceId();
    assert.ok(id1.startsWith('ws_'));
    assert.equal(backing.get(WORKSPACE_ID_STORAGE_KEY), id1);
    assert.equal(getOrCreateWorkspaceId(), id1);

    globalThis.window.location.search = '?workspace=ws_shared_demo_99';
    assert.equal(getOrCreateWorkspaceId(), 'ws_shared_demo_99');

    const html = ReactDOMServer.renderToStaticMarkup(
      React.createElement(VercelArchitectureStrip, {
        health: {
          status: 'ok',
          pythonVersion: '3.12',
          vercelEnv: 'production',
          deploymentId: 'dpl_1',
          commitSha: 'abc123',
          pricingSource: 'live',
          sandboxAvailable: true,
          databaseConnected: true,
          databaseProvider: 'neon-postgres',
        },
        healthPingMs: 24,
        injectFailure: false,
        isStreaming: false,
        onToggleInjectFailure: () => {},
        onRunDemoStep: () => {},
        onOpenInspector: () => {},
      }),
    );
    assert.equal(html.includes('DB: Neon Postgres'), true);
  } finally {
    globalThis.window = prevWindow;
  }
});

test('TelemetryStrip displays semantic decision routing confidence when present', async () => {
  const React = (await import('react')).default;
  const ReactDOMServer = (await import('react-dom/server')).default;
  const { TelemetryStrip } = loadTsModule('components/TelemetryStrip.tsx');

  const html = ReactDOMServer.renderToStaticMarkup(
    React.createElement(TelemetryStrip, {
      entries: [
        {
          tier: 'reasoning',
          routedBy: 'decision',
          routingConfidence: 0.94,
          routerModel: 'baseten/joey-1',
          primaryModel: 'reflection/beam-free',
          servedModel: 'reflection/beam-free',
          failover: 'none',
          inputTokens: 120,
          cachedTokens: 20,
          outputTokens: 60,
          costUsd: 0,
          baselineCostUsd: 0,
          latencyMs: 310,
        },
      ],
    }),
  );

  assert.equal(html.includes('routed: decision (94%)'), true);
  assert.equal(html.includes('Router model: baseten/joey-1'), true);
});

test('ReallocationCard renders 30-day Monte Carlo P10/P50/P90 forecast band', async () => {
  const React = (await import('react')).default;
  const ReactDOMServer = (await import('react-dom/server')).default;
  const { ReallocationCard } = loadTsModule('components/ReallocationCard.tsx');

  const html = ReactDOMServer.renderToStaticMarkup(
    React.createElement(ReallocationCard, {
      state: 'completed',
      output: {
        proposalId: 'prop_sim_1',
        fromCampaign: 'cmp_a',
        fromCampaignName: 'Prospecting Social',
        fromChannel: 'LinkedIn Ads',
        toCampaign: 'cmp_b',
        toCampaignName: 'Brand Search',
        toChannel: 'Google Ads',
        amountPerDay: 350,
        before: {
          fromDailyBudget: 700,
          toDailyBudget: 900,
          fromRoas: 1.7,
          toRoas: 4.5,
          totalDailyBudget: 5000,
        },
        after: {
          fromDailyBudget: 350,
          toDailyBudget: 1250,
          fromRoas: 1.7,
          toRoas: 4.5,
          totalDailyBudget: 5000,
        },
        blendedRoasBefore: 3.1,
        blendedRoasAfter: 3.3,
        simulation: {
          mode: 'sandbox',
          trials: 2000,
          horizonDays: 30,
          sandboxMs: 412,
          incrementalPipelineP10: 5400,
          incrementalPipelineP50: 8200,
          incrementalPipelineP90: 11100,
          blendedRoasP10: 3.18,
          blendedRoasP50: 3.28,
          blendedRoasP90: 3.39,
          probabilityOfPositiveLiftPct: 95.4,
          targetSaturationDragPct: 6.2,
        },
      },
      decision: null,
      disabled: false,
      onApprove: async () => {},
      onDecline: () => {},
      onRetry: () => {},
    }),
  );

  assert.equal(html.includes('30-day pipeline forecast'), true);
  assert.equal(html.includes('95% chance of positive lift'), true);
  assert.equal(html.includes('+$5,400'), true);
  assert.equal(html.includes('+$8,200'), true);
  assert.equal(html.includes('+$11,100'), true);
  assert.equal(html.includes('6.2% marginal ROAS compression'), true);
});

test('WorkflowNextSteps renders deep-dive hygiene and budget-shift pills for active issues and healthy state', async () => {
  const React = (await import('react')).default;
  const ReactDOMServer = (await import('react-dom/server')).default;
  const { WorkflowNextSteps } = loadTsModule('components/WorkflowNextSteps.tsx');

  const activeHtml = ReactDOMServer.renderToStaticMarkup(
    React.createElement(WorkflowNextSteps, {
      channels: ['google_ads', 'linkedin_ads'],
      digestSummary: {
        brokenCreatives: 7,
        utmViolations: 4,
        spendAtRiskPerDay: 920.5,
        lowestRoasChannel: {
          channel: 'LinkedIn Ads',
          channelId: 'linkedin_ads',
          roas: 1.5,
        },
        highestRoasChannel: {
          channel: 'Google Ads',
          channelId: 'google_ads',
          roas: 4.2,
        },
      },
      onRunPrompt: () => {},
    }),
  );

  assert.equal(activeHtml.includes('RECOMMENDED NEXT STEPS'), true);
  assert.equal(activeHtml.includes('Action needed · $920.50/day at risk'), true);
  assert.equal(activeHtml.includes('Inspect &amp; fix 7 broken links &amp; 4 UTM tags'), true);
  assert.equal(
    activeHtml.includes('Shift spend from LinkedIn Ads (1.50x) to Google Ads (4.20x)'),
    true,
  );

  const healthyHtml = ReactDOMServer.renderToStaticMarkup(
    React.createElement(WorkflowNextSteps, {
      channels: ['google_ads', 'linkedin_ads'],
      digestSummary: {
        brokenCreatives: 0,
        utmViolations: 0,
        spendAtRiskPerDay: 0,
        lowestRoasChannel: {
          channel: 'LinkedIn Ads',
          channelId: 'linkedin_ads',
          roas: 1.5,
        },
        highestRoasChannel: {
          channel: 'Google Ads',
          channelId: 'google_ads',
          roas: 4.2,
        },
      },
      onRunPrompt: () => {},
    }),
  );

  assert.equal(healthyHtml.includes('All links &amp; UTMs healthy'), true);
  assert.equal(healthyHtml.includes('Compare channel spend &amp; ROAS'), true);
  assert.equal(healthyHtml.includes('next-step-hygiene-pill'), false);
});

test('BackendAlertBanner and buildHttpErrorAlert translate 429/422/504 and render Retry/Dismiss', async () => {
  const React = (await import('react')).default;
  const ReactDOMServer = (await import('react-dom/server')).default;
  const { BackendAlertBanner, buildHttpErrorAlert } = loadTsModule(
    'components/BackendAlertBanner.tsx',
  );

  const rateLimit = buildHttpErrorAlert(
    429,
    JSON.stringify({ detail: 'Rate limit exceeded' }),
  );
  assert.equal(rateLimit.severity, 'warning');
  assert.equal(rateLimit.title, 'RATE LIMIT REACHED');
  assert.equal(rateLimit.retryable, true);

  const timeout = buildHttpErrorAlert(504, '<html>Gateway Timeout</html>');
  assert.equal(timeout.severity, 'error');
  assert.equal(timeout.title, 'SERVICE TEMPORARILY UNAVAILABLE');
  assert.equal(timeout.technicalDetail, 'HTTP 504');

  const customerHtml = ReactDOMServer.renderToStaticMarkup(
    React.createElement(BackendAlertBanner, {
      alert: timeout,
      architectMode: false,
      onRetry: () => {},
      onDismiss: () => {},
    }),
  );
  assert.equal(customerHtml.includes('SERVICE TEMPORARILY UNAVAILABLE'), true);
  assert.equal(customerHtml.includes('Retry'), true);
  assert.equal(customerHtml.includes('Dismiss'), true);
  assert.equal(customerHtml.includes('HTTP 504'), false);

  const xrayHtml = ReactDOMServer.renderToStaticMarkup(
    React.createElement(BackendAlertBanner, {
      alert: timeout,
      architectMode: true,
      onRetry: () => {},
      onDismiss: () => {},
    }),
  );
  assert.equal(xrayHtml.includes('HTTP 504'), true);
});


test('Chart primitives render scaled bars, stacked shares, before/after comparisons, P10-P90 range geometry, and threshold gauges', async () => {
  const React = (await import('react')).default;
  const ReactDOMServer = (await import('react-dom/server')).default;
  const {
    BarRow,
    StackedShareBar,
    BeforeAfterBars,
    RangeBar,
    ThresholdGauge,
    WorkflowVisualSummary,
    computeBarPercent,
    computeStackedSegments,
    computeRangeGeometry,
    computeThresholdGauge,
  } = loadTsModule('components/charts.tsx');
  const { ChannelHealthStrip } = loadTsModule('components/ChannelHealthStrip.tsx');
  const { HygieneCard } = loadTsModule('components/HygieneCard.tsx');

  // Edge cases on pure math helpers
  assert.equal(computeBarPercent(0, 100), 0);
  assert.equal(computeBarPercent(-5, 100), 0);
  assert.equal(computeBarPercent(Number.NaN, 100), 0);
  assert.equal(computeBarPercent(50, 100), 50);
  assert.equal(computeBarPercent(1, 1000), 3); // visible positive floor

  const stacked = computeStackedSegments([
    { id: 'a', label: 'A', value: 30, color: '#0070F3' },
    { id: 'b', label: 'B', value: 0, color: '#7C3AED' },
    { id: 'c', label: 'C', value: -10, color: '#0E9F9A' },
    { id: 'd', label: 'D', value: 70, color: '#0E8A16' },
  ]);
  assert.equal(stacked.length, 2);
  assert.equal(stacked[0].pct, 30);
  assert.equal(stacked[1].pct, 70);

  const posRange = computeRangeGeometry(2000, 5000, 9000);
  assert.equal(posRange.allNonNegative, true);
  assert.equal(posRange.allNegative, false);
  assert.ok(posRange.p10Pct < posRange.p50Pct && posRange.p50Pct < posRange.p90Pct);

  const mixedRange = computeRangeGeometry(-1500, 1000, 4500);
  assert.equal(mixedRange.allNonNegative, false);
  assert.equal(mixedRange.allNegative, false);
  assert.ok(mixedRange.zeroPct !== null && mixedRange.zeroPct > mixedRange.p10Pct);

  const flatRange = computeRangeGeometry(0, 0, 0);
  assert.equal(flatRange.p50Pct, 50);

  const triggeredGauge = computeThresholdGauge(24, 15);
  assert.equal(triggeredGauge.status, 'triggered');
  assert.ok(triggeredGauge.fillPct > triggeredGauge.thresholdPctPos);

  const healthyGauge = computeThresholdGauge(4, 15);
  assert.equal(healthyGauge.status, 'healthy');
  assert.ok(healthyGauge.fillPct < healthyGauge.thresholdPctPos);

  const zeroGauge = computeThresholdGauge(0, 15);
  assert.equal(zeroGauge.fillPct, 0);
  assert.equal(zeroGauge.status, 'healthy');

  const barHtml = ReactDOMServer.renderToStaticMarkup(
    React.createElement(BarRow, {
      label: 'Google Ads',
      value: 4.2,
      maxValue: 4.2,
      valueText: '4.20x ROAS',
      color: 'var(--channel-google)',
    }),
  );
  assert.equal(barHtml.includes('width:100%'), true);
  assert.equal(barHtml.includes('4.20x ROAS'), true);

  const stackedHtml = ReactDOMServer.renderToStaticMarkup(
    React.createElement(StackedShareBar, {
      title: 'Split',
      segments: [
        { id: 'g', label: 'Google Ads', value: 600, valueText: '$600/day', color: 'var(--channel-google)' },
        { id: 'm', label: 'Meta Ads', value: 400, valueText: '$400/day', color: 'var(--channel-meta)' },
      ],
    }),
  );
  assert.equal(stackedHtml.includes('width:60%'), true);
  assert.equal(stackedHtml.includes('width:40%'), true);

  const baHtml = ReactDOMServer.renderToStaticMarkup(
    React.createElement(BeforeAfterBars, {
      items: [
        {
          id: 'c1',
          label: 'Paid Social',
          beforeValue: 500,
          afterValue: 300,
          beforeText: '$500/day',
          afterText: '$300/day',
          deltaText: '-$200/day',
          deltaTone: 'negative',
          color: 'var(--channel-linkedin)',
        },
      ],
    }),
  );
  assert.equal(baHtml.includes('-$200/day'), true);
  assert.equal(baHtml.includes('width:100%'), true);
  assert.equal(baHtml.includes('width:60%'), true);

  const rangeHtml = ReactDOMServer.renderToStaticMarkup(
    React.createElement(RangeBar, {
      p10: 2500,
      p50: 4800,
      p90: 7100,
      p10Text: '+$2,500',
      p50Text: '+$4,800',
      p90Text: '+$7,100',
    }),
  );
  assert.equal(rangeHtml.includes('<svg'), true);
  assert.equal(rangeHtml.includes('+$4,800'), true);

  const gaugeHtml = ReactDOMServer.renderToStaticMarkup(
    React.createElement(ThresholdGauge, {
      label: 'Daily spend at risk',
      valuePct: 22.5,
      thresholdPct: 15,
      valueText: '22.5%',
    }),
  );
  assert.equal(gaugeHtml.includes('Alert triggered'), true);
  assert.equal(gaugeHtml.includes('22.5%'), true);

  const wfVisualHtml = ReactDOMServer.renderToStaticMarkup(
    React.createElement(WorkflowVisualSummary, {
      digestPreview: 'Morning brief payload',
      digestSummary: {
        brokenCreatives: 3,
        utmViolations: 2,
        spendAtRiskPerDay: 450,
        spendAtRiskPct: 22.5,
        thresholdPct: 15,
        gateTriggered: true,
        blendedRoas: 3.1,
        highestRoasChannel: { channel: 'Google Ads', channelId: 'google_ads', roas: 4.4 },
        lowestRoasChannel: { channel: 'LinkedIn Ads', channelId: 'linkedin_ads', roas: 1.5 },
      },
      channels: ['google_ads', 'linkedin_ads'],
      threshold: 15,
    }),
  );
  assert.equal(wfVisualHtml.includes('workflow-threshold-gauge'), true);
  assert.equal(wfVisualHtml.includes('workflow-roas-bars'), true);
  assert.equal(wfVisualHtml.includes('<details'), true);
  assert.equal(wfVisualHtml.includes('Morning brief payload'), true);

  const stripHtml = ReactDOMServer.renderToStaticMarkup(
    React.createElement(ChannelHealthStrip, {
      twinState: {
        totals: {
          campaignCount: 4,
          adGroupCount: 16,
          rowCount: 400,
          dailyBudget: 1000,
          monthlyBudget: 30000,
          brokenCreatives: 2,
          utmViolations: 1,
          spendAtRiskPerDay: 150,
          blendedRoas: 3.2,
          appliedMutations: 0,
        },
        channels: [
          {
            channel: 'Google Ads',
            channelId: 'google_ads',
            campaignCount: 2,
            adGroupCount: 8,
            dailyBudget: 600,
            brokenCreatives: 0,
            utmViolations: 0,
            spendAtRiskPerDay: 0,
            totalSpend: 6000,
            totalPipelineValue: 24000,
            roas: 4.0,
          },
          {
            channel: 'LinkedIn Ads',
            channelId: 'linkedin_ads',
            campaignCount: 2,
            adGroupCount: 8,
            dailyBudget: 400,
            brokenCreatives: 2,
            utmViolations: 1,
            spendAtRiskPerDay: 150,
            totalSpend: 4000,
            totalPipelineValue: 8000,
            roas: 2.0,
          },
        ],
        campaigns: [],
        hygieneIssues: [],
      },
      errorText: null,
      onRetry: () => {},
      onReset: () => {},
    }),
  );
  assert.equal(stripHtml.includes('channel-budget-share-bar'), true);
  assert.equal(stripHtml.includes('health-channel-google'), true);
  assert.equal(stripHtml.includes('health-chip-danger'), true);

  const hygieneHtml = ReactDOMServer.renderToStaticMarkup(
    React.createElement(HygieneCard, {
      state: 'completed',
      output: {
        brokenCount: 1,
        utmCount: 1,
        totalSpendAtRiskPerDay: 350,
        flaggedItems: [
          {
            issueId: 'iss_1',
            issueType: 'broken_404',
            channel: 'Google Ads',
            channelId: 'google_ads',
            campaignId: 'c1',
            campaignName: 'Brand Exact',
            adGroupId: 'ag_1',
            value: 'https://example.com/404',
            dailySpendAtRisk: 250,
          },
          {
            issueId: 'iss_2',
            issueType: 'utm_violation',
            channel: 'Meta Ads',
            channelId: 'meta_ads',
            campaignId: 'c2',
            campaignName: 'Retargeting',
            adGroupId: 'ag_2',
            value: 'missing utm_campaign',
            dailySpendAtRisk: 100,
          },
        ],
      },
      twinState: null,
      onApplyFix: async () => {},
      onRetry: () => {},
    }),
  );
  assert.equal(hygieneHtml.includes('hygiene-risk-chart'), true);
  assert.equal(hygieneHtml.includes('pill-danger'), true);
  assert.equal(hygieneHtml.includes('pill-amber'), true);
});

test('Floating Composer renders accessible send button, hides counter below 1500 chars, and preserves channel & X-Ray rows', async () => {
  const React = (await import('react')).default;
  const ReactDOMServer = (await import('react-dom/server')).default;
  const { Composer } = loadTsModule('components/Composer.tsx');

  const idleHtml = ReactDOMServer.renderToStaticMarkup(
    React.createElement(Composer, {
      value: '',
      isStreaming: false,
      hasConversation: false,
      onChange: () => {},
      onSubmit: () => {},
      onStop: () => {},
    }),
  );
  assert.equal(idleHtml.includes('aria-label="Send message"'), true);
  assert.equal(idleHtml.includes('composer-form-idle'), true);
  assert.equal(idleHtml.includes('Ask Relay about your campaigns…'), true);
  assert.equal(idleHtml.includes('composer-counter'), false);
  assert.equal(idleHtml.includes('Google Ads · LinkedIn Ads · Meta Ads'), true);

  const longInputHtml = ReactDOMServer.renderToStaticMarkup(
    React.createElement(Composer, {
      value: 'a'.repeat(1550),
      isStreaming: false,
      hasConversation: true,
      onChange: () => {},
      onSubmit: () => {},
      onStop: () => {},
    }),
  );
  assert.equal(longInputHtml.includes('composer-counter'), true);
  assert.equal(longInputHtml.includes('1,550 / 2,000'), true);
  assert.equal(longInputHtml.includes('composer-form-idle'), false);
  assert.equal(longInputHtml.includes('composer-send-btn-ready'), true);
});

test('use-chat-scroll decision logic pins new user prompts, skips hydration and mid-stream updates, and toggles Jump to latest pill', () => {
  const {
    getLatestUserMessageId,
    shouldScrollToNewPrompt,
    computeJumpPillState,
  } = loadTsModule('lib/use-chat-scroll.ts');

  assert.equal(
    getLatestUserMessageId([
      { id: 'u1', role: 'user' },
      { id: 'a1', role: 'assistant' },
      { id: 'u2', role: 'user' },
    ]),
    'u2',
  );
  assert.equal(getLatestUserMessageId([{ id: 'a1', role: 'assistant' }]), null);

  // Saved history hydrating on page reload -> never auto-scroll
  assert.equal(
    shouldScrollToNewPrompt({
      prevLastUserId: null,
      nextLastUserId: 'u1',
      isStreaming: false,
      isHydrating: true,
    }),
    false,
  );

  // User submits new prompt -> scroll immediately to pin it
  assert.equal(
    shouldScrollToNewPrompt({
      prevLastUserId: 'u1',
      nextLastUserId: 'u2',
      isStreaming: true,
      isHydrating: false,
    }),
    true,
  );

  // Assistant keeps streaming tokens for same user turn -> never force-scroll
  assert.equal(
    shouldScrollToNewPrompt({
      prevLastUserId: 'u2',
      nextLastUserId: 'u2',
      isStreaming: true,
      isHydrating: false,
    }),
    false,
  );

  // Pill hidden when 0 messages or when sentinel is visible
  assert.deepEqual(
    computeJumpPillState({ messageCount: 0, isSentinelVisible: false, isStreaming: false }),
    { visible: false, label: '', isStreaming: false },
  );
  assert.deepEqual(
    computeJumpPillState({ messageCount: 2, isSentinelVisible: true, isStreaming: true }),
    { visible: false, label: '', isStreaming: false },
  );

  // Pill shows "Jump to latest" when idle & scrolled up, "New reply" when streaming & scrolled up
  assert.deepEqual(
    computeJumpPillState({ messageCount: 4, isSentinelVisible: false, isStreaming: false }),
    { visible: true, label: 'Jump to latest', isStreaming: false },
  );
  assert.deepEqual(
    computeJumpPillState({ messageCount: 4, isSentinelVisible: false, isStreaming: true }),
    { visible: true, label: 'New reply', isStreaming: true },
  );
});


test('AgentProgressCard renders live step checklist with 4-dot spinner, elapsed timer, and collapsed summary when settled', async () => {
  const React = (await import('react')).default;
  const ReactDOMServer = (await import('react-dom/server')).default;
  const {
    AgentProgressCard,
    finalizeProgressSteps,
    formatElapsedSeconds,
    splitFocusHeadline,
  } = loadTsModule('components/AgentProgressCard.tsx');

  assert.equal(formatElapsedSeconds(0), '0s');
  assert.equal(formatElapsedSeconds(22), '22s');
  assert.equal(formatElapsedSeconds(65), '1m 05s');
  assert.deepEqual(splitFocusHeadline('Auditing landing pages for 404 links…'), {
    lead: 'Auditing',
    rest: ' landing pages for 404 links',
  });

  const liveSteps = [
    { id: 'plan', title: 'Review request & live campaigns', status: 'done' },
    { id: 'tool:1', title: 'Audit landing pages & UTM tags', status: 'in_progress' },
    { id: 'tool:2', title: 'Simulate budget shift & 30-day forecast', status: 'pending' },
    { id: 'synthesize', title: 'Summarize findings & next steps', status: 'pending' },
  ];

  const liveHtml = ReactDOMServer.renderToStaticMarkup(
    React.createElement(AgentProgressCard, {
      steps: liveSteps,
      focus: 'Auditing landing pages for 404 links and UTM tracking gaps',
      isStreaming: true,
      startedAtMs: Date.now() - 8000,
    }),
  );
  assert.equal(liveHtml.includes('agent-progress-steps'), true);
  assert.equal(liveHtml.includes('agent-dots-spinner'), true);
  assert.equal(liveHtml.includes('agent-step-circle'), true);
  assert.equal(liveHtml.includes('aria-expanded="true"'), true);
  assert.equal(liveHtml.includes('Auditing'), true);
  assert.equal(liveHtml.includes('Audit landing pages &amp; UTM tags'), true);

  const settledSteps = finalizeProgressSteps(liveSteps, false, false);
  assert.equal(settledSteps.every((s) => s.status === 'done'), true);

  const erroredSteps = finalizeProgressSteps(liveSteps, false, true);
  assert.equal(erroredSteps[1].status, 'failed');
  assert.equal(erroredSteps[2].status, 'pending');

  const doneHtml = ReactDOMServer.renderToStaticMarkup(
    React.createElement(AgentProgressCard, {
      steps: liveSteps,
      focus: 'Summarizing findings and next steps',
      isStreaming: false,
      completedDurationMs: 4200,
    }),
  );
  assert.equal(doneHtml.includes('agent-progress-steps'), false);
  assert.equal(doneHtml.includes('aria-expanded="false"'), true);
  assert.equal(doneHtml.includes('Completed'), true);
  assert.equal(doneHtml.includes('4 steps'), true);
  assert.equal(doneHtml.includes('4s'), true);
});


test('tool-errors suppresses superseded tool retry errors in default mode while keeping X-Ray and unrecovered errors visible', () => {
  const {
    collectSucceededToolNames,
    shouldSuppressRetriedToolError,
  } = loadTsModule('lib/tool-errors.ts');

  const retriedParts = [
    {
      type: 'tool-audit_campaign_hygiene',
      toolCallId: 'c1',
      state: 'output-error',
      errorText: 'Unsupported channel filter \'"all"\'',
    },
    {
      type: 'tool-audit_campaign_hygiene',
      toolCallId: 'c2',
      state: 'output-available',
      output: { brokenCount: 1, utmCount: 0, totalSpendAtRiskPerDay: 50 },
    },
    {
      type: 'tool-analyze_in_sandbox',
      toolCallId: 'c3',
      state: 'output-error',
      errorText: 'Sandbox error',
    },
  ];

  const succeeded = collectSucceededToolNames(retriedParts);
  assert.equal(succeeded.has('audit_campaign_hygiene'), true);
  assert.equal(succeeded.has('analyze_in_sandbox'), false);

  // Superseded hygiene retry error hidden in default mode, shown in X-Ray
  assert.equal(shouldSuppressRetriedToolError(retriedParts[0], succeeded, false), true);
  assert.equal(shouldSuppressRetriedToolError(retriedParts[0], succeeded, true), false);

  // Succeeded part is never suppressed
  assert.equal(shouldSuppressRetriedToolError(retriedParts[1], succeeded, false), false);

  // Unrecovered error stays visible in both modes
  assert.equal(shouldSuppressRetriedToolError(retriedParts[2], succeeded, false), false);
  assert.equal(shouldSuppressRetriedToolError(retriedParts[2], succeeded, true), false);
});


test('computeClientReallocationPreview conserves daily budget and ReallocationCard renders interactive slider', async () => {
  const React = (await import('react')).default;
  const ReactDOMServer = (await import('react-dom/server')).default;
  const {
    computeClientReallocationPreview,
    ReallocationCard,
  } = loadTsModule('components/ReallocationCard.tsx');

  const sampleProposal = {
    proposalId: 'prop-slider-1',
    fromCampaign: 'CMP-10',
    fromCampaignName: 'LinkedIn ABM Executive',
    fromChannel: 'LinkedIn Ads',
    toCampaign: 'CMP-20',
    toCampaignName: 'Meta Remarketing Core',
    toChannel: 'Meta Ads',
    amountPerDay: 300,
    blendedRoasBefore: 3.1,
    blendedRoasAfter: 3.35,
    rationale: 'Shift budget toward stronger recent conversion efficiency.',
    requiresConfirmation: true,
    before: {
      fromDailyBudget: 1200,
      toDailyBudget: 900,
      fromRoas: 1.4,
      toRoas: 4.5,
      totalDailyBudget: 5000,
    },
    after: {
      fromDailyBudget: 900,
      toDailyBudget: 1200,
      totalDailyBudget: 5000,
    },
    simulation: {
      horizonDays: 30,
      trials: 2000,
      mode: 'sandbox',
      sandboxMs: 240,
      incrementalPipelineP10: 1400,
      incrementalPipelineP50: 4200,
      incrementalPipelineP90: 7100,
      blendedRoasP10: 3.15,
      blendedRoasP50: 3.35,
      blendedRoasP90: 3.55,
      probabilityOfPositiveLiftPct: 92,
      targetSaturationDragPct: 4.2,
    },
  };

  const preview600 = computeClientReallocationPreview(sampleProposal, 600);
  assert.equal(preview600.amountPerDay, 600);
  assert.equal(
    preview600.after.fromDailyBudget + preview600.after.toDailyBudget,
    sampleProposal.before.fromDailyBudget + sampleProposal.before.toDailyBudget,
  );
  assert.equal(preview600.after.fromDailyBudget, 600);
  assert.equal(preview600.after.toDailyBudget, 1500);
  assert.ok(preview600.blendedRoasAfter > sampleProposal.blendedRoasAfter);

  const defaultHtml = ReactDOMServer.renderToStaticMarkup(
    React.createElement(ReallocationCard, {
      state: 'output-available',
      output: sampleProposal,
      decision: null,
      architectMode: false,
      onApprove: () => {},
      onDecline: () => {},
      onRetry: () => {},
    }),
  );
  assert.equal(defaultHtml.includes('data-testid="reallocation-whatif-slider"'), true);
  assert.equal(defaultHtml.includes('data-testid="reallocation-preset-25"'), true);
  assert.equal(defaultHtml.includes('data-testid="reallocation-preset-100"'), true);
  assert.equal(defaultHtml.includes('data-testid="reallocation-forecast-band"'), true);
  assert.equal(defaultHtml.includes('Vercel Sandbox microVM'), false);

  const xrayHtml = ReactDOMServer.renderToStaticMarkup(
    React.createElement(ReallocationCard, {
      state: 'output-available',
      output: sampleProposal,
      decision: null,
      architectMode: true,
      onApprove: () => {},
      onDecline: () => {},
      onRetry: () => {},
    }),
  );
  assert.equal(xrayHtml.includes('Vercel Sandbox microVM'), true);
  assert.equal(xrayHtml.includes('240ms'), true);
});


test('TrendSparkline, DailyAnomalyChart, and SandboxCard render daily variance geometry', async () => {
  const React = (await import('react')).default;
  const ReactDOMServer = (await import('react-dom/server')).default;
  const {
    computeSparklineGeometry,
    TrendSparkline,
    computeAnomalySeries,
    DailyAnomalyChart,
  } = loadTsModule('components/charts.tsx');
  const { SandboxCard } = loadTsModule('components/SandboxCard.tsx');

  const points = [
    { date: '2026-10-19', spend: 500, revenue: 1500, roas: 3.0 },
    { date: '2026-10-20', spend: 520, revenue: 1820, roas: 3.5 },
    { date: '2026-10-21', spend: 540, revenue: 2160, roas: 4.0 },
  ];
  const geom = computeSparklineGeometry(points, 180, 38);
  assert.equal(geom.coords.length, 3);
  assert.equal(geom.linePath.startsWith('M '), true);
  assert.equal(geom.areaPath.endsWith(' Z'), true);

  const sparkHtml = ReactDOMServer.renderToStaticMarkup(
    React.createElement(TrendSparkline, {
      series: {
        channelId: 'meta_ads',
        channel: 'Meta Ads',
        firstWindowRoas: 3.0,
        lastWindowRoas: 4.0,
        deltaPct: 33.3,
        points,
      },
      color: 'var(--accent-green)',
      testId: 'spark-test',
    }),
  );
  assert.equal(sparkHtml.includes('data-testid="spark-test"'), true);
  assert.equal(sparkHtml.includes('trend-delta-up'), true);
  assert.equal(sparkHtml.includes('+33.3%'), true);

  // Unsorted anomaly rows get sorted chronologically
  const anomalyRows = [
    {
      date: '2026-11-12',
      channel: 'Google Ads',
      total_spend: 2600,
      avg_daily_spend: 1800,
      spend_delta_pct: 44.4,
      roas: 2.9,
    },
    {
      date: '2026-11-03',
      channel: 'LinkedIn Ads',
      total_spend: 900,
      avg_daily_spend: 1500,
      spend_delta_pct: -40.0,
      roas: 1.5,
    },
  ];
  const series = computeAnomalySeries(anomalyRows);
  assert.equal(series.items.length, 2);
  assert.equal(series.items[0].date, '2026-11-03');
  assert.equal(series.items[1].date, '2026-11-12');

  const chartHtml = ReactDOMServer.renderToStaticMarkup(
    React.createElement(DailyAnomalyChart, { rows: anomalyRows }),
  );
  assert.equal(chartHtml.includes('data-testid="daily-anomaly-chart"'), true);
  assert.equal(chartHtml.includes('Nov 3'), true);
  assert.equal(chartHtml.includes('Nov 12'), true);

  const sandboxHtml = ReactDOMServer.renderToStaticMarkup(
    React.createElement(SandboxCard, {
      state: 'output-available',
      output: {
        templateId: 'daily_pacing_anomalies',
        rowsScanned: 24,
        executionMs: 14,
        sandboxMode: 'in-process',
        sql: 'SELECT * FROM relay_daily_performance',
        table: anomalyRows,
      },
      onRetry: () => {},
    }),
  );
  assert.equal(sandboxHtml.includes('data-testid="daily-anomaly-chart"'), true);
});


test('buildTurnFollowUps and TurnFollowUps generate grounded non-workflow follow-ups and suppress workflow turns', async () => {
  const React = (await import('react')).default;
  const ReactDOMServer = (await import('react-dom/server')).default;
  const {
    buildChannelDrilldownPrompt,
    buildTurnFollowUps,
  } = loadTsModule('lib/follow-ups.ts');
  const { TurnFollowUps } = loadTsModule('components/TurnFollowUps.tsx');

  const drill = buildChannelDrilldownPrompt('LinkedIn Ads', 'broken_404');
  assert.equal(drill.tierHint, 'fast');
  assert.equal(drill.prompt.includes('LinkedIn Ads'), true);
  assert.equal(drill.prompt.includes('404'), true);

  const sampleTwin = {
    channels: [
      {
        channelId: 'linkedin_ads',
        channel: 'LinkedIn Ads',
        dailyBudget: 1500,
        roas: 1.4,
        brokenCreatives: 2,
        utmViolations: 1,
      },
      {
        channelId: 'meta_ads',
        channel: 'Meta Ads',
        dailyBudget: 2100,
        roas: 4.1,
        brokenCreatives: 0,
        utmViolations: 2,
      },
    ],
    totals: { dailyBudget: 3600, monthlyBudget: 108000, blendedRoas: 2.98 },
    baseline: { dailyBudget: 3600, monthlyBudget: 108000, blendedRoas: 2.98 },
    activeMutationsCount: 0,
  };

  const hygieneChips = buildTurnFollowUps({
    parts: [
      {
        type: 'tool-audit_campaign_hygiene',
        toolCallId: 'h1',
        state: 'output-available',
        output: { brokenCount: 2, utmCount: 3, totalSpendAtRiskPerDay: 720 },
      },
    ],
    twinState: sampleTwin,
    proposalDecisions: {},
  });
  assert.ok(hygieneChips.length >= 2 && hygieneChips.length <= 3);

  const workflowChips = buildTurnFollowUps({
    parts: [
      {
        type: 'tool-compile_workflow',
        toolCallId: 'w1',
        state: 'output-available',
        output: { workflowId: 'wf-1', name: 'Daily guardrail' },
      },
    ],
    twinState: sampleTwin,
    proposalDecisions: {},
  });
  assert.equal(workflowChips.length, 0);

  const renderedFollowUps = ReactDOMServer.renderToStaticMarkup(
    React.createElement(TurnFollowUps, {
      chips: hygieneChips,
      onSelect: () => {},
    }),
  );
  assert.equal(renderedFollowUps.includes('data-testid="turn-follow-ups"'), true);
  assert.equal(renderedFollowUps.includes('turn-followup-chip'), true);
});


test('ChannelHealthStrip interactive triggers and interpolateEaseOut behave cleanly', async () => {
  const React = (await import('react')).default;
  const ReactDOMServer = (await import('react-dom/server')).default;
  const { interpolateEaseOut } = loadTsModule('lib/use-animated-number.ts');
  const { ChannelHealthStrip } = loadTsModule('components/ChannelHealthStrip.tsx');

  assert.equal(interpolateEaseOut(0, 100, 0), 0);
  assert.equal(interpolateEaseOut(0, 100, 1), 100);
  const mid = interpolateEaseOut(0, 100, 0.5);
  assert.ok(mid > 50 && mid < 100);

  const twin = {
    channels: [
      {
        channelId: 'google_ads',
        channel: 'Google Ads',
        dailyBudget: 1800,
        roas: 3.1,
        brokenCreatives: 1,
        utmViolations: 0,
      },
      {
        channelId: 'meta_ads',
        channel: 'Meta Ads',
        dailyBudget: 2200,
        roas: 4.2,
        brokenCreatives: 0,
        utmViolations: 2,
      },
    ],
    totals: { dailyBudget: 4000, monthlyBudget: 120000, blendedRoas: 3.7 },
    baseline: { dailyBudget: 4000, monthlyBudget: 120000, blendedRoas: 3.7 },
    activeMutationsCount: 0,
  };

  const stripHtml = ReactDOMServer.renderToStaticMarkup(
    React.createElement(ChannelHealthStrip, {
      twinState: twin,
      errorText: null,
      trends: {
        meta_ads: {
          channelId: 'meta_ads',
          channel: 'Meta Ads',
          firstWindowRoas: 3.1,
          lastWindowRoas: 4.2,
          deltaPct: 35.5,
          points: [
            { date: '2026-10-19', spend: 500, revenue: 1550, roas: 3.1 },
            { date: '2026-11-17', spend: 600, revenue: 2520, roas: 4.2 },
          ],
        },
      },
      onRetry: () => {},
      onReset: () => {},
      onInspectChannel: () => {},
      onOptimizePortfolio: () => {},
    }),
  );
  assert.equal(stripHtml.includes('health-channel-trigger'), true);
  assert.equal(stripHtml.includes('health-chip-btn'), true);
  assert.equal(stripHtml.includes('data-testid="trend-sparkline-meta_ads"'), true);
  assert.equal(stripHtml.includes('data-testid="optimize-mix-btn"'), true);
});


test('V6 concise cards: HygieneCard Top-5 & filter pills, SandboxCard Top-6, and sequential TurnFollowUps primary chip', async () => {
  const React = (await import('react')).default;
  const ReactDOMServer = (await import('react-dom/server')).default;
  const { HygieneCard } = loadTsModule('components/HygieneCard.tsx');
  const { SandboxCard } = loadTsModule('components/SandboxCard.tsx');
  const { TurnFollowUps } = loadTsModule('components/TurnFollowUps.tsx');
  const { buildTurnFollowUps } = loadTsModule('lib/follow-ups.ts');

  const syntheticIssues = Array.from({ length: 8 }, (_, idx) => ({
    issueId: `syn_iss_${idx + 1}`,
    channel: idx % 2 === 0 ? 'Google Ads' : 'Meta Ads',
    campaignName: `Synthetic Campaign Row ${idx + 1}`,
    adGroupId: `syn_ag_${idx + 1}`,
    issueType: idx < 4 ? 'broken_404' : 'utm_violation',
    value: idx < 4 ? `https://example.invalid/p/${idx + 1}` : `utm_missing_${idx + 1}`,
    dailySpendAtRisk: 100 - idx * 5,
  }));

  const hygieneHtml = ReactDOMServer.renderToStaticMarkup(
    React.createElement(HygieneCard, {
      state: 'completed',
      output: {
        brokenCount: 4,
        utmCount: 4,
        totalSpendAtRiskPerDay: 660,
        flaggedItems: syntheticIssues,
      },
      twinState: null,
      onApplyFix: async () => {},
      onRetry: () => {},
    }),
  );
  assert.equal(hygieneHtml.includes('All (8)'), true);
  assert.equal(hygieneHtml.includes('Broken 404 (4)'), true);
  assert.equal(hygieneHtml.includes('UTM tags (4)'), true);
  assert.equal(hygieneHtml.includes('Show all 8 issues'), true);
  assert.equal(hygieneHtml.includes('Synthetic Campaign Row 5'), true);
  assert.equal(hygieneHtml.includes('Synthetic Campaign Row 6'), false);

  const syntheticSandboxRows = Array.from({ length: 9 }, (_, idx) => ({
    campaign_name: `Perf Sample ${idx + 1}`,
    spend: 500 + idx * 10,
    roas: 2.1 + idx * 0.1,
  }));

  const sandboxHtml = ReactDOMServer.renderToStaticMarkup(
    React.createElement(SandboxCard, {
      state: 'output-available',
      output: {
        templateId: 'campaign_roas_ranking',
        rowsScanned: 90,
        executionMs: 12,
        table: syntheticSandboxRows,
        summary: 'Top slice rendered.',
      },
      onRetry: () => {},
    }),
  );
  assert.equal(sandboxHtml.includes('Show all 9 rows'), true);
  assert.equal(sandboxHtml.includes('Perf Sample 6'), true);
  assert.equal(sandboxHtml.includes('Perf Sample 7'), false);

  const twin = {
    channels: [
      { channelId: 'google_ads', channel: 'Google Ads', dailyBudget: 900, roas: 2.4, brokenCreatives: 1, utmViolations: 1 },
      { channelId: 'meta_ads', channel: 'Meta Ads', dailyBudget: 1100, roas: 3.9, brokenCreatives: 0, utmViolations: 0 },
    ],
    totals: { dailyBudget: 2000, monthlyBudget: 60000, blendedRoas: 3.2, brokenCreatives: 1, utmViolations: 1 },
    baseline: { dailyBudget: 2000, monthlyBudget: 60000, blendedRoas: 3.2, brokenCreatives: 1, utmViolations: 1 },
    activeMutationsCount: 0,
  };

  const sandboxChipFirst = (templateId) =>
    buildTurnFollowUps({
      parts: [
        {
          type: 'tool-analyze_in_sandbox',
          toolCallId: `sbx-${templateId}`,
          state: 'output-available',
          output: { templateId, rowsScanned: 10, executionMs: 5, table: [], summary: '' },
        },
      ],
      twinState: twin,
      proposalDecisions: {},
    })[0];

  assert.equal(sandboxChipFirst('channel_roas_summary').id, 'perf-next-campaigns');
  assert.equal(sandboxChipFirst('campaign_roas_ranking').id, 'perf-next-adgroups');
  assert.equal(sandboxChipFirst('ad_group_efficiency').id, 'perf-next-anomalies');
  assert.equal(sandboxChipFirst('daily_pacing_anomalies').id, 'perf-next-channels');

  const hygieneChips = buildTurnFollowUps({
    parts: [
      {
        type: 'tool-audit_campaign_hygiene',
        toolCallId: 'hyg-seq-1',
        state: 'output-available',
        output: { brokenCount: 1, utmCount: 1, totalSpendAtRiskPerDay: 200, flaggedItems: [] },
      },
    ],
    twinState: twin,
    proposalDecisions: {},
  });
  assert.equal(hygieneChips[0].id, 'hygiene-to-perf');

  const followUpsHtml = ReactDOMServer.renderToStaticMarkup(
    React.createElement(TurnFollowUps, {
      chips: hygieneChips,
      disabled: false,
      onSelect: () => {},
    }),
  );
  assert.equal(followUpsHtml.includes('turn-followup-primary'), true);
  assert.equal(followUpsHtml.includes('Default next step:'), true);
});


test('V7 demo polish: PlaybookGrid live badges, HygieneCard resolved state, ReallocationCard pair override, ImpactToast, ChangesPopover, and X-Ray tour progress', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const React = (await import('react')).default;
  const ReactDOMServer = (await import('react-dom/server')).default;
  const { PlaybookGrid, computePlaybookLiveBadge } = loadTsModule('components/PlaybookGrid.tsx');
  const { HygieneCard } = loadTsModule('components/HygieneCard.tsx');
  const { ReallocationCard, computeClientReallocationPreview } = loadTsModule('components/ReallocationCard.tsx');
  const { ImpactToast } = loadTsModule('components/ImpactToast.tsx');
  const { ChangesPopover, describeMutation } = loadTsModule('components/ChangesPopover.tsx');
  const { VercelArchitectureStrip } = loadTsModule('components/VercelArchitectureStrip.tsx');

  // Verify app/icon.svg exists and renders valid SVG
  const iconSvgPath = path.join(process.cwd(), 'app', 'icon.svg');
  assert.equal(fs.existsSync(iconSvgPath), true);
  assert.equal(fs.readFileSync(iconSvgPath, 'utf-8').includes('<svg'), true);

  const syntheticTwin = {
    totals: {
      campaignCount: 4,
      adGroupCount: 16,
      rowCount: 400,
      dailyBudget: 2500,
      monthlyBudget: 75000,
      brokenCreatives: 3,
      utmViolations: 2,
      spendAtRiskPerDay: 450,
      blendedRoas: 3.1,
      appliedMutations: 1,
    },
    channels: [
      { channel: 'Google Ads', channelId: 'google_ads', campaignCount: 2, adGroupCount: 8, dailyBudget: 1500, brokenCreatives: 1, utmViolations: 0, spendAtRiskPerDay: 150, totalSpend: 15000, totalPipelineValue: 63000, roas: 4.2 },
      { channel: 'LinkedIn Ads', channelId: 'linkedin_ads', campaignCount: 2, adGroupCount: 8, dailyBudget: 1000, brokenCreatives: 2, utmViolations: 2, spendAtRiskPerDay: 300, totalSpend: 10000, totalPipelineValue: 18000, roas: 1.8 },
    ],
    campaigns: [
      { campaignId: 'syn_c1', name: 'Alpha Search', channel: 'Google Ads', channelId: 'google_ads', matchType: 'exact', adGroupCount: 4, dailyBudget: 900, totalSpend: 9000, totalClicks: 1000, totalConversions: 50, totalPipelineValue: 40500, roas: 4.5, brokenCreatives: 0, utmViolations: 0 },
      { campaignId: 'syn_c2', name: 'Beta Social', channel: 'LinkedIn Ads', channelId: 'linkedin_ads', matchType: 'audience', adGroupCount: 4, dailyBudget: 600, totalSpend: 6000, totalClicks: 400, totalConversions: 8, totalPipelineValue: 9000, roas: 1.5, brokenCreatives: 2, utmViolations: 1 },
      { campaignId: 'syn_c3', name: 'Gamma Retarget', channel: 'Google Ads', channelId: 'google_ads', matchType: 'phrase', adGroupCount: 4, dailyBudget: 1000, totalSpend: 10000, totalClicks: 900, totalConversions: 60, totalPipelineValue: 50000, roas: 5.0, brokenCreatives: 0, utmViolations: 0 },
    ],
    hygieneIssues: [],
  };

  const guardActive = computePlaybookLiveBadge('creative-404-guard', syntheticTwin, 0);
  assert.equal(guardActive.label, '5 open issues · $450/day at risk');
  const guardHealthy = computePlaybookLiveBadge(
    'creative-404-guard',
    { ...syntheticTwin, totals: { ...syntheticTwin.totals, brokenCreatives: 0, utmViolations: 0, spendAtRiskPerDay: 0 } },
    0,
  );
  assert.equal(guardHealthy.label, '✓ All links & UTMs healthy');
  assert.equal(computePlaybookLiveBadge('daily-pacing-guardrail', syntheticTwin, 2).label, '2 scheduled checks saved');

  const gridHtml = ReactDOMServer.renderToStaticMarkup(
    React.createElement(PlaybookGrid, {
      highlightedPlaybookId: null,
      disabled: false,
      twinState: syntheticTwin,
      workflowCount: 1,
      onSelectPlaybook: () => {},
    }),
  );
  assert.equal(gridHtml.includes('data-testid="playbook-live-badge-creative-404-guard"'), true);
  assert.equal(gridHtml.includes('2.40x ROAS gap · LinkedIn → Google'), true);

  // HygieneCard resolved row badges when twin reports 0 open issues
  const resolvedHygieneHtml = ReactDOMServer.renderToStaticMarkup(
    React.createElement(HygieneCard, {
      state: 'completed',
      output: {
        brokenCount: 1,
        utmCount: 1,
        totalSpendAtRiskPerDay: 220,
        flaggedItems: [
          { issueId: 'i1', issueType: 'broken_404', status: 'active', channel: 'Google Ads', channelId: 'google_ads', campaignId: 'syn_c1', campaignName: 'Alpha Search', adGroupId: 'ag1', value: 'https://example.invalid/404', recommendedFix: 'Pause', dailySpendAtRisk: 120 },
          { issueId: 'i2', issueType: 'utm_violation', status: 'active', channel: 'LinkedIn Ads', channelId: 'linkedin_ads', campaignId: 'syn_c2', campaignName: 'Beta Social', adGroupId: 'ag2', value: 'utm_missing', recommendedFix: 'Fix', dailySpendAtRisk: 100 },
        ],
      },
      twinState: { ...syntheticTwin, totals: { ...syntheticTwin.totals, brokenCreatives: 0, utmViolations: 0, spendAtRiskPerDay: 0 } },
      onApplyFix: async () => {},
      onRetry: () => {},
    }),
  );
  assert.equal(resolvedHygieneHtml.includes('protected · 0 open issues'), true);
  assert.equal(resolvedHygieneHtml.includes('✓ Ad paused'), true);
  assert.equal(resolvedHygieneHtml.includes('✓ UTM repaired'), true);

  // ReallocationCard campaign pair override math & picker markup
  const baseProp = {
    proposalId: 'p_syn',
    fromCampaign: 'syn_c2',
    fromCampaignName: 'Beta Social',
    fromChannel: 'LinkedIn Ads',
    toCampaign: 'syn_c1',
    toCampaignName: 'Alpha Search',
    toChannel: 'Google Ads',
    amountPerDay: 200,
    before: { fromDailyBudget: 600, toDailyBudget: 900, fromRoas: 1.5, toRoas: 4.5, totalDailyBudget: 2500 },
    after: { fromDailyBudget: 400, toDailyBudget: 1100, fromRoas: 1.5, toRoas: 4.5, totalDailyBudget: 2500 },
    blendedRoasBefore: 3.1,
    blendedRoasAfter: 3.34,
  };
  const pairOverridden = computeClientReallocationPreview(baseProp, 300, {
    fromCampaign: syntheticTwin.campaigns[1],
    toCampaign: syntheticTwin.campaigns[2],
  });
  assert.equal(pairOverridden.toCampaign, 'syn_c3');
  assert.equal(pairOverridden.toCampaignName, 'Gamma Retarget');
  assert.equal(pairOverridden.after.fromDailyBudget + pairOverridden.after.toDailyBudget, 1600);
  assert.ok(pairOverridden.blendedRoasAfter > baseProp.blendedRoasBefore);

  const reallocPickerHtml = ReactDOMServer.renderToStaticMarkup(
    React.createElement(ReallocationCard, {
      state: 'completed',
      output: baseProp,
      decision: null,
      disabled: false,
      campaigns: syntheticTwin.campaigns,
      onApprove: async () => {},
      onDecline: () => {},
      onRetry: () => {},
    }),
  );
  assert.equal(reallocPickerHtml.includes('data-testid="reallocation-campaign-picker"'), true);
  assert.equal(reallocPickerHtml.includes('data-testid="reallocation-swap-campaigns"'), true);

  // ImpactToast, ChangesPopover, and VercelArchitectureStrip tour progress
  const toastHtml = ReactDOMServer.renderToStaticMarkup(
    React.createElement(ImpactToast, {
      toast: { id: 't1', title: 'Fixes saved', detail: '$450/day protected', tone: 'green', undoSnapshot: [] },
      onUndo: () => {},
      onJumpTop: () => {},
      onDismiss: () => {},
    }),
  );
  assert.equal(toastHtml.includes('data-testid="impact-toast-undo"'), true);

  const mutDesc = describeMutation(
    { type: 'reallocate_budget', from_campaign: 'syn_c2', to_campaign: 'syn_c3', amount_per_day: 250 },
    syntheticTwin.campaigns,
  );
  assert.equal(mutDesc.subtitle, 'Beta Social → Gamma Retarget');

  const popoverHtml = ReactDOMServer.renderToStaticMarkup(
    React.createElement(ChangesPopover, {
      isOpen: true,
      mutations: [{ type: 'pause_broken_creatives' }],
      baselineTotals: { ...syntheticTwin.totals, blendedRoas: 2.9, spendAtRiskPerDay: 450 },
      currentTotals: { ...syntheticTwin.totals, blendedRoas: 3.25, spendAtRiskPerDay: 0 },
      campaigns: syntheticTwin.campaigns,
      onUndoAt: () => {},
      onRevertAllMutations: () => {},
      onResetFullWorkspace: () => {},
      onClose: () => {},
    }),
  );
  assert.equal(popoverHtml.includes('data-testid="changes-popover"'), true);
  assert.equal(popoverHtml.includes('+0.35x net'), true);

  const archDoneHtml = ReactDOMServer.renderToStaticMarkup(
    React.createElement(VercelArchitectureStrip, {
      health: null,
      healthPingMs: 12,
      injectFailure: false,
      isStreaming: false,
      completedSteps: { sandbox: true, xray: true },
      onToggleInjectFailure: () => {},
      onRunDemoStep: () => {},
      onOpenInspector: () => {},
    }),
  );
  assert.equal(archDoneHtml.includes('(2/4 ✓)'), true);
});

test('computeBacktestSummary recomputes alert days client-side below, inside, and above the data range', () => {
  const { computeBacktestSummary } = loadTsModule('components/charts.tsx');
  const { clampBacktestThreshold, resolveBacktestSliderMax } = loadTsModule(
    'components/BacktestPanel.tsx',
  );
  const pcts = [6, 9, 21, 21, 8, 21, 21, 21];
  const points = pcts.map((pct, idx) => ({
    date: `2026-11-${String(idx + 1).padStart(2, '0')}`,
    spend: 1000,
    atRiskSpend: pct * 10,
    atRiskPct: pct,
  }));

  const below = computeBacktestSummary(points, 5);
  assert.deepEqual(
    [below.alertDays, below.totalDays, below.longestStreakDays, below.firstAlertDate],
    [8, 8, 8, '2026-11-01'],
  );
  const inside = computeBacktestSummary(points, 15);
  assert.deepEqual(
    [inside.alertDays, inside.longestStreakDays, inside.firstAlertDate, inside.flaggedSpend],
    [5, 3, '2026-11-03', 1050],
  );
  const edge = computeBacktestSummary(points, 21);
  assert.equal(edge.alertDays, 5);
  const above = computeBacktestSummary(points, 22);
  assert.deepEqual(
    [above.alertDays, above.longestStreakDays, above.firstAlertDate, above.flaggedSpend],
    [0, 0, null, 0],
  );
  assert.equal(computeBacktestSummary([], 10).totalDays, 0);

  assert.equal(resolveBacktestSliderMax(15, 21.3), 30);
  assert.equal(resolveBacktestSliderMax(15, 38.2), 45);
  assert.equal(resolveBacktestSliderMax(80, 21.3), 80);
  assert.equal(resolveBacktestSliderMax(15, 400), 100);
  assert.equal(clampBacktestThreshold(0, 30), 1);
  assert.equal(clampBacktestThreshold(99, 30), 30);
  assert.equal(clampBacktestThreshold(Number.NaN, 30), 1);
});

test('BacktestTimeline colors alert days and marks broken-link dates; panels start collapsed behind a button', () => {
  const React = requireFromFrontend('react');
  const ReactDOMServer = requireFromFrontend('react-dom/server');
  const { BacktestTimeline } = loadTsModule('components/charts.tsx');
  const { BacktestPanel } = loadTsModule('components/BacktestPanel.tsx');

  const points = [4, 5, 18, 19, 6].map((pct, idx) => ({
    date: `2026-10-${String(idx + 25).padStart(2, '0')}`,
    spend: 1000,
    atRiskSpend: pct * 10,
    atRiskPct: pct,
  }));
  const html = ReactDOMServer.renderToStaticMarkup(
    React.createElement(BacktestTimeline, {
      points,
      thresholdPct: 15,
      events: [
        { date: '2026-10-27', brokenLinks: 8 },
        { date: '2026-01-01', brokenLinks: 2 },
      ],
      testId: 'tl',
    }),
  );
  assert.equal((html.match(/<rect /g) ?? []).length, 5);
  assert.equal((html.match(/fill="#D97706"/g) ?? []).length, 2);
  assert.equal((html.match(/<polygon /g) ?? []).length, 1);
  assert.equal(html.includes('Oct 27: 8 landing pages broke'), true);
  assert.equal(html.includes('2 of 5 days at or above 15%'), true);
  assert.equal(
    ReactDOMServer.renderToStaticMarkup(
      React.createElement(BacktestTimeline, { points: [], thresholdPct: 15 }),
    ),
    '',
  );

  const panelHtml = ReactDOMServer.renderToStaticMarkup(
    React.createElement(BacktestPanel, {
      workflow: {
        workflowId: 'wf_test',
        title: 'Daily pacing',
        template: 'daily-pacing-guardrail',
        slug: 'daily-pacing-guardrail',
        channels: ['google_ads'],
        threshold: 15,
        steps: [],
        temporalCode: '',
      },
    }),
  );
  assert.equal(panelHtml.includes('workflow-backtest-button'), true);
  assert.equal(panelHtml.includes('Backtest alert history'), true);
  assert.equal(panelHtml.includes('workflow-backtest-panel'), false);
});

test('portfolio plan bars share one scale and a plan is applied through a single mutation append', () => {
  const React = requireFromFrontend('react');
  const ReactDOMServer = requireFromFrontend('react-dom/server');
  const { computeSharedPlanBars, formatCompactCurrency, PortfolioPlans } = loadTsModule(
    'components/PortfolioPlans.tsx',
  );
  const { ReallocationCard } = loadTsModule('components/ReallocationCard.tsx');

  const bars = computeSharedPlanBars([
    { incrementalPipelineP10: 20000, incrementalPipelineP50: 25000, incrementalPipelineP90: 30000 },
    { incrementalPipelineP10: 45000, incrementalPipelineP50: 50000, incrementalPipelineP90: 60000 },
    { incrementalPipelineP10: 90000, incrementalPipelineP50: 95000, incrementalPipelineP90: 100000 },
  ]);
  assert.deepEqual(bars[0], { leftPct: 20, widthPct: 10, medianPct: 25 });
  assert.deepEqual(bars[2], { leftPct: 90, widthPct: 10, medianPct: 95 });
  assert.ok(bars[0].medianPct < bars[1].medianPct && bars[1].medianPct < bars[2].medianPct);
  assert.deepEqual(computeSharedPlanBars([]), []);
  assert.deepEqual(
    computeSharedPlanBars([
      { incrementalPipelineP10: 0, incrementalPipelineP50: 0, incrementalPipelineP90: 0 },
    ]),
    [{ leftPct: 0, widthPct: 1, medianPct: 0 }],
  );

  assert.equal(formatCompactCurrency(53407.8), '$53.4K');
  assert.equal(formatCompactCurrency(104650), '$105K');
  assert.equal(formatCompactCurrency(-1200), '-$1.2K');
  assert.equal(formatCompactCurrency(475), '$475');
  assert.equal(formatCompactCurrency(Number.NaN), '$0');

  const launchHtml = ReactDOMServer.renderToStaticMarkup(
    React.createElement(PortfolioPlans, { disabled: false, onApplyPlan: async () => {} }),
  );
  assert.equal(launchHtml.includes('Compare 3 portfolio plans'), true);
  assert.equal(launchHtml.includes('portfolio-plans-panel'), false);

  const output = {
    proposalId: 'prop_plan_check',
    fromCampaign: 'cmp_social_low',
    toCampaign: 'cmp_search_high',
    amountPerDay: 250,
    before: { fromDailyBudget: 800, toDailyBudget: 500, fromRoas: 1.5, toRoas: 4.5, totalDailyBudget: 2500 },
    after: { fromDailyBudget: 550, toDailyBudget: 750, fromRoas: 1.5, toRoas: 4.5, totalDailyBudget: 2500 },
    blendedRoasBefore: 3.1,
    blendedRoasAfter: 3.4,
  };
  const baseProps = {
    state: 'completed',
    output,
    decision: null,
    disabled: false,
    onApprove: async () => {},
    onDecline: () => {},
    onRetry: () => {},
  };
  const withPlans = ReactDOMServer.renderToStaticMarkup(
    React.createElement(ReallocationCard, { ...baseProps, onApplyPlan: async () => {} }),
  );
  const withoutPlans = ReactDOMServer.renderToStaticMarkup(
    React.createElement(ReallocationCard, baseProps),
  );
  assert.equal(withPlans.includes('portfolio-compare-button'), true);
  assert.equal(withoutPlans.includes('portfolio-compare-button'), false);

  const workspaceSource = fs.readFileSync(
    path.join(frontendRoot, 'components/WorkspaceClient.tsx'),
    'utf8',
  );
  const handlerStart = workspaceSource.indexOf('const handleApplyPortfolioPlan');
  const handlerEnd = workspaceSource.indexOf('const handleDeclineReallocation');
  assert.ok(handlerStart > 0 && handlerEnd > handlerStart);
  const handlerSource = workspaceSource.slice(handlerStart, handlerEnd);
  assert.equal((handlerSource.match(/appendTwinMutations\(/g) ?? []).length, 1);
  assert.equal(handlerSource.includes('appendTwinMutations(plan.mutations)'), true);
  assert.equal(handlerSource.includes('undoSnapshot: prevSnapshot'), true);
});
