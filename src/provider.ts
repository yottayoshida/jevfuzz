import { randomUUID } from 'node:crypto';
import type { DecisionProvider, EvaluateOptions, JevAnswer, JevRequest, JevResponse, ProviderCapabilities } from './types.ts';
import { FuzzError, record, rng } from './util.ts';
import { validateRequest } from './config.ts';
import { canonicalJson, hasSecrets, parseBoundedJson } from './storage.ts';
import { finiteUnit, probabilities } from './answer-validation.ts';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const DEFAULT_TYPESAFE_HOST = 'https://api.typesafe.ai';
const DEFAULT_TYPESAFE_PATH = '/v1/systemone';
const CLOUDFLARE_MODEL = 'typesafe/jev';
const MAX_ATTEMPTS = 5;
const MAX_TIMEOUT_MS = 2 ** 31 - 1;

export interface ProviderOptions {
  fetch?: typeof fetch;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  timeoutMs?: number;
  maxAttempts?: number;
  jitterSeed?: number;
  maxResponseBytes?: number;
  maxResponseDepth?: number;
}

type Environment = Readonly<Record<string, string | undefined>>;

function providerError(code: string, message: string): FuzzError {
  return new FuzzError(code, message);
}

/** Hooks sit on the durable accounting boundary: retain their machine-readable code,
 * but never expose an arbitrary hook message through a live provider error. */
function hookError(error: unknown, fallback: 'STORAGE_LIMIT' | 'PERSISTENCE_ERROR'): FuzzError {
  return error instanceof FuzzError ? providerError(error.code, 'provider hook failed') : providerError(fallback, 'provider hook failed');
}

function responseError(): FuzzError {
  return providerError('PROVIDER_RESPONSE', 'invalid provider response');
}

function missingModelError(): FuzzError {
  return providerError('PROVIDER_RESPONSE', 'provider response is missing the actual model version');
}

function validAnswer(value: unknown, question: JevRequest['questions'][string]): value is JevAnswer {
  if (!record(value) || value.type !== question.type) return false;
  if (question.type === 'noul') return finiteUnit(value.noul);
  if (!finiteUnit(value.confidence)) return false;
  if (question.type === 'choice') {
    const keys = Object.keys(question.criteria);
    return typeof value.choice === 'string' && Object.hasOwn(question.criteria, value.choice)
      && probabilities(value.probabilities, keys) !== null;
  }
  const keys = question.criteria.map((_, index) => String(index));
  return typeof value.score === 'number' && Number.isFinite(value.score)
    && value.score >= 0 && value.score <= question.criteria.length - 1
    && probabilities(value.probabilities, keys) !== null && record(value.legend);
}

/** Validates the complete Jev response against both the public response schema and its request. */
export function validateResponse(raw: unknown, request: JevRequest): JevResponse {
  try { request = validateRequest(request); } catch { throw providerError('PROVIDER_REQUEST', 'invalid provider request'); }
  let isRecord = false;
  try { isRecord = record(raw); } catch { throw responseError(); }
  if (!isRecord) throw responseError();
  let observedModel: unknown;
  try { observedModel = Object.getOwnPropertyDescriptor(raw as object, 'model')?.value; } catch { throw responseError(); }
  if (typeof observedModel !== 'string' || observedModel.trim() === '') throw missingModelError();
  try { raw = canonicalJson(raw); } catch { throw responseError(); }
  if (!record(raw)) throw responseError();
  if (typeof raw.model !== 'string' || raw.model.trim() === '') throw missingModelError();
  if (!record(raw.answers) || !record(raw.usage)) throw responseError();
  const answers = raw.answers;
  const usage = raw.usage;
  const questionIds = Object.keys(request.questions);
  const answerIds = Object.keys(raw.answers);
  if (answerIds.length !== questionIds.length || questionIds.some((id) => !Object.hasOwn(answers, id))) throw responseError();
  for (const id of questionIds) if (!validAnswer(answers[id], request.questions[id]!)) throw responseError();
  const { input_tokens: inputTokens, output_tokens: outputTokens } = usage;
  if (typeof inputTokens !== 'number' || !Number.isSafeInteger(inputTokens) || inputTokens < 0
    || typeof outputTokens !== 'number' || !Number.isSafeInteger(outputTokens) || outputTokens < 0) throw responseError();
  const normalizedAnswers: Record<string, JevAnswer> = Object.create(null);
  for (const id of questionIds) {
    const answer = answers[id] as Record<string, unknown>;
    const question = request.questions[id]!;
    if (question.type === 'noul') normalizedAnswers[id] = { type: 'noul', noul: answer.noul as number };
    else if (question.type === 'choice') normalizedAnswers[id] = {
      type: 'choice', choice: answer.choice as string,
      probabilities: { ...(answer.probabilities as Record<string, number>) }, confidence: answer.confidence as number,
    };
    else normalizedAnswers[id] = {
      type: 'score', score: answer.score as number,
      probabilities: { ...(answer.probabilities as Record<string, number>) }, confidence: answer.confidence as number,
      legend: structuredClone(answer.legend) as Record<string, import('./types.ts').Json>,
    };
  }
  return { model: raw.model, answers: Object.fromEntries(Object.entries(normalizedAnswers)), usage: { input_tokens: inputTokens, output_tokens: outputTokens } };
}

