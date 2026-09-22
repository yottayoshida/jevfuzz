import { randomUUID } from 'node:crypto';
import type { DecisionProvider, JevResponse } from '../types.ts';
import type { Observation, Phase } from '../campaign-types.ts';
import { validateRequest } from '../config.ts';
import { FakeProvider, validateResponse } from '../provider.ts';
import { BudgetLedger } from './budget.ts';
import { FuzzError } from '../util.ts';
import { wireHash } from '../identity.ts';
import { parseBoundedJson } from '../storage.ts';

export interface ExecutionJournal { append(type: string, data: unknown): Promise<void> }
export interface BrokerOptions { journal?: ExecutionJournal; signal?: AbortSignal; providerName?: string; secrets?: string[]; strict?: boolean; maxPayloadBytes?: number }

/** The sole v2 execution boundary: validates payloads, charges attempts, and records model cohorts. */
export class EvaluationBroker {
  readonly observations: Observation[] = [];
  readonly observedModels: string[] = [];
  readonly usage = { inputTokens: 0, outputTokens: 0 };
  modelChanged = false;
  readonly #provider: DecisionProvider; readonly #ledger?: BudgetLedger; readonly #options: BrokerOptions;
  #firstModel?: string;
  readonly #operationIds = new Set<string>();
  constructor(provider: DecisionProvider, ledger?: BudgetLedger, options: BrokerOptions = {}) {
    this.#provider = provider; this.#ledger = ledger; this.#options = options;
    const capabilities = provider.capabilities;
    if (options.strict && !(provider instanceof FakeProvider) && (!capabilities?.httpAccounting || capabilities.attemptHooks !== true)) throw new FuzzError('CONFIG', 'strict broker requires provider attempt hooks for HTTP accounting');
  }
  async evaluate(payload: string, phase: Phase, operationId: string = randomUUID()): Promise<Observation> {
    if (this.#options.signal?.aborted) throw this.#options.signal.reason ?? new FuzzError('PROVIDER_ABORTED', 'provider request was aborted');
    const remainingDeadlineMs = this.#ledger ? this.#ledger.config.wallTimeSeconds * 1000 - this.#ledger.elapsedMs : undefined;
    if (remainingDeadlineMs !== undefined && remainingDeadlineMs <= 0) throw new FuzzError('DEADLINE', 'campaign deadline reached');
    const deadlineSignal = remainingDeadlineMs === undefined ? undefined : AbortSignal.timeout(Math.max(1, Math.floor(remainingDeadlineMs)));
    const signal = this.#options.signal && deadlineSignal ? AbortSignal.any([this.#options.signal, deadlineSignal]) : this.#options.signal ?? deadlineSignal;
    if (!Number.isSafeInteger(this.#options.maxPayloadBytes ?? 1_000_000) || (this.#options.maxPayloadBytes ?? 1_000_000) < 1 || Buffer.byteLength(payload, 'utf8') > (this.#options.maxPayloadBytes ?? 1_000_000)) throw new FuzzError('CONFIG', 'broker payload exceeds configured limit');
    if (this.#operationIds.has(operationId)) throw new FuzzError('CONFIG', 'duplicate broker operation ID');
    this.#operationIds.add(operationId);
    this.assertNoSecrets(payload);
    let parsed: unknown;
    try { parsed = parseBoundedJson(payload, this.#options.maxPayloadBytes ?? 1_000_000); } catch { throw new FuzzError('CONFIG', 'broker payload must be bounded valid JSON'); }
    const request = validateRequest(parsed); const engineWireHash = wireHash(payload); const logicalId = `logical:${operationId}:${randomUUID()}`;
    if (this.#ledger) {
      this.#ledger.reserve(phase, 'logical', logicalId);
      try { await this.event('reservation', { operationId, attemptId: logicalId, phase, kind: 'logical' }); } catch (error) { this.#ledger.release(logicalId); throw error; }
      this.#ledger.dispatch(logicalId); await this.event('dispatched', { operationId, attemptId: logicalId, phase, kind: 'logical' });
    }
    let transportWireHash: string | undefined, transportUncertain = false, cache: Observation['cache'] = 'unknown', logicalSettled = false;
    try {
      const response = validateResponse(await this.#provider.evaluate(request, {
        signal, payload,
        beforeAttempt: async attempt => {
          transportWireHash = wireHash(attempt.transportPayload); this.assertNoSecrets(attempt.transportPayload);
          if (this.#ledger) { this.#ledger.reserve(phase, 'http', attempt.attemptId); try { await this.event('reservation', { operationId, attemptId: attempt.attemptId, phase, kind: 'http', wireHash: transportWireHash }); } catch (error) { this.#ledger.release(attempt.attemptId); throw error; } this.#ledger.dispatch(attempt.attemptId); await this.event('dispatched', { operationId, attemptId: attempt.attemptId, phase, kind: 'http' }); }
        },
        settledAttempt: async attempt => {
          if (attempt.outcome === 'unknown') transportUncertain = true;
          if (this.#ledger) { this.#ledger.settle(attempt.attemptId, attempt.outcome); await this.event('settled', { operationId, attemptId: attempt.attemptId, phase, kind: 'http', outcome: attempt.outcome }); }
        },
        observedMetadata: async metadata => { cache = metadata.cache; },
      }), request);
      this.assertNoSecrets(JSON.stringify(response));
      const observation: Observation = { id: randomUUID(), operationId, phase, wireHash: engineWireHash, ...(transportWireHash ? { transportWireHash } : {}), ...(transportUncertain ? { transportUncertain: true } : {}), response, provider: this.#options.providerName ?? this.#provider.capabilities?.adapterId ?? this.#provider.mode ?? 'custom', observedModel: response.model, cache };
      await this.event('observation', { operationId, observation });
      if (this.#ledger) { this.#ledger.settle(logicalId, 'known'); logicalSettled = true; await this.event('settled', { operationId, attemptId: logicalId, phase, kind: 'logical', outcome: 'known' }); }
      this.observations.push(observation); this.usage.inputTokens += response.usage.input_tokens; this.usage.outputTokens += response.usage.output_tokens;
      if (!this.observedModels.includes(response.model)) this.observedModels.push(response.model);
      if (this.#firstModel === undefined) this.#firstModel = response.model; else if (this.#firstModel !== response.model) this.modelChanged = true;
      return observation;
    } catch (error) {
      if (this.#ledger && !logicalSettled) {
        const outcome = error instanceof FuzzError && ['PROVIDER_HTTP', 'PROVIDER_RESPONSE'].includes(error.code) ? 'known' : 'unknown';
        this.#ledger.settle(logicalId, outcome);
        await this.event('settled', { operationId, attemptId: logicalId, phase, kind: 'logical', outcome });
      }
      throw error;
    }
  }
  async event(type: string, data: unknown): Promise<void> { await this.#options.journal?.append(type, data); }
  private assertNoSecrets(value: string): void { for (const secret of this.#options.secrets ?? []) if (secret && value.includes(secret)) throw new FuzzError('CONFIG', 'secret-bearing broker data is forbidden'); }
}
