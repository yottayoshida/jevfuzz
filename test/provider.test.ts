import assert from 'node:assert/strict';
import test from 'node:test';

import { CloudflareProvider, FakeProvider, TypeSafeProvider, validateResponse } from '../src/provider.ts';
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
  assert.equal(calls[0]!.body, calls[1]!.body);
  assert.equal(calls[1]!.body, calls[2]!.body);
  assert.equal(waits.length, 2);
  assert.equal(calls[0]!.redirect, 'manual');
  assert.equal((calls[0]!.headers as Record<string, string>).Authorization, 'Bearer private-key');
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
        status: 200, ok: true, headers: new Headers(), body: null,
        json: () => new Promise((_, reject) => (init!.signal as AbortSignal).addEventListener('abort', () => reject(new DOMException('timed out', 'AbortError')), { once: true })),
      } as unknown as Response;
    },
  });
  assert.deepEqual(await provider.evaluate(request), response);
  assert.equal(calls, 2);
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

test('FakeProvider is deterministic by default and supports an injected handler', async () => {
  const fake = new FakeProvider();
  assert.deepEqual(await fake.evaluate(request), await fake.evaluate(request));
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
