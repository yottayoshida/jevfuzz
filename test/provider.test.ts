import assert from 'node:assert/strict';
import test from 'node:test';

import { CloudflareProvider, FakeProvider, TypeSafeProvider, realSleep, validateResponse } from '../src/provider.ts';
import { FuzzError } from '../src/util.ts';

test('live rounded probabilities retain raw values within their quantization bound', () => {
  const r: JevRequest = { state: 'public fixture', model: 'jev-latest', questions: { q: { type: 'choice', instructions: 'choose', criteria: { a: 'a', b: 'b', c: 'c', d: 'd', e: 'e' } } } };
  const raw = { model: 'jev-1.13.0', usage: { input_tokens: 1, output_tokens: 1 }, answers: { q: { type: 'choice', choice: 'b', confidence: .61, probabilities: { a: .01, b: .68, c: .02, d: .14, e: .14 } } } };
  assert.deepEqual(validateResponse(raw, r).answers.q, raw.answers.q);
  assert.throws(() => validateResponse({ ...raw, answers: { q: { ...raw.answers.q, probabilities: { a: .01, b: .5, c: .02, d: .14, e: .14 } } } }, r));
});
import type { JevRequest, JevResponse } from '../src/types.ts';

const request: JevRequest = {
  state: { ticket: 'A-1' },
  model: 'jev-latest',
  questions: {
    choice: { type: 'choice', instructions: 'pick', criteria: { yes: 'yes', no: 'no' } },
    noul: { type: 'noul', instructions: 'true?' },
    score: { type: 'score', instructions: 'rate', criteria: ['bad', 'good'] },
  },
};

const response: JevResponse = {
  model: 'jev-1.13.0',
  answers: {
    choice: { type: 'choice', choice: 'yes', probabilities: { yes: 0.8, no: 0.2 }, confidence: 0.8 },
    noul: { type: 'noul', noul: 0.5 },
    score: { type: 'score', score: 1, probabilities: { '0': 0.25, '1': 0.75 }, confidence: 0.75, legend: { '0': 'bad', '1': 'good' } },
  },
  usage: { input_tokens: 12, output_tokens: 7 },
};

function json(body: unknown, status = 200, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

test('validateResponse accepts complete typed answers and rejects malformed distributions', () => {
  assert.deepEqual(validateResponse(response, request), response);
  const malformed = structuredClone(response) as JevResponse;
  const choice = malformed.answers.choice;
  assert.ok(choice && choice.type === 'choice');
  choice.probabilities = { yes: 1.1, no: -0.1 };
  assert.throws(() => validateResponse(malformed, request), { message: /invalid provider response/i });
  const missingModel = structuredClone(response) as unknown as Record<string, unknown>;
  delete missingModel.model;
  assert.throws(() => validateResponse(missingModel, request), { message: /actual model version/i });
});
test('providers reject non-JSON requests before fetch or handler dispatch', async () => {
  let calls = 0;
  const bad = { ...request, state: new Map([['secret', 'value']]) } as unknown as JevRequest;
  const live = new TypeSafeProvider({ TYPESAFE_API_KEY: 'private-key' }, { fetch: async () => { calls++; return json(response); } });
  const cloudflare = new CloudflareProvider({ CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32), CLOUDFLARE_API_TOKEN: 'private-key' }, { fetch: async () => { calls++; return json(response); } });
  const fake = new FakeProvider(() => { calls++; return response; });
  for (const provider of [live, cloudflare, fake]) await assert.rejects(provider.evaluate(bad), /request|JSON|invalid/i);
  await assert.rejects(live.evaluate(request, { payload: JSON.stringify(bad) }), /invalid provider request/i);
  assert.equal(calls, 0);
  assert.throws(() => validateResponse({ ...response, answers: { ...response.answers, score: { ...response.answers.score, legend: new Map() } } }, request), /invalid provider response/i);
  assert.throws(() => validateResponse({ model: 'm', answers: {}, usage: { input_tokens: 0, output_tokens: 0 } }, { ...request, questions: new Map() } as unknown as JevRequest), /invalid provider request/i);
  let getterCalls = 0;
  const getter = Object.defineProperty({ ...response }, 'model', { enumerable: true, get() { getterCalls++; return 'm'; } });
  assert.throws(() => validateResponse(getter, request));
  assert.equal(getterCalls, 0);
});