function environmentValue(env: Environment, key: string): string {
  const value = env[key]?.trim();
  if (!value) throw providerError('PROVIDER_CONFIG', `missing ${key}`);
  return value;
}

function tokenValue(env: Environment, key: string): string {
  const raw = env[key];
  if (raw === undefined || raw.trim() === '') throw providerError('PROVIDER_CONFIG', `missing ${key}`);
  const token = raw;
  if (/\s/.test(token)) throw providerError('PROVIDER_CONFIG', `invalid ${key}`);
  return token;
}

function safeOrigin(raw: string): URL {
  const source = raw.includes('://') ? raw : `https://${raw}`;
  let url: URL;
  try { url = new URL(source); } catch { throw providerError('PROVIDER_CONFIG', 'invalid API host'); }
  if (url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) {
    throw providerError('PROVIDER_CONFIG', 'invalid API host');
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname))) {
    throw providerError('PROVIDER_CONFIG', 'API host must use HTTPS');
  }
  return url;
}

function safePath(raw: string | undefined): string {
  const path = raw?.trim() || DEFAULT_TYPESAFE_PATH;
  if (!path.startsWith('/') || path.startsWith('//') || path.includes('?') || path.includes('#') || /[\\\r\n]/.test(path)) {
    throw providerError('PROVIDER_CONFIG', 'invalid API path');
  }
  return path;
}

function typesafeUrl(env: Environment): string {
  const origin = safeOrigin(env.JEV_API_HOST?.trim() || DEFAULT_TYPESAFE_HOST);
  const path = safePath(env.JEV_API_PATH);
  const url = new URL(path, origin);
  if (url.origin !== origin.origin) throw providerError('PROVIDER_CONFIG', 'API path must remain on the configured origin');
  return url.toString();
}

function cloudflareUrl(env: Environment): string {
  const accountId = environmentValue(env, 'CLOUDFLARE_ACCOUNT_ID');
  if (!/^[0-9a-f]{32}$/i.test(accountId)) throw providerError('PROVIDER_CONFIG', 'invalid CLOUDFLARE_ACCOUNT_ID');
  return `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run`;
}

function abortError(signal: AbortSignal): unknown {
  return signal.reason instanceof Error ? signal.reason : providerError('PROVIDER_ABORTED', 'provider request was aborted');
}

export async function realSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw abortError(signal);
  let remaining = ms;
  while (remaining > 0) {
    if (signal?.aborted) throw abortError(signal);
    const delay = Math.min(remaining, MAX_TIMEOUT_MS);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(done, delay);
      function done(): void { signal?.removeEventListener('abort', cancelled); resolve(); }
      function cancelled(): void { clearTimeout(timer); reject(abortError(signal!)); }
      signal?.addEventListener('abort', cancelled, { once: true });
    });
    remaining -= delay;
  }
}

