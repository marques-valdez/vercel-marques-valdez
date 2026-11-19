import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const frontendRoot = path.resolve(__dirname, '..');
const requireFromFrontend = createRequire(
  path.join(frontendRoot, 'package.json'),
);
const ts = requireFromFrontend('typescript');
const React = requireFromFrontend('react');
const ReactDOMServer = requireFromFrontend('react-dom/server');
const jsxRuntime = requireFromFrontend('react/jsx-runtime');

let capturedElements = [];
let activeStateSlots = null;
let activeEffectCleanups = null;

const instrumentedJsxRuntime = {
  ...jsxRuntime,
  jsx(type, props, key) {
    const el = jsxRuntime.jsx(type, props, key);
    capturedElements.push(el);
    return el;
  },
  jsxs(type, props, key) {
    const el = jsxRuntime.jsxs(type, props, key);
    capturedElements.push(el);
    return el;
  },
};

function createHookAwareReact() {
  return new Proxy(React, {
    get(target, prop, receiver) {
      if (prop === 'useState' && activeStateSlots !== null) {
        const boundSlots = activeStateSlots;
        return (initialValue) => {
          const idx = boundSlots.cursor++;
          if (idx >= boundSlots.values.length) {
            const resolved =
              typeof initialValue === 'function' ? initialValue() : initialValue;
            boundSlots.values.push(resolved);
          }
          const setState = (updater) => {
            const prev = boundSlots.values[idx];
            boundSlots.values[idx] =
              typeof updater === 'function' ? updater(prev) : updater;
          };
          return [boundSlots.values[idx], setState];
        };
      }
      if (prop === 'useRef' && activeStateSlots !== null) {
        const boundSlots = activeStateSlots;
        return (initialValue) => {
          const idx = boundSlots.refCursor++;
          if (idx >= boundSlots.refs.length) {
            boundSlots.refs.push({ current: initialValue });
          }
          return boundSlots.refs[idx];
        };
      }
      if (prop === 'useEffect' && activeEffectCleanups !== null) {
        const boundEffects = activeEffectCleanups;
        return (effectFn) => {
          boundEffects.pending.push(effectFn);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

const hookAwareReact = createHookAwareReact();
const moduleCache = new Map();

function resolveLocalTsPath(baseCandidate) {
  const candidates = [
    baseCandidate,
    `${baseCandidate}.ts`,
    `${baseCandidate}.tsx`,
  ];
  for (const cand of candidates) {
    if (fs.existsSync(cand) && fs.statSync(cand).isFile()) {
      return cand;
    }
  }
  return `${baseCandidate}.ts`;
}

function loadTsModule(relPath, customMocks = null) {
  const fullPath = resolveLocalTsPath(path.resolve(frontendRoot, relPath));
  if (!customMocks && moduleCache.has(fullPath)) {
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
  if (!customMocks) {
    moduleCache.set(fullPath, mod);
  }

  const localRequire = (specifier) => {
    if (customMocks && Object.hasOwn(customMocks, specifier)) {
      return customMocks[specifier];
    }
    if (specifier === 'react') {
      return hookAwareReact;
    }
    if (specifier === 'react/jsx-runtime') {
      return instrumentedJsxRuntime;
    }
    if (specifier === 'next/font/google') {
      return {
        Geist: () => ({ variable: '--font-geist-sans' }),
        Geist_Mono: () => ({ variable: '--font-geist-mono' }),
      };
    }
    if (specifier.endsWith('.css')) {
      return {};
    }
    if (specifier.startsWith('@/')) {
      const target = resolveLocalTsPath(
        path.resolve(frontendRoot, specifier.slice(2)),
      );
      return loadTsModule(path.relative(frontendRoot, target), customMocks);
    }
    if (specifier.startsWith('.')) {
      const target = resolveLocalTsPath(
        path.resolve(path.dirname(fullPath), specifier),
      );
      return loadTsModule(path.relative(frontendRoot, target), customMocks);
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

function mountServerHarness(Component, initialProps) {
  const slots = { values: [], cursor: 0, refs: [], refCursor: 0 };
  const effects = { pending: [], cleanups: [] };
  let currentProps = initialProps;
  let lastHtml = '';

  function renderPass(nextProps = currentProps) {
    currentProps = nextProps;
    slots.cursor = 0;
    slots.refCursor = 0;
    effects.pending = [];
    capturedElements = [];
    activeStateSlots = slots;
    activeEffectCleanups = effects;
    try {
      lastHtml = ReactDOMServer.renderToStaticMarkup(
        React.createElement(Component, currentProps),
      );
    } finally {
      activeStateSlots = null;
      activeEffectCleanups = null;
    }
    for (const fn of effects.pending) {
      const maybeCleanup = fn();
      if (typeof maybeCleanup === 'function') {
        effects.cleanups.push(maybeCleanup);
      }
    }
    effects.pending = [];
    return { html: lastHtml, elements: [...capturedElements] };
  }

  function unmount() {
    while (effects.cleanups.length > 0) {
      const cleanup = effects.cleanups.pop();
      cleanup();
    }
  }

  const first = renderPass(initialProps);
  return {
    ...first,
    rerender: renderPass,
    unmount,
    getHtml: () => lastHtml,
    getElements: () => [...capturedElements],
  };
}

function hasUnpairedSurrogate(str) {
  for (let i = 0; i < str.length; i += 1) {
    const code = str.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = str.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        return true;
      }
      i += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

async function flushAsyncWork(turns = 25) {
  for (let i = 0; i < turns; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

test('adv_composer_utf16_surrogate_and_input_bounds strips lone surrogates at 2000 boundary and guards keyboard submit', () => {
  const composerMod = loadTsModule('components/Composer.tsx');
  const { Composer, sanitizeComposerInput } = composerMod;

  let latestValue = '';
  let submitCount = 0;
  let stopCount = 0;

  const mounted = mountServerHarness(Composer, {
    value: '',
    isStreaming: false,
    onChange: (v) => {
      latestValue = v;
    },
    onSubmit: () => {
      submitCount += 1;
    },
    onStop: () => {
      stopCount += 1;
    },
  });

  const textarea = mounted.elements.find((el) => el.type === 'textarea');
  assert.ok(textarea, 'Expected textarea in Composer');

  textarea.props.onChange({ target: { value: `${'a'.repeat(1999)}🚀` } });
  assert.equal(latestValue.length, 1999);
  assert.equal(hasUnpairedSurrogate(latestValue), false);

  textarea.props.onChange({ target: { value: `${'a'.repeat(1999)}\uD83D` } });
  assert.equal(latestValue.length, 1999);
  assert.equal(hasUnpairedSurrogate(latestValue), false);

  textarea.props.onChange({ target: { value: `${'a'.repeat(1998)}🚀` } });
  assert.equal(latestValue.length, 2000);
  assert.equal(latestValue.endsWith('🚀'), true);
  assert.equal(hasUnpairedSurrogate(latestValue), false);

  assert.equal(typeof sanitizeComposerInput, 'function');
  assert.equal(hasUnpairedSurrogate(sanitizeComposerInput('hello\uD800world')), false);
  assert.equal(hasUnpairedSurrogate(sanitizeComposerInput('\uDE80lead')), false);

  const wsPass = mounted.rerender({
    value: '   \n\t  ',
    isStreaming: false,
    onChange: (v) => {
      latestValue = v;
    },
    onSubmit: () => {
      submitCount += 1;
    },
    onStop: () => {},
  });
  const sendBtnDisabled = wsPass.elements.find(
    (el) => el.type === 'button' && el.props.type === 'submit',
  );
  assert.equal(sendBtnDisabled.props.disabled, true);

  const readyPass = mounted.rerender({
    value: 'Audit broken destination links',
    isStreaming: false,
    onChange: (v) => {
      latestValue = v;
    },
    onSubmit: () => {
      submitCount += 1;
    },
    onStop: () => {},
  });
  const readyTa = readyPass.elements.find((el) => el.type === 'textarea');
  let prevented = false;
  readyTa.props.onKeyDown({
    key: 'Enter',
    shiftKey: true,
    nativeEvent: { isComposing: false },
    preventDefault: () => {
      prevented = true;
    },
  });
  assert.equal(prevented, false);
  assert.equal(submitCount, 0);

  readyTa.props.onKeyDown({
    key: 'Enter',
    shiftKey: false,
    nativeEvent: { isComposing: true },
    preventDefault: () => {
      prevented = true;
    },
  });
  assert.equal(prevented, false);
  assert.equal(submitCount, 0);

  readyTa.props.onKeyDown({
    key: 'Enter',
    shiftKey: false,
    nativeEvent: { isComposing: false },
    preventDefault: () => {
      prevented = true;
    },
  });
  assert.equal(prevented, true);
  assert.equal(submitCount, 1);

  const streamPass = mounted.rerender({
    value: 'Audit broken destination links',
    isStreaming: true,
    onChange: () => {},
    onSubmit: () => {
      submitCount += 1;
    },
    onStop: () => {
      stopCount += 1;
    },
  });
  const stopBtn = streamPass.elements.find(
    (el) => el.type === 'button' && el.props.children === 'Stop',
  );
  assert.ok(stopBtn, 'Expected Stop button while streaming');
  stopBtn.props.onClick();
  assert.equal(stopCount, 1);
  mounted.unmount();
});

test('adv_sandbox_card_format_pct_before_spend_and_edge_cells formats spend_delta_pct as percent and guards non-finite values', () => {
  const sandboxMod = loadTsModule('components/SandboxCard.tsx');
  const { SandboxCard, formatCellValue } = sandboxMod;

  const liveHtml = ReactDOMServer.renderToStaticMarkup(
    React.createElement(SandboxCard, {
      state: 'completed',
      output: {
        templateId: 'daily_pacing_anomalies',
        mode: 'sandbox',
        sandboxMs: 19.6,
        rowsScanned: 2500,
        rowsReturned: 2,
        sql: 'SELECT date, channel, spend_delta_pct, total_spend FROM rows;',
        table: [
          {
            date: '2026-10-01',
            channel: 'LinkedIn Ads',
            spend_delta_pct: -18.42,
            total_spend: 420,
          },
          {
            date: '2026-10-02',
            channel: 'Google Ads',
            spend_delta_pct: 15.25,
            total_spend: 680,
          },
        ],
        estTokensAvoided: 6400,
      },
      onRetry: () => {},
    }),
  );
  assert.equal(liveHtml.includes('2,500 daily records'), true);
  assert.equal(liveHtml.includes('Vercel Sandbox'), false);
  assert.equal(liveHtml.includes('-18.42%'), true);
  assert.equal(liveHtml.includes('$-18.42'), false);
  assert.equal(liveHtml.includes('$680'), true);

  assert.equal(typeof formatCellValue, 'function');
  assert.equal(formatCellValue('spend_delta_pct', -18.42), '-18.42%');
  assert.equal(formatCellValue('spend_delta_pct', 24.35), '24.35%');
  assert.equal(formatCellValue('spend_share_pct', 42.5), '42.50%');
  assert.equal(formatCellValue('wasted_spend_percent', -0), '0.00%');
  assert.equal(formatCellValue('ctr_pct', 3.1), '3.10%');

  assert.equal(formatCellValue('total_spend', 420), '$420');
  assert.equal(formatCellValue('cpc', 4.5), '$4.50');
  assert.equal(formatCellValue('cost_variance', -25.5), '-$25.50');
  assert.equal(formatCellValue('roas', 4.2), '4.20x');
  assert.equal(formatCellValue('roas', -0), '0.00x');
  assert.equal(formatCellValue('total_clicks', 1250), '1,250');
  assert.equal(formatCellValue('roas', Number.NaN), '—');
  assert.equal(formatCellValue('total_spend', Number.POSITIVE_INFINITY), '—');
  assert.equal(formatCellValue('spend_delta_pct', Number.NEGATIVE_INFINITY), '—');
  assert.equal(formatCellValue('cpa', null), '—');

  const skelHtml = ReactDOMServer.renderToStaticMarkup(
    React.createElement(SandboxCard, { state: 'skeleton', onRetry: () => {} }),
  );
  assert.equal(skelHtml.includes('aria-busy="true"'), true);

  let retried = 0;
  const errMount = mountServerHarness(SandboxCard, {
    state: 'error',
    errorText: 'MicroVM timeout',
    onRetry: () => {
      retried += 1;
    },
  });
  assert.equal(errMount.html.includes('MicroVM timeout'), true);
  const retryBtn = errMount.elements.find((el) => el.type === 'button');
  retryBtn.props.onClick();
  assert.equal(retried, 1);
});

test('adv_share_codec_strict_prefilter_validation_and_slug_boundaries rejects invalid inputs in both encode functions', () => {
  const shareMod = loadTsModule('lib/share.ts');

  const invalidPayloads = [
    null,
    undefined,
    'creative-404-guard',
    {
      template: 'creative-404-guard',
      channels: ['google_ads', 'tiktok_ads'],
      threshold: 20,
    },
    {
      template: 'creative-404-guard',
      channels: ['google_ads', 'google_ads'],
      threshold: 20,
    },
    {
      template: 'creative-404-guard',
      channels: [],
      threshold: 20,
    },
    {
      template: 'creative-404-guard',
      channels: ['google_ads', 'linkedin_ads', 'meta_ads', 'google_ads'],
      threshold: 10,
    },
    {
      template: 'creative-404-guard',
      channels: ['google_ads', 'linkedin_ads', 'meta_ads'],
      threshold: 10,
      injected: 'extra-field-on-alias-match',
    },
    {
      template: '__proto__',
      channels: ['google_ads'],
      threshold: 10,
    },
    {
      template: 'constructor',
      channels: ['google_ads'],
      threshold: 10,
    },
    {
      template: 'creative-404-guard',
      channels: ['google_ads'],
      threshold: 0,
    },
    {
      template: 'creative-404-guard',
      channels: ['google_ads'],
      threshold: 101,
    },
    {
      template: 'creative-404-guard',
      channels: ['google_ads'],
      threshold: 12.5,
    },
    {
      template: 'creative-404-guard',
      channels: ['google_ads'],
      threshold: Number.NaN,
    },
    {
      template: 'creative-404-guard',
      channels: ['google_ads'],
      threshold: Number.POSITIVE_INFINITY,
    },
    Object.assign(Object.create({ inherited: 1 }), {
      template: 'creative-404-guard',
      channels: ['google_ads'],
      threshold: 20,
    }),
  ];

  for (const bad of invalidPayloads) {
    assert.throws(
      () => shareMod.encodeCustomPlaybookSlug(bad),
      (err) => err instanceof Error && err.name === 'ZodError',
      `Expected encodeCustomPlaybookSlug to throw ZodError for ${JSON.stringify(bad)}`,
    );
    assert.throws(
      () => shareMod.encodePlaybookSlug(bad),
      (err) => err instanceof Error && err.name === 'ZodError',
      `Expected encodePlaybookSlug to throw ZodError for ${JSON.stringify(bad)}`,
    );
  }

  for (const boundaryThreshold of [1, 100]) {
    const slug = shareMod.encodeCustomPlaybookSlug({
      template: 'paid-social-reallocation',
      channels: ['meta_ads', 'google_ads'],
      threshold: boundaryThreshold,
    });
    const decoded = shareMod.resolvePlaybookSlug(slug);
    assert.ok(decoded);
    assert.equal(decoded.threshold, boundaryThreshold);
    assert.deepEqual(decoded.channels, ['google_ads', 'meta_ads']);
  }

  assert.equal(
    shareMod.encodePlaybookSlug({
      template: 'creative-404-guard',
      channels: ['meta_ads', 'google_ads', 'linkedin_ads'],
      threshold: 10,
    }),
    'creative-404-guard',
  );
  const forcedBase64 = shareMod.encodePlaybookSlug(
    {
      template: 'creative-404-guard',
      channels: ['meta_ads', 'google_ads', 'linkedin_ads'],
      threshold: 10,
    },
    { preferAlias: false },
  );
  assert.notEqual(forcedBase64, 'creative-404-guard');
  assert.equal(shareMod.resolvePlaybookSlug(forcedBase64)?.template, 'creative-404-guard');

  const advSlugs = [
    Buffer.from(
      '{"__proto__":{"x":1},"template":"creative-404-guard","channels":["google_ads"],"threshold":20}',
    ).toString('base64url'),
    Buffer.from(
      '{"template":"creative-404-guard","channels":["google_ads"],"threshold":20,"__proto__":{"x":1}}',
    ).toString('base64url'),
    Buffer.from('["creative-404-guard"]').toString('base64url'),
    Buffer.from('null').toString('base64url'),
    Buffer.from('42').toString('base64url'),
    Buffer.from('"creative-404-guard"').toString('base64url'),
    'a'.repeat(513),
    'AB',
  ];
  for (const s of advSlugs) {
    assert.equal(shareMod.resolvePlaybookSlug(s), null);
  }
});

test('adv_layout_metadata_base_and_next_config_contracts verifies metadataBase resolution and tracing root', async () => {
  const shareMod = loadTsModule('lib/share.ts');
  const layoutMod = loadTsModule('app/layout.tsx');
  assert.ok(layoutMod.metadata.metadataBase instanceof URL);
  assert.equal(typeof shareMod.resolveMetadataBase, 'function');

  assert.equal(
    shareMod.resolveMetadataBase({
      NEXT_PUBLIC_APP_URL: 'https://relay.fieldstone.example',
    }).href,
    'https://relay.fieldstone.example/',
  );
  assert.equal(
    shareMod.resolveMetadataBase({
      VERCEL_PROJECT_PRODUCTION_URL: 'relay-prod.vercel.app',
    }).href,
    'https://relay-prod.vercel.app/',
  );
  assert.equal(
    shareMod.resolveMetadataBase({
      VERCEL_URL: 'relay-preview.vercel.app',
    }).href,
    'https://relay-preview.vercel.app/',
  );
  assert.equal(
    shareMod.resolveMetadataBase({
      NEXT_PUBLIC_APP_URL: ':::not-a-valid-url:::',
      PORT: '4123',
    }).href,
    'http://localhost:4123/',
  );
  assert.equal(shareMod.resolveMetadataBase({}).href, 'http://localhost:3000/');

  const nextConfigUrl = pathToFileURL(
    path.join(frontendRoot, 'next.config.mjs'),
  ).href;
  const { default: nextConfig } = await import(nextConfigUrl);
  assert.equal(typeof nextConfig.outputFileTracingRoot, 'string');
  assert.equal(
    path.resolve(nextConfig.outputFileTracingRoot),
    path.resolve(frontendRoot, '..'),
  );
  assert.deepEqual(nextConfig.outputFileTracingIncludes, {
    '/': ['../backend/app/ui_stream.py'],
  });

  const prevVercel = process.env.VERCEL;
  const prevBackend = process.env.BACKEND_URL;
  try {
    delete process.env.VERCEL;
    process.env.BACKEND_URL = 'http://127.0.0.1:8123///';
    const localRewrites = await nextConfig.rewrites();
    assert.deepEqual(localRewrites, [
      {
        source: '/api/agent/:path*',
        destination: 'http://127.0.0.1:8123/api/agent/:path*',
      },
    ]);

    process.env.VERCEL = '1';
    const vercelRewrites = await nextConfig.rewrites();
    assert.deepEqual(vercelRewrites, []);
  } finally {
    if (prevVercel === undefined) delete process.env.VERCEL;
    else process.env.VERCEL = prevVercel;
    if (prevBackend === undefined) delete process.env.BACKEND_URL;
    else process.env.BACKEND_URL = prevBackend;
  }

  const buildIdPath = path.join(frontendRoot, '.next', 'BUILD_ID');
  if (fs.existsSync(buildIdPath)) {
    const portProbe = http.createServer();
    await new Promise((resolve) => portProbe.listen(0, '127.0.0.1', resolve));
    const livePort = portProbe.address().port;
    await new Promise((resolve) => portProbe.close(resolve));

    const cleanEnv = { ...process.env };
    delete cleanEnv.VERCEL_URL;
    delete cleanEnv.VERCEL_PROJECT_PRODUCTION_URL;
    delete cleanEnv.NEXT_PUBLIC_APP_URL;

    const child = spawn(
      process.execPath,
      [
        path.join(frontendRoot, 'lib', 'start-server.mjs'),
        '-p',
        String(livePort),
        '-H',
        '127.0.0.1',
      ],
      { stdio: ['ignore', 'pipe', 'pipe'], env: cleanEnv },
    );

    let stderrLog = '';
    child.stderr.on('data', (chunk) => {
      stderrLog += chunk.toString('utf8');
    });

    try {
      await new Promise((resolve, reject) => {
        const onExit = (code) =>
          reject(new Error(`start-server exited early (${code}): ${stderrLog}`));
        child.once('exit', onExit);
        child.stdout.on('data', (chunk) => {
          if (chunk.toString('utf8').includes('Ready on')) {
            child.removeListener('exit', onExit);
            resolve();
          }
        });
      });

      const sharePageRes = await fetch(
        `http://127.0.0.1:${livePort}/p/creative-404-guard`,
      );
      assert.equal(sharePageRes.status, 200);
      const html = await sharePageRes.text();
      assert.equal(html.includes('/api/og?slug=creative-404-guard'), true);
      assert.equal(stderrLog.trim(), '');
    } finally {
      child.kill('SIGTERM');
      await new Promise((resolve) => child.once('exit', resolve));
    }
  }
});

test('adv_twin_client_storage_resilience_cap_dedupe_and_error_shapes covers SSR, storage failures, 50-cap, and HTTP error shapes', async () => {
  const twinMod = loadTsModule('lib/twin-client.ts');
  const originalWindow = globalThis.window;
  const originalFetch = globalThis.fetch;

  try {
    delete globalThis.window;
    assert.deepEqual(twinMod.readStoredMutations(), []);
    assert.doesNotThrow(() =>
      twinMod.writeStoredMutations([{ type: 'pause_broken_creatives' }]),
    );
    assert.doesNotThrow(() => twinMod.clearStoredMutations());

    globalThis.window = {
      localStorage: {
        getItem: () => {
          throw new Error('SecurityError');
        },
        setItem: () => {
          throw new Error('QuotaExceededError');
        },
        removeItem: () => {
          throw new Error('SecurityError');
        },
      },
    };
    assert.deepEqual(twinMod.readStoredMutations(), []);
    assert.doesNotThrow(() =>
      twinMod.writeStoredMutations([{ type: 'fix_utm_taxonomy' }]),
    );
    assert.doesNotThrow(() => twinMod.clearStoredMutations());

    const store = new Map();
    globalThis.window = {
      localStorage: {
        getItem: (k) => (store.has(k) ? store.get(k) : null),
        setItem: (k, v) => store.set(k, String(v)),
        removeItem: (k) => store.delete(k),
      },
    };

    for (const badRaw of [
      '{corrupt',
      '{}',
      'null',
      '"text"',
      '42',
      'true',
      JSON.stringify([{ type: 'pause_broken_creatives' }, { type: 'unknown_op' }]),
    ]) {
      store.set(twinMod.TWIN_STORAGE_KEY, badRaw);
      assert.deepEqual(twinMod.readStoredMutations(), []);
    }

    const fiftyValid = Array.from({ length: 50 }, (_, idx) => ({
      type: 'reallocate_budget',
      from_campaign: 'cmp_social_a',
      to_campaign: 'cmp_search_b',
      amount_per_day: idx + 1,
    }));
    store.set(twinMod.TWIN_STORAGE_KEY, JSON.stringify(fiftyValid));
    assert.equal(twinMod.readStoredMutations().length, 50);

    const fiftyOneValid = [
      ...fiftyValid,
      { type: 'pause_broken_creatives' },
    ];
    store.set(twinMod.TWIN_STORAGE_KEY, JSON.stringify(fiftyOneValid));
    assert.deepEqual(twinMod.readStoredMutations(), []);

    store.clear();
    let fetchCount = 0;
    const syntheticState = {
      totals: {
        campaignCount: 2,
        adGroupCount: 8,
        rowCount: 800,
        dailyBudget: 950,
        monthlyBudget: 28500,
        brokenCreatives: 0,
        utmViolations: 0,
        spendAtRiskPerDay: 0,
        blendedRoas: 3.8,
        appliedMutations: 2,
      },
      channels: [],
      campaigns: [],
      hygieneIssues: [],
    };
    globalThis.fetch = async () => {
      fetchCount += 1;
      return new Response(JSON.stringify(syntheticState), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    const deduped = await twinMod.appendTwinMutations([
      { type: 'pause_broken_creatives' },
      { type: 'pause_broken_creatives' },
      { type: 'fix_utm_taxonomy' },
    ]);
    assert.equal(deduped.mutations.length, 2);

    const dedupedAgain = await twinMod.appendTwinMutations([
      { type: 'fix_utm_taxonomy' },
    ]);
    assert.equal(dedupedAgain.mutations.length, 2);

    const fortyEightShifts = Array.from({ length: 48 }, () => ({
      type: 'reallocate_budget',
      from_campaign: 'cmp_social_a',
      to_campaign: 'cmp_search_b',
      amount_per_day: 5,
    }));
    const atCap = await twinMod.appendTwinMutations(fortyEightShifts);
    assert.equal(atCap.mutations.length, 50);

    const callsBeforeCapReject = fetchCount;
    await assert.rejects(
      () =>
        twinMod.appendTwinMutations([
          {
            type: 'reallocate_budget',
            from_campaign: 'cmp_social_a',
            to_campaign: 'cmp_search_b',
            amount_per_day: 5,
          },
        ]),
      (err) =>
        err instanceof twinMod.TwinStateError &&
        err.status === 422 &&
        err.message.includes('50'),
    );
    assert.equal(fetchCount, callsBeforeCapReject);

    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({ detail: [{ msg: 'Amount exceeds campaign budget' }] }),
        { status: 422, headers: { 'Content-Type': 'application/json' } },
      );
    await assert.rejects(
      () => twinMod.fetchTwinState([]),
      (err) =>
        err instanceof twinMod.TwinStateError &&
        err.status === 422 &&
        err.message === 'Amount exceeds campaign budget',
    );

    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({ error: 'Upstream Python agent service is unreachable.' }),
        { status: 502, headers: { 'Content-Type': 'application/json' } },
      );
    await assert.rejects(
      () => twinMod.fetchTwinState([]),
      (err) =>
        err instanceof twinMod.TwinStateError &&
        err.status === 502 &&
        err.message === 'Upstream Python agent service is unreachable.',
    );

    globalThis.fetch = async () =>
      new Response('Gateway Timeout', {
        status: 504,
        headers: { 'Content-Type': 'text/plain' },
      });
    await assert.rejects(
      () => twinMod.fetchTwinState([]),
      (err) =>
        err instanceof twinMod.TwinStateError &&
        err.status === 504 &&
        err.message === 'Twin state request failed (504)',
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
  }
});

test('adv_workflow_card_sse_chunking_failed_step_abort_and_dup_channels verifies split SSE frames, failed step badge, unmount abort, and duplicate channel safety', async () => {
  const { WorkflowCard } = loadTsModule('components/WorkflowCard.tsx');
  const { WORKFLOW_NODE_NAMES } = loadTsModule('lib/playbooks.ts');
  const originalFetch = globalThis.fetch;

  const workflowOutputWithDupChannels = {
    workflowId: 'wf_guard_adv',
    title: 'Compile a daily pacing guardrail',
    template: 'daily-pacing-guardrail',
    slug: '',
    channels: ['linkedin_ads', 'google_ads', 'google_ads'],
    threshold: 25,
    schedule: '0 7 * * *',
    steps: WORKFLOW_NODE_NAMES.map((node, idx) => ({
      index: idx + 1,
      node,
      description: `Step ${idx + 1} spec`,
    })),
    temporalCode: '@workflow.defn\nclass Guardrail:\n    pass\n',
  };

  try {
    let sharedSlug = null;
    const mounted = mountServerHarness(WorkflowCard, {
      state: 'completed',
      output: workflowOutputWithDupChannels,
      onShare: (s) => {
        sharedSlug = s;
      },
      onRetry: () => {},
    });
    const shareBtn = mounted.elements.find(
      (el) => el.props?.['data-testid'] === 'workflow-share-button',
    );
    shareBtn.props.onClick();
    assert.equal(typeof sharedSlug, 'string');
    assert.ok(sharedSlug.length > 0);

    const rawSse =
      [
        `data: ${JSON.stringify({ stepIndex: 0, node: 'Fetch channels', status: 'completed', ms: 4.2, mode: 'twin', detail: 'Loaded channels → ok' })}`,
        `data: ${JSON.stringify({ stepIndex: 1, node: 'Check creative URL status', status: 'completed', ms: 5.1, mode: 'twin', detail: 'Checked URLs' })}`,
        `data: ${JSON.stringify({ stepIndex: 2, node: 'Validate UTM schema', status: 'completed', ms: 3.4, mode: 'twin', detail: 'Checked UTMs' })}`,
        `data: ${JSON.stringify({ stepIndex: 3, node: 'Aggregate rows in Sandbox', status: 'failed', ms: 16.4, mode: 'in-process', detail: 'SQLite constraint error' })}`,
        `data: ${JSON.stringify({ stepIndex: 4, node: 'Threshold gate', status: 'completed', ms: 2.0, mode: 'twin', detail: 'Gate evaluated' })}`,
        `data: ${JSON.stringify({ stepIndex: 5, node: 'Digest', status: 'completed', ms: 1.8, mode: 'twin', detail: 'Operator digest body' })}`,
        'data: [DONE]',
      ].join('\r\n\r\n') + '\r\n\r\n';

    const encodedBytes = new TextEncoder().encode(rawSse);
    const smallChunks = [];
    for (let i = 0; i < encodedBytes.length; i += 7) {
      smallChunks.push(encodedBytes.slice(i, i + 7));
    }

    globalThis.fetch = async () =>
      new Response(
        new ReadableStream({
          start(ctrl) {
            for (const c of smallChunks) {
              ctrl.enqueue(c);
            }
            ctrl.close();
          },
        }),
        { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
      );

    const runBtn = mounted.elements.find(
      (el) => el.props?.['data-testid'] === 'workflow-test-run-button',
    );
    runBtn.props.onClick();
    await flushAsyncWork(40);

    const afterRun = mounted.rerender();
    assert.equal(afterRun.html.includes('Operator digest body'), true);
    assert.equal(afterRun.html.includes('workflow-step-failed'), true);
    assert.equal(afterRun.html.includes('Needs review'), true);

    globalThis.fetch = async () =>
      new Response(
        new ReadableStream({
          start(ctrl) {
            ctrl.enqueue(
              new TextEncoder().encode(
                'data: {"stepIndex":0,"node":"Fetch channels","status":"completed","ms":3,"detail":"ok"}\n\n',
              ),
            );
            ctrl.close();
          },
        }),
        { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
      );
    const runBtn2 = afterRun.elements.find(
      (el) => el.props?.['data-testid'] === 'workflow-test-run-button',
    );
    runBtn2.props.onClick();
    await flushAsyncWork(25);
    const afterPremature = mounted.rerender();
    assert.equal(afterPremature.html.includes('before [DONE]'), true);

    let capturedSignal = null;
    let resolvePendingRead = null;
    globalThis.fetch = async (_url, init) => {
      capturedSignal = init?.signal ?? null;
      return new Response(
        new ReadableStream({
          pull() {
            return new Promise((resolve) => {
              resolvePendingRead = resolve;
            });
          },
        }),
        { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
      );
    };

    const runBtn3 = afterPremature.elements.find(
      (el) => el.props?.['data-testid'] === 'workflow-test-run-button',
    );
    runBtn3.props.onClick();
    await flushAsyncWork(10);
    assert.ok(capturedSignal, 'Expected AbortSignal passed to fetch in WorkflowCard');
    assert.equal(capturedSignal.aborted, false);
    mounted.unmount();
    assert.equal(capturedSignal.aborted, true);
    if (resolvePendingRead) resolvePendingRead();
    await flushAsyncWork(10);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('adv_tool_cards_telemetry_header_channel_strip_share_modal_and_inspector_ledger covers remaining UI branches and ledger math', async () => {
  const { HygieneCard } = loadTsModule('components/HygieneCard.tsx');
  const { ReallocationCard } = loadTsModule('components/ReallocationCard.tsx');
  const { TelemetryStrip } = loadTsModule('components/TelemetryStrip.tsx');
  const { HeaderBar } = loadTsModule('components/HeaderBar.tsx');
  const { ChannelHealthStrip } = loadTsModule('components/ChannelHealthStrip.tsx');
  const { ShareModal } = loadTsModule('components/ShareModal.tsx');
  const inspectorMod = loadTsModule('components/InspectorDrawer.tsx');
  const {
    InspectorDrawer,
    computeToolLedger,
    computeSessionSavings,
    distributeInteger,
  } = inspectorMod;

  const twinZeroIssues = {
    totals: {
      campaignCount: 2,
      adGroupCount: 8,
      rowCount: 800,
      dailyBudget: 950,
      monthlyBudget: 28500,
      brokenCreatives: 0,
      utmViolations: 0,
      spendAtRiskPerDay: 0,
      blendedRoas: 3.9,
      appliedMutations: 2,
    },
    channels: [
      {
        channel: 'Google Ads',
        channelId: 'google_ads',
        campaignCount: 2,
        adGroupCount: 8,
        dailyBudget: 950,
        brokenCreatives: 0,
        utmViolations: 0,
        spendAtRiskPerDay: 0,
        totalSpend: 9500,
        totalPipelineValue: 37050,
        roas: 3.9,
      },
    ],
    campaigns: [],
    hygieneIssues: [],
  };

  const remediatedHtml = ReactDOMServer.renderToStaticMarkup(
    React.createElement(HygieneCard, {
      state: 'completed',
      output: {
        brokenCount: 6,
        utmCount: 4,
        totalSpendAtRiskPerDay: 120,
        flaggedItems: [],
      },
      twinState: twinZeroIssues,
      onApplyFix: async () => {},
      onRetry: () => {},
    }),
  );
  assert.equal(remediatedHtml.includes('>Fixes applied<'), true);
  assert.equal(
    remediatedHtml.includes('All active landing pages and UTM tracking tags look healthy.'),
    true,
  );

  const hygMount = mountServerHarness(HygieneCard, {
    state: 'completed',
    output: {
      brokenCount: 6,
      utmCount: 4,
      totalSpendAtRiskPerDay: 120,
      flaggedItems: [],
    },
    twinState: null,
    onApplyFix: async () => {
      throw new Error('Mutation log cap (50) reached.');
    },
    onRetry: () => {},
  });
  const fixBtn = hygMount.elements.find(
    (el) => el.props?.['data-testid'] === 'hygiene-fix-button',
  );
  fixBtn.props.onClick();
  await flushAsyncWork(10);
  const hygAfterErr = hygMount.rerender();
  assert.equal(hygAfterErr.html.includes('Mutation log cap (50) reached.'), true);
  assert.equal(hygAfterErr.html.includes('>Fixes applied<'), false);

  const reallocMount = mountServerHarness(ReallocationCard, {
    state: 'completed',
    output: {
      proposalId: 'prop_overdraft',
      fromCampaign: 'cmp_a',
      toCampaign: 'cmp_b',
      amountPerDay: 700,
      before: {
        fromDailyBudget: 500,
        toDailyBudget: 450,
        fromRoas: 1.4,
        toRoas: 4.6,
        totalDailyBudget: 950,
      },
      after: {
        fromDailyBudget: 0,
        toDailyBudget: 950,
        fromRoas: 1.4,
        toRoas: 4.6,
        totalDailyBudget: 950,
      },
      blendedRoasBefore: 2.9,
      blendedRoasAfter: 4.6,
    },
    decision: null,
    disabled: false,
    onApprove: async () => {
      throw new Error('Insufficient source campaign daily budget');
    },
    onDecline: () => {},
    onRetry: () => {},
  });
  const approveBtn = reallocMount.elements.find(
    (el) => el.props?.['data-testid'] === 'reallocation-approve-button',
  );
  approveBtn.props.onClick();
  await flushAsyncWork(10);
  const reallocAfterErr = reallocMount.rerender();
  assert.equal(
    reallocAfterErr.html.includes('Insufficient source campaign daily budget'),
    true,
  );
  assert.equal(
    reallocAfterErr.html.includes('reallocation-approve-button'),
    true,
  );

  assert.equal(
    ReactDOMServer.renderToStaticMarkup(
      React.createElement(TelemetryStrip, { entries: [] }),
    ),
    '',
  );
  const noneTelemetryHtml = ReactDOMServer.renderToStaticMarkup(
    React.createElement(TelemetryStrip, {
      entries: [
        {
          tier: 'fast',
          routedBy: 'keyword',
          primaryModel: 'google/gemini-3.1-flash-lite',
          servedModel: 'google/gemini-3.1-flash-lite',
          failover: 'none',
          inputTokens: 400,
          cachedTokens: 0,
          outputTokens: 80,
          costUsd: 0.0002,
          baselineCostUsd: 0.0016,
          latencyMs: 210,
        },
      ],
    }),
  );
  assert.equal(noneTelemetryHtml.includes('400 in (0 cached)'), true);
  assert.equal(noneTelemetryHtml.includes('telemetry-failover-badge'), false);

  const gatewayTelemetryHtml = ReactDOMServer.renderToStaticMarkup(
    React.createElement(TelemetryStrip, {
      entries: [
        {
          tier: 'fast',
          routedBy: 'card',
          primaryModel: 'google/gemini-3.1-flash-lite',
          servedModel: 'anthropic/claude-haiku-5.5',
          failover: 'gateway',
          inputTokens: 400,
          cachedTokens: 120,
          outputTokens: 80,
          costUsd: 0.0005,
          baselineCostUsd: 0.0016,
          latencyMs: 310,
        },
      ],
    }),
  );
  assert.equal(
    gatewayTelemetryHtml.includes('Gateway failover → anthropic/claude-haiku-5.5'),
    true,
  );

  const multiStepSimHtml = ReactDOMServer.renderToStaticMarkup(
    React.createElement(TelemetryStrip, {
      entries: [
        {
          tier: 'reasoning',
          routedBy: 'card',
          primaryModel: 'anthropic/claude-sonnet-5.5',
          servedModel: 'google/gemini-3.1-pro-preview',
          failover: 'simulated',
          inputTokens: 500,
          cachedTokens: 100,
          outputTokens: 90,
          costUsd: 0.0018,
          baselineCostUsd: 0.0019,
          latencyMs: 410,
        },
        {
          tier: 'reasoning',
          routedBy: 'card',
          primaryModel: 'anthropic/claude-sonnet-5.5',
          servedModel: 'anthropic/claude-sonnet-5.5',
          failover: 'none',
          inputTokens: 300,
          cachedTokens: 0,
          outputTokens: 60,
          costUsd: 0.0012,
          baselineCostUsd: 0.0012,
          latencyMs: 290,
        },
      ],
    }),
  );
  assert.equal(
    multiStepSimHtml.includes(
      'Simulated outage · app-level retry → google/gemini-3.1-pro-preview',
    ),
    true,
  );
  assert.equal(multiStepSimHtml.includes('800 in (100 cached)'), true);

  const coldHeaderHtml = ReactDOMServer.renderToStaticMarkup(
    React.createElement(HeaderBar, {
      twinState: null,
      onOpenShare: () => {},
    }),
  );
  assert.equal(coldHeaderHtml.includes('Loading campaigns…'), true);
  assert.equal(coldHeaderHtml.includes('Workflows'), true);

  const populatedHeaderHtml = ReactDOMServer.renderToStaticMarkup(
    React.createElement(HeaderBar, {
      twinState: twinZeroIssues,
      workflowCount: 1,
      onOpenShare: () => {},
      onResetWorkspace: () => {},
    }),
  );
  assert.equal(
    populatedHeaderHtml.includes('2 active campaigns · $950/day'),
    true,
  );
  assert.equal(populatedHeaderHtml.includes('Reset changes'), true);
  assert.equal(populatedHeaderHtml.includes('Workflows (1)'), true);

  const stripErrHtml = ReactDOMServer.renderToStaticMarkup(
    React.createElement(ChannelHealthStrip, {
      twinState: null,
      errorText: 'Backend twin service offline',
      onRetry: () => {},
      onReset: () => {},
    }),
  );
  assert.equal(stripErrHtml.includes('Backend twin service offline'), true);

  const origWin = globalThis.window;
  const origNav = globalThis.navigator;
  const origDoc = globalThis.document;
  try {
    let appendedNodes = 0;
    let removedNodes = 0;
    globalThis.window = {
      location: { origin: 'http://localhost:3000' },
      addEventListener: () => {},
      removeEventListener: () => {},
    };
    Object.defineProperty(globalThis, 'navigator', {
      value: {
        clipboard: {
          writeText: async () => {
            throw new Error('Clipboard permission denied');
          },
        },
      },
      configurable: true,
    });
    globalThis.document = {
      createElement: () => ({
        value: '',
        style: {},
        select: () => {},
        remove: () => {
          removedNodes += 1;
        },
      }),
      body: {
        appendChild: () => {
          appendedNodes += 1;
        },
        removeChild: () => {
          removedNodes += 1;
        },
      },
      execCommand: () => {
        throw new Error('execCommand blocked');
      },
    };

    const modalMount = mountServerHarness(ShareModal, {
      isOpen: true,
      initialSlug: '%%%bad-slug%%%',
      onClose: () => {},
    });
    assert.equal(modalMount.html.includes('/p/creative-404-guard'), true);

    const numInput = modalMount.elements.find(
      (el) => el.type === 'input' && el.props.id === 'share-threshold-input',
    );
    numInput.props.onChange({ target: { value: '0' } });
    const afterZero = modalMount.rerender();
    const updatedNumInput = afterZero.elements.find(
      (el) => el.type === 'input' && el.props.id === 'share-threshold-input',
    );
    assert.equal(updatedNumInput.props.value, 1);

    const copyBtn = afterZero.elements.find(
      (el) => el.props?.['data-testid'] === 'share-copy-button',
    );
    copyBtn.props.onClick();
    await flushAsyncWork(10);
    assert.equal(appendedNodes, 1);
    assert.equal(removedNodes >= 1, true);
    modalMount.unmount();

    assert.equal(typeof distributeInteger, 'function');
    assert.equal(typeof computeToolLedger, 'function');
    assert.equal(typeof computeSessionSavings, 'function');

    assert.equal(
      distributeInteger(101, 3, 0) +
        distributeInteger(101, 3, 1) +
        distributeInteger(101, 3, 2),
      101,
    );

    const ledgerMessages = [
      {
        id: 'a1',
        role: 'assistant',
        parts: [
          {
            type: 'tool-audit_campaign_hygiene',
            toolCallId: 'c1',
            state: 'output-available',
            input: {},
            output: { brokenCount: 0, utmCount: 0, totalSpendAtRiskPerDay: 0 },
          },
          {
            type: 'dynamic-tool',
            toolName: 'analyze_in_sandbox',
            toolCallId: 'c2',
            state: 'output-available',
            input: {},
            output: {},
          },
          {
            type: 'data-telemetry',
            data: {
              tier: 'fast',
              routedBy: 'card',
              primaryModel: 'google/gemini-3.1-flash-lite',
              servedModel: 'google/gemini-3.1-flash-lite',
              failover: 'none',
              inputTokens: 501,
              cachedTokens: 101,
              outputTokens: 99,
              costUsd: 0.0006,
              baselineCostUsd: 0.003,
              latencyMs: 250,
            },
          },
        ],
      },
      {
        id: 'a2',
        role: 'assistant',
        parts: [
          { type: 'text', text: 'Direct answer' },
          {
            type: 'data-telemetry',
            data: {
              tier: 'fast',
              routedBy: 'keyword',
              primaryModel: 'google/gemini-3.1-flash-lite',
              servedModel: 'google/gemini-3.1-flash-lite',
              failover: 'none',
              inputTokens: 200,
              cachedTokens: 0,
              outputTokens: 40,
              costUsd: 0.0002,
              baselineCostUsd: 0.001,
              latencyMs: 180,
            },
          },
        ],
      },
    ];

    const rows = computeToolLedger(ledgerMessages);
    assert.equal(rows.length, 5);
    assert.equal(
      rows.reduce((s, r) => s + r.inputTokens, 0),
      701,
    );
    assert.equal(
      rows.reduce((s, r) => s + r.cachedTokens, 0),
      101,
    );
    assert.equal(
      rows.reduce((s, r) => s + r.outputTokens, 0),
      139,
    );
    assert.ok(
      Math.abs(rows.reduce((s, r) => s + r.costUsd, 0) - 0.0008) < 1e-9,
    );

    const savings = computeSessionSavings([
      ledgerMessages[0].parts[2].data,
      ledgerMessages[1].parts[1].data,
    ]);
    assert.ok(Math.abs(savings.actualUsd - 0.0008) < 1e-9);
    assert.ok(Math.abs(savings.baselineUsd - 0.004) < 1e-9);
    assert.ok(Math.abs(savings.savedUsd - 0.0032) < 1e-9);
    assert.equal(savings.savingsPercent, 80);

    const inspMount = mountServerHarness(InspectorDrawer, {
      isOpen: true,
      injectFailure: false,
      telemetryEntries: [ledgerMessages[0].parts[2].data],
      messages: ledgerMessages,
      uiStreamSource: 'def stream_agent_turn():\n    pass\n',
      health: null,
      healthLoading: false,
      onClose: () => {},
      onToggleInjectFailure: () => {},
      onRefreshHealth: () => {},
      onResetDemo: async () => {},
    });
    assert.equal(inspMount.html.includes('unavailable'), true);
    const deployTab = inspMount.elements.find(
      (el) => el.props?.role === 'tab' && el.props.children === 'Deployment',
    );
    deployTab.props.onClick();
    const deployOnly = inspMount.rerender();
    assert.equal(deployOnly.html.includes('Rolling Releases'), true);
    assert.equal(deployOnly.html.includes('1. Real vs. Stand-in'), false);
    inspMount.unmount();
  } finally {
    Object.defineProperty(globalThis, 'navigator', {
      value: origNav,
      configurable: true,
    });
    if (origDoc === undefined) delete globalThis.document;
    else globalThis.document = origDoc;
    if (origWin === undefined) delete globalThis.window;
    else globalThis.window = origWin;
  }
});

test('adv_routes_og_share_page_workspace_page_and_playbook_grid covers App Router pages, /api/og, and PlaybookGrid', async () => {
  const { PlaybookGrid } = loadTsModule('components/PlaybookGrid.tsx');
  let selectedId = null;
  const gridMount = mountServerHarness(PlaybookGrid, {
    highlightedPlaybookId: 'paid-social-reallocation',
    disabled: false,
    onSelectPlaybook: (pb) => {
      selectedId = pb.id;
    },
  });
  assert.equal(gridMount.html.includes('Prefilled below'), true);
  assert.equal(gridMount.html.includes('data-highlighted="true"'), true);
  const firstActionBtn = gridMount.elements.find(
    (el) => el.type === 'button' && el.props.className === 'btn btn-card-action',
  );
  firstActionBtn.props.onClick();
  assert.equal(selectedId, 'creative-404-guard');

  let notFoundCalled = 0;
  const sharePageMod = loadTsModule('app/p/[slug]/page.tsx', {
    'next/navigation': {
      __esModule: true,
      notFound: () => {
        notFoundCalled += 1;
        throw new Error('NEXT_NOT_FOUND');
      },
    },
    'next/link': {
      __esModule: true,
      default: ({ href, className, children, ...rest }) =>
        React.createElement('a', { href, className, ...rest }, children),
    },
  });

  const validMeta = await sharePageMod.generateMetadata({
    params: Promise.resolve({ slug: 'creative-404-guard' }),
  });
  assert.ok(String(validMeta.title).includes('Audit broken ad links & UTM tags'));
  assert.equal(
    validMeta.openGraph.images[0].url,
    '/api/og?slug=creative-404-guard',
  );

  const missingMeta = await sharePageMod.generateMetadata({
    params: Promise.resolve({ slug: 'invalid-slug' }),
  });
  assert.ok(String(missingMeta.title).includes('Playbook Not Found'));

  await assert.rejects(
    () =>
      sharePageMod.default({
        params: Promise.resolve({ slug: 'invalid-slug' }),
      }),
    /NEXT_NOT_FOUND/,
  );
  assert.equal(notFoundCalled, 1);

  const validPageEl = await sharePageMod.default({
    params: Promise.resolve({ slug: 'daily-pacing-guardrail' }),
  });
  const validPageHtml = ReactDOMServer.renderToStaticMarkup(validPageEl);
  assert.equal(validPageHtml.includes('/?remix=daily-pacing-guardrail'), true);
  assert.equal(validPageHtml.includes('Open in Relay Studio'), true);

  const workspacePageMod = loadTsModule('app/page.tsx', {
    '@/components/WorkspaceClient': {
      __esModule: true,
      WorkspaceClient: (props) =>
        React.createElement('div', { 'data-testid': 'ws-stub', ...props }),
    },
  });

  const wsArrayEl = await workspacePageMod.default({
    searchParams: Promise.resolve({
      remix: ['paid-social-reallocation', 'creative-404-guard'],
    }),
  });
  assert.equal(wsArrayEl.props.initialRemix?.template, 'paid-social-reallocation');
  assert.ok(wsArrayEl.props.uiStreamSource.length > 0);

  const wsInvalidEl = await workspacePageMod.default({
    searchParams: Promise.resolve({ remix: 'bad-slug' }),
  });
  assert.equal(wsInvalidEl.props.initialRemix, null);

  class FakeImageResponse extends Response {
    constructor(_element, opts) {
      super('PNG_STUB', {
        status: 200,
        headers: {
          'content-type': 'image/png',
          'x-og-dims': `${opts.width}x${opts.height}`,
        },
      });
    }
  }
  const ogRouteMod = loadTsModule('app/api/og/route.tsx', {
    'next/og': { __esModule: true, ImageResponse: FakeImageResponse },
  });

  for (const badUrl of [
    'http://localhost:3000/api/og',
    'http://localhost:3000/api/og?slug=',
    'http://localhost:3000/api/og?slug=creative-404-guard&slug=cross-channel-roas',
    'http://localhost:3000/api/og?slug=tampered',
  ]) {
    const res = await ogRouteMod.GET({ nextUrl: new URL(badUrl) });
    assert.equal(res.status, 404);
  }

  const okOg = await ogRouteMod.GET({
    nextUrl: new URL('http://localhost:3000/api/og?slug=creative-404-guard'),
  });
  assert.equal(okOg.status, 200);
  assert.equal(okOg.headers.get('x-og-dims'), '1200x630');
});