test('TypeSafeProvider retries 429 and 529, serializes the request once, and preserves payload identity', async () => {
  const calls: RequestInit[] = [];
  const waits: number[] = [];
  const provider = new TypeSafeProvider({ TYPESAFE_API_KEY: 'private-key' }, {
    fetch: async (_url, init) => {
      calls.push(init!);
      return calls.length === 1 ? json({}, 429, { 'retry-after': '0' })
        : calls.length === 2 ? json({}, 529) : json(response);
    },
    sleep: async (ms) => { waits.push(ms); },
    jitterSeed: 4,
  });
  assert.deepEqual(await provider.evaluate(request), response);
  assert.equal(provider.httpAttempts, 3);
  assert.equal(provider.httpRetries, 2);
  assert.equal(calls[0]!.body, calls[1]!.body);
  assert.equal(calls[1]!.body, calls[2]!.body);
  assert.equal(waits.length, 2);
  assert.equal(calls[0]!.redirect, 'manual');
  assert.equal((calls[0]! as RequestInit & { cache: string }).cache, 'no-store');
  assert.equal((calls[0]!.headers as Record<string, string>)['Cache-Control'], 'no-cache, no-store');
  assert.equal((calls[0]!.headers as Record<string, string>).Authorization, 'Bearer private-key');
});

test('TypeSafeProvider makes no more than five actual attempts when a retryable response persists', async () => {
  let calls = 0;
  const provider = new TypeSafeProvider({ TYPESAFE_API_KEY: 'private-key' }, {
    fetch: async () => { calls++; return json({}, 529); },
    sleep: async () => {},
  });
  await assert.rejects(provider.evaluate(request), /HTTP 529/);
  assert.equal(calls, 5);
  assert.equal(provider.httpAttempts, 5);
  assert.equal(provider.httpRetries, 4);
});

test('TypeSafeProvider preserves hook FuzzError codes without dispatching', async () => {
  let calls = 0;
  const provider = new TypeSafeProvider({ TYPESAFE_API_KEY: 'private-key' }, { fetch: async () => { calls++; return json(response); } });
  await assert.rejects(provider.evaluate(request, { beforeAttempt: async () => { throw new FuzzError('BUDGET', 'secret internal detail'); } }), (error: unknown) => {
    assert.ok(error instanceof FuzzError); assert.equal(error.code, 'BUDGET'); assert.equal(error.message.includes('secret internal detail'), false); return true;
  });
  assert.equal(calls, 0);
});

test('TypeSafeProvider honors Retry-After seconds and dates without the legacy 30-second cap', async () => {
  for (const header of [
    '120',
    new Date(Date.now() + 120_000).toUTCString(),
  ]) {
    const waits: number[] = [];
    let calls = 0;
    const provider = new TypeSafeProvider({ TYPESAFE_API_KEY: 'private-key' }, {
      fetch: async () => ++calls === 1 ? json({}, 429, { 'retry-after': header }) : json(response),
      sleep: async (ms) => { waits.push(ms); },
    });
    await provider.evaluate(request);
    assert.equal(provider.httpAttempts, 2);
    assert.equal(provider.httpRetries, 1);
    assert.equal(waits.length, 1);
    assert.ok(waits[0]! >= 119_000, `expected full retry delay for ${header}, got ${waits[0]}`);
    assert.ok(waits[0]! <= 120_000);
  }
});

test('TypeSafeProvider falls back from malformed or negative Retry-After values', async () => {
  for (const header of ['-1', 'not-a-delay']) {
    const waits: number[] = [];
    let calls = 0;
    const provider = new TypeSafeProvider({ TYPESAFE_API_KEY: 'private-key' }, {
      fetch: async () => ++calls === 1 ? json({}, 429, { 'retry-after': header }) : json(response),
      sleep: async (ms) => { waits.push(ms); }, jitterSeed: 4,
    });
    await provider.evaluate(request);
    assert.equal(waits.length, 1);
    assert.ok(waits[0]! < 1_000);
  }
});

test('realSleep chunks oversized waits and exits promptly when cancelled', async () => {
  const controller = new AbortController();
  const nativeSetTimeout = globalThis.setTimeout;
  let scheduled = 0;
  globalThis.setTimeout = ((callback: (...args: never[]) => void, delay?: number, ...args: never[]) => {
    scheduled = Number(delay);
    return nativeSetTimeout(callback, 0, ...args);
  }) as unknown as typeof setTimeout;
  try {
    const pending = realSleep(2 ** 31, controller.signal);
    controller.abort(new Error('cancelled'));
    await assert.rejects(pending, /cancelled/);
    assert.equal(scheduled, 2 ** 31 - 1);
  } finally {
    globalThis.setTimeout = nativeSetTimeout;
  }
});

