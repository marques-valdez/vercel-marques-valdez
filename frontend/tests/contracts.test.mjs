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