function retryAfter(response: Response): number | undefined {
  const value = response.headers.get('retry-after');
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return seconds >= 0 && Number.isFinite(seconds * 1000) ? seconds * 1000 : undefined;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

function withinDepth(value: unknown, maximum: number): boolean {
  const pending: { value: unknown; depth: number }[] = [{ value, depth: 0 }];
  while (pending.length) {
    const item = pending.pop()!;
    if (item.depth > maximum) return false;
    if (item.value !== null && typeof item.value === 'object') for (const child of Array.isArray(item.value) ? item.value : Object.values(item.value)) pending.push({ value: child, depth: item.depth + 1 });
  }
  return true;
}

async function boundedJson(response: Response, maxBytes: number, maxDepth: number): Promise<unknown> {
  if (!response.body) throw responseError();
  const reader = response.body.getReader(); let bytes = 0; const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const part = await reader.read(); if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > maxBytes) { await reader.cancel(); throw providerError('PROVIDER_RESPONSE', 'provider response exceeds configured limit'); }
      chunks.push(part.value);
    }
  } finally { reader.releaseLock(); }
  let value: unknown;
  try { value = JSON.parse(new TextDecoder().decode(Buffer.concat(chunks))); } catch { throw responseError(); }
  if (!withinDepth(value, maxDepth)) throw providerError('PROVIDER_RESPONSE', 'provider response exceeds configured depth');
  return value;
}