test('realSleep observes cancellation between completed chunks', async () => {
  const controller = new AbortController();
  const nativeSetTimeout = globalThis.setTimeout;
  let calls = 0;
  let laterTimer: ReturnType<typeof setTimeout> | undefined;
  globalThis.setTimeout = ((callback: (...args: never[]) => void, delay?: number, ...args: never[]) => {
    calls++;
    if (calls === 1) return nativeSetTimeout(() => {
      callback(...args);
      controller.abort(new Error('between chunks'));
    }, 0);
    laterTimer = nativeSetTimeout(callback, delay, ...args);
    return laterTimer;
  }) as unknown as typeof setTimeout;
  try {
    const pending = realSleep(2 ** 31, controller.signal);
    const result = await Promise.race([
      pending.then(() => 'resolved', error => error),
      new Promise(resolve => nativeSetTimeout(() => resolve('timed out'), 20)),
    ]);
    assert.ok(result instanceof Error);
    assert.match(result.message, /between chunks/);
    assert.equal(calls, 1);
  } finally {
    if (laterTimer) clearTimeout(laterTimer);
    globalThis.setTimeout = nativeSetTimeout;
  }
});

test('TypeSafeProvider does not retry 401 or 422 and never exposes credentials', async () => {
  for (const status of [401, 422]) {
    let calls = 0;
    const provider = new TypeSafeProvider({ TYPESAFE_API_KEY: 'secret-value' }, {
      fetch: async () => { calls++; return json({ error: 'secret-value' }, status); },
      sleep: async () => { throw new Error('must not sleep'); },
    });
    await assert.rejects(provider.evaluate(request), (error: unknown) => {
      assert.equal(calls, 1);
      assert.ok(error instanceof Error);
      assert.equal(error.message.includes('secret-value'), false);
      assert.equal(JSON.stringify(error).includes('secret-value'), false);
      return true;
    });
  }
});

test('TypeSafeProvider normalizes away echoed fields and rejects a credential in response data', async () => {
  const provider = new TypeSafeProvider({ TYPESAFE_API_KEY: 'secret-value' }, {
    fetch: async () => json({ ...response, echoedAuthorization: 'Bearer secret-value' }),
  });
  const normalized = await provider.evaluate(request);
  assert.equal(Object.hasOwn(normalized as unknown as Record<string, unknown>, 'echoedAuthorization'), false);
  const echoedModel = { ...response, model: 'secret-value' };
  const leakingProvider = new TypeSafeProvider({ TYPESAFE_API_KEY: 'secret-value' }, { fetch: async () => json(echoedModel) });
  await assert.rejects(leakingProvider.evaluate(request), /contains a credential/i);
  for (const token of ['secret"value', 'secret\\value']) {
    const escapedProvider = new TypeSafeProvider({ TYPESAFE_API_KEY: token }, {
      fetch: async () => json({ ...response, model: `model-${token}` }),
    });
    await assert.rejects(escapedProvider.evaluate(request), /contains a credential/i);
  }
  const deeplyEscapedToken = 'secret"value';
  let deeplyEscapedModel = deeplyEscapedToken;
  for (let layer = 0; layer < 12; layer++) deeplyEscapedModel = JSON.stringify(deeplyEscapedModel);
  const deeplyEscapedProvider = new TypeSafeProvider({ TYPESAFE_API_KEY: deeplyEscapedToken }, {
    fetch: async () => json({ ...response, model: deeplyEscapedModel }),
  });
  await assert.rejects(deeplyEscapedProvider.evaluate(request), /contains a credential/i);
  assert.throws(() => new TypeSafeProvider({ TYPESAFE_API_KEY: 'has whitespace' }), /invalid TYPESAFE_API_KEY/i);
  assert.throws(() => new TypeSafeProvider({ TYPESAFE_API_KEY: ' private-key' }), /invalid TYPESAFE_API_KEY/i);
});

test('TypeSafeProvider cancellation stops a timed-out retry wait', async () => {
  const controller = new AbortController();
  let calls = 0;
  const provider = new TypeSafeProvider({ TYPESAFE_API_KEY: 'key' }, {
    fetch: async () => { calls++; return json({}, 529); },
    sleep: async (_ms, signal) => new Promise<void>((resolve, reject) => {
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
      controller.abort(new Error('cancelled'));
      resolve();
    }),
  });
  await assert.rejects(provider.evaluate(request, { signal: controller.signal }), /cancelled|aborted/i);
  assert.equal(calls, 1);
  assert.equal(provider.httpRetries, 0);
});

test('TypeSafeProvider retries when response body reading times out', async () => {
  let calls = 0;
  const provider = new TypeSafeProvider({ TYPESAFE_API_KEY: 'key' }, {
    timeoutMs: 1,
    sleep: async () => {},
    fetch: async (_input, init) => {
      calls++;
      if (calls > 1) return json(response);
      return {
        status: 200, ok: true, headers: new Headers(),
        body: new ReadableStream<Uint8Array>({ start(controller) {
          (init!.signal as AbortSignal).addEventListener('abort', () => controller.error(new DOMException('timed out', 'AbortError')), { once: true });
        } }),
      } as unknown as Response;
    },
  });
  // AbortSignal.timeout is unref'ed. A real fetch owns a socket; this fake must
  // keep the event loop alive while Node 22 waits for its abort signal.
  const keepAlive = setInterval(() => {}, 1000);
  try {
    assert.deepEqual(await provider.evaluate(request), response);
    assert.equal(calls, 2);
  } finally { clearInterval(keepAlive); }
});

test('CloudflareProvider uses the fixed Jev endpoint and refuses missing observed model metadata', async () => {
  let url = '';
  let body = '';
  const provider = new CloudflareProvider({ CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32), CLOUDFLARE_API_TOKEN: 'cf-secret' }, {
    fetch: async (input, init) => {
      url = String(input); body = String(init?.body);
      return json({ result: { answers: response.answers, usage: response.usage } });
    },
  });
  await assert.rejects(provider.evaluate(request), /actual model version/i);
  assert.equal(url, `https://api.cloudflare.com/client/v4/accounts/${'a'.repeat(32)}/ai/run`);
  assert.deepEqual(JSON.parse(body), { model: 'typesafe/jev', input: { state: request.state, questions: request.questions } });
  const invalidModel = new CloudflareProvider({ CLOUDFLARE_ACCOUNT_ID: 'b'.repeat(32), CLOUDFLARE_API_TOKEN: 'cf-secret' }, { fetch: async () => json(response) });
  await assert.rejects(invalidModel.evaluate({ ...request, model: 'jev-1.13.0' }), /supports only jev-latest or typesafe\/jev/i);
});

test('CloudflareProvider sends the gateway skip-cache header on every retry', async () => {
  const calls: RequestInit[] = [];
  const provider = new CloudflareProvider({ CLOUDFLARE_ACCOUNT_ID: 'c'.repeat(32), CLOUDFLARE_API_TOKEN: 'cf-secret' }, {
    fetch: async (_input, init) => {
      calls.push(init!);
      return calls.length < 3 ? json({}, 529) : json({ result: response });
    },
    sleep: async () => {},
  });
  assert.deepEqual(await provider.evaluate(request), response);
  assert.equal(calls.length, 3);
  for (const call of calls) assert.equal(new Headers(call.headers).get('cf-aig-skip-cache'), 'true');
});

test('CloudflareProvider records only an explicit cache HIT and TypeSafe remains unknown', async () => {
  for (const [header, expected] of [
    ['  hIt  ', 'cached'],
    ['MISS', 'unknown'],
    ['BYPASS', 'unknown'],
    [undefined, 'unknown'],
  ] as const) {
    const metadata: string[] = [];
    const provider = new CloudflareProvider({ CLOUDFLARE_ACCOUNT_ID: 'd'.repeat(32), CLOUDFLARE_API_TOKEN: 'cf-secret' }, {
      fetch: async () => json({ result: response }, 200, header === undefined ? undefined : { 'cf-aig-cache-status': header }),
    });
    assert.equal(provider.capabilities.cacheMetadata, false);
    await provider.evaluate(request, { observedMetadata: async ({ cache }) => { metadata.push(cache); } });
    assert.deepEqual(metadata, [expected]);
  }

  const metadata: string[] = [];
  const provider = new TypeSafeProvider({ TYPESAFE_API_KEY: 'private-key' }, {
    fetch: async () => json(response, 200, { 'cf-aig-cache-status': 'HIT' }),
  });
  assert.equal(provider.capabilities.cacheMetadata, false);
  await provider.evaluate(request, { observedMetadata: async ({ cache }) => { metadata.push(cache); } });
  assert.deepEqual(metadata, ['unknown']);
});

test('FakeProvider is deterministic by default and supports an injected handler', async () => {
  const fake = new FakeProvider();
  assert.deepEqual(await fake.evaluate(request), await fake.evaluate(request));
  assert.equal(fake.httpRetries, 0);
  const custom = new FakeProvider((_request, index) => ({ ...response, model: `test-${index}` }));
  assert.equal((await custom.evaluate(request)).model, 'test-0');
  assert.equal((await custom.evaluate(request)).model, 'test-1');
});

test('FakeProvider makes the same choice when Choice criteria insertion order differs', async () => {
  const fake = new FakeProvider();
  const reversed: JevRequest = { ...request, questions: { choice: { type: 'choice', instructions: 'pick', criteria: { no: 'no', yes: 'yes' } } } };
  const original: JevRequest = { ...request, questions: { choice: request.questions.choice! } };
  const first = await fake.evaluate(original);
  const second = await fake.evaluate(reversed);
  assert.equal((first.answers.choice as { choice: string }).choice, (second.answers.choice as { choice: string }).choice);
});

test('TypeSafeProvider rejects a backslash API path before any request can leave the process', () => {
  assert.throws(() => new TypeSafeProvider({ TYPESAFE_API_KEY: 'private-key', JEV_API_HOST: 'https://api.typesafe.ai', JEV_API_PATH: '/\\attacker.example/path' }), /invalid API path|configured origin/i);
});