abstract class HttpProvider implements DecisionProvider {
  readonly mode = 'live' as const;
  readonly capabilities: ProviderCapabilities = { adapterId: 'http', adapterVersion: '1', observedModel: true, probabilities: true, confidence: true, usage: true, httpAccounting: true, byteReplay: true, cancellation: true, cacheMetadata: false, attemptHooks: true };
  #httpAttempts = 0;
  get httpAttempts(): number { return this.#httpAttempts; }
  #httpRetries = 0;
  get httpRetries(): number { return this.#httpRetries; }
  readonly #fetch: typeof fetch;
  readonly #sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly #timeoutMs: number;
  readonly #maxAttempts: number;
  readonly #random: () => number;
  readonly #url: string;
  readonly #token: string;
  readonly #maxResponseBytes: number;
  readonly #maxResponseDepth: number;

  protected constructor(url: string, token: string, options: ProviderOptions = {}) {
    if (!Number.isSafeInteger(options.timeoutMs ?? 20_000) || (options.timeoutMs ?? 20_000) <= 0) throw providerError('PROVIDER_CONFIG', 'invalid timeout');
    const maxAttempts = options.maxAttempts ?? MAX_ATTEMPTS;
    if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > MAX_ATTEMPTS) throw providerError('PROVIDER_CONFIG', 'maxAttempts must be between 1 and 5');
    this.#url = url; this.#token = token; this.#fetch = options.fetch ?? fetch;
    this.#sleep = options.sleep ?? realSleep; this.#timeoutMs = options.timeoutMs ?? 20_000;
    this.#maxAttempts = maxAttempts; this.#random = rng(options.jitterSeed ?? 0x4a455646);
    this.#maxResponseBytes = options.maxResponseBytes ?? 1_000_000; this.#maxResponseDepth = options.maxResponseDepth ?? 64;
    if (!Number.isSafeInteger(this.#maxResponseBytes) || this.#maxResponseBytes < 1 || !Number.isSafeInteger(this.#maxResponseDepth) || this.#maxResponseDepth < 1) throw providerError('PROVIDER_CONFIG', 'invalid response limits');
  }

  protected abstract body(request: JevRequest): unknown;
  protected abstract unpack(raw: unknown): unknown;

  protected serialize(request: JevRequest, supplied?: string): string { return JSON.stringify(this.body(request)); }
  protected requestHeaders(): Record<string, string> {
    return { Authorization: `Bearer ${this.#token}`, 'Content-Type': 'application/json', 'Cache-Control': 'no-cache, no-store' };
  }
  protected observedCache(_response: Response): 'unknown' | 'cached' { return 'unknown'; }

  async evaluate(request: JevRequest, options: EvaluateOptions = {}): Promise<JevResponse> {
    try {
      request = validateRequest(request);
      if (options.payload !== undefined) {
        const supplied = validateRequest(parseBoundedJson(options.payload));
        if (JSON.stringify(supplied) !== JSON.stringify(request)) throw responseError();
      }
    } catch { throw providerError('PROVIDER_REQUEST', 'invalid provider request'); }
    const payload = this.serialize(request, options.payload);
    for (let attempt = 1; attempt <= this.#maxAttempts; attempt++) {
      if (options.signal?.aborted) throw abortError(options.signal);
      const timeout = AbortSignal.timeout(this.#timeoutMs);
      const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
      let dispatched = false;
      const attemptInfo = { attemptId: randomUUID(), transportPayload: payload, attempt };
      const settle = async (outcome: 'known' | 'unknown') => { if (dispatched) { dispatched = false; try { await options.settledAttempt?.({ ...attemptInfo, outcome }); } catch (error) { throw hookError(error, 'STORAGE_LIMIT'); } } };
      try {
        if (attempt > 1) this.#httpRetries++;
        try { await options.beforeAttempt?.(attemptInfo); } catch (error) { throw hookError(error, 'STORAGE_LIMIT'); }
        dispatched = true;
        this.#httpAttempts++;
        const init: RequestInit & { cache: 'no-store' } = {
          method: 'POST', headers: this.requestHeaders(),
          body: payload, redirect: 'manual', cache: 'no-store', signal,
        };
        const response = await this.#fetch(this.#url, init);
        if (response.status >= 300 && response.status < 400) { await settle('known'); throw providerError('PROVIDER_HTTP', 'provider rejected a redirect'); }
        if ((response.status === 429 || response.status === 529) && attempt < this.#maxAttempts) {
          await settle('known');
          await response.body?.cancel();
          await this.wait(retryAfter(response), attempt, options.signal);
          continue;
        }
        if (!response.ok) { await settle('known'); throw providerError('PROVIDER_HTTP', `provider request failed with HTTP ${response.status}`); }
        let raw: unknown;
        try { raw = await boundedJson(response, this.#maxResponseBytes, this.#maxResponseDepth); }
        catch (error) {
          await settle(signal.aborted ? 'unknown' : 'known');
          if (signal.aborted || !(error instanceof SyntaxError)) throw error;
          throw responseError();
        }
        const normalized = validateResponse(this.unpack(raw), request);
        if (hasSecrets(normalized, [this.#token])) throw providerError('PROVIDER_RESPONSE', 'provider response contains a credential');
        await settle('known'); try { await options.observedMetadata?.({ cache: this.observedCache(response) }); } catch (error) { throw hookError(error, 'PERSISTENCE_ERROR'); }
        return normalized;
      } catch (error) {
        if (dispatched) await settle('unknown');
        if (options.signal?.aborted) throw abortError(options.signal);
        if (error instanceof FuzzError) throw error;
        const timedOut = timeout.aborted;
        if (attempt < this.#maxAttempts) {
          await this.wait(undefined, attempt, options.signal);
          continue;
        }
        throw providerError(timedOut ? 'PROVIDER_TIMEOUT' : 'PROVIDER_NETWORK', timedOut ? 'provider request timed out' : 'provider network request failed');
      }
    }
    throw providerError('PROVIDER_NETWORK', 'provider network request failed');
  }

  async wait(retryAfterMs: number | undefined, attempt: number, signal?: AbortSignal): Promise<void> {
    const base = 250 * 2 ** (attempt - 1);
    const jittered = Math.round(base * (0.8 + this.#random() * 0.4));
    await this.#sleep(retryAfterMs ?? jittered, signal);
  }
}

/** Live TypeSafe System One provider. Its API key remains private to this instance. */
export class TypeSafeProvider extends HttpProvider {
  constructor(env: Environment = process.env, options: ProviderOptions = {}) { super(typesafeUrl(env), tokenValue(env, 'TYPESAFE_API_KEY'), options); }
  protected body(request: JevRequest): unknown { return request; }
  protected serialize(request: JevRequest, supplied?: string): string { return supplied ?? super.serialize(request); }
  protected unpack(raw: unknown): unknown { return raw; }
}

function cloudflareResult(raw: unknown): unknown {
  // Workers AI has returned both `result: { answers }` and a completed-job envelope
  // with a second `result`. Preserve only response metadata that actually arrived.
  let node: unknown = raw;
  let model: unknown;
  let answers: unknown;
  let usage: unknown;
  for (let depth = 0; depth < 4 && record(node); depth++) {
    if (typeof node.model === 'string') model = node.model;
    if (record(node.answers)) answers = node.answers;
    if (record(node.usage)) usage = node.usage;
    node = node.result;
  }
  return { model, answers, usage };
}

/** Minimal Workers AI adapter, kept separate because its wire format is not TypeSafe System One's. */
export class CloudflareProvider extends HttpProvider {
  constructor(env: Environment = process.env, options: ProviderOptions = {}) { super(cloudflareUrl(env), tokenValue(env, 'CLOUDFLARE_API_TOKEN'), options); }
  protected requestHeaders(): Record<string, string> { return { ...super.requestHeaders(), 'cf-aig-skip-cache': 'true', 'cf-aig-max-attempts': '1' }; }
  protected observedCache(response: Response): 'unknown' | 'cached' {
    return response.headers.get('cf-aig-cache-status')?.trim().toUpperCase() === 'HIT' ? 'cached' : 'unknown';
  }
  protected body(request: JevRequest): unknown {
    // Workers AI exposes this provider as a fixed model. v0.1 accepts only its
    // canonical name and the TypeSafe latest alias, then maps either to that name.
    if (request.model !== 'jev-latest' && request.model !== CLOUDFLARE_MODEL) throw providerError('PROVIDER_REQUEST', 'CloudflareProvider supports only jev-latest or typesafe/jev');
    return { model: CLOUDFLARE_MODEL, input: { state: request.state, questions: request.questions } };
  }
  protected unpack(raw: unknown): unknown { return cloudflareResult(raw); }
}

function defaultResponse(request: JevRequest): JevResponse {
  const answers: Record<string, JevAnswer> = Object.create(null);
  for (const [id, question] of Object.entries(request.questions)) {
    if (question.type === 'choice') {
      const choices = Object.keys(question.criteria).sort((left, right) => left < right ? -1 : left > right ? 1 : 0); const choice = choices[0] ?? '';
      answers[id] = { type: 'choice', choice, probabilities: Object.fromEntries(choices.map((key) => [key, key === choice ? 1 : 0])), confidence: 1 };
    } else if (question.type === 'noul') answers[id] = { type: 'noul', noul: 0.5 };
    else {
      const keys = question.criteria.map((_, index) => String(index));
      answers[id] = { type: 'score', score: 0, probabilities: Object.fromEntries(keys.map((key) => [key, key === '0' ? 1 : 0])), confidence: 1, legend: Object.fromEntries(question.criteria.map((value, index) => [String(index), value])) };
    }
  }
  return { model: 'fake-jev-1', answers, usage: { input_tokens: 0, output_tokens: 0 } };
}

/** Offline-only provider. It never becomes a fallback for a failed live request. */
export class FakeProvider implements DecisionProvider {
  readonly mode = 'fake' as const;
  readonly httpRetries = 0;
  readonly capabilities: ProviderCapabilities = { adapterId: 'fake', adapterVersion: '1', observedModel: true, probabilities: true, confidence: true, usage: true, httpAccounting: false, byteReplay: true, cancellation: true, cacheMetadata: true };
  #index = 0;
  readonly #handler: (request: JevRequest, index: number) => JevResponse;
  constructor(handler: (request: JevRequest, index: number) => JevResponse = defaultResponse) { this.#handler = handler; }
  async evaluate(request: JevRequest, options: EvaluateOptions = {}): Promise<JevResponse> {
    options.signal?.throwIfAborted();
    try { request = validateRequest(request); } catch { throw providerError('PROVIDER_REQUEST', 'invalid provider request'); }
    const result = validateResponse(this.#handler(request, this.#index++), request);
    await options.observedMetadata?.({ cache: 'fresh' }); return result;
  }
}
