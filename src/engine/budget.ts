import { randomUUID } from 'node:crypto';
import type { BudgetConfig, Phase } from '../campaign-types.ts';
import { assert, FuzzError, integer } from '../util.ts';

export interface Balance { limit: number; activeReserved: number; consumedKnown: number; consumedUnknown: number; remaining: number }
export interface Reservation { id: string; kind: 'logical' | 'http'; phase: Phase; state: 'reserved' | 'dispatched' | 'known' | 'unknown' | 'released' }
export interface BudgetSnapshot { version: 1; lineageBudgetId: string; config: BudgetConfig; elapsedMs: number; logical: Balance; http: Balance; phases: Record<Phase, Balance>; reservations: Reservation[] }
const phaseKeys = { discovery: 'discoveryRequests', confirmation: 'confirmationRequests', shrink: 'shrinkRequests', 'final-confirmation': 'finalConfirmationRequests' } as const;
const balance = (limit: number): Balance => ({ limit, activeReserved: 0, consumedKnown: 0, consumedUnknown: 0, remaining: limit });

export function validateBudget(config: BudgetConfig): void {
  integer(config.logicalRequests, 'logical requests', 1, 10_000_000);
  integer(config.httpAttempts, 'HTTP attempts', 0, 50_000_000);
  integer(config.wallTimeSeconds, 'wall time', 1, 86_400);
  let total = 0;
  for (const key of Object.values(phaseKeys)) total += integer(config[key], key, 0, 10_000_000);
  assert(total <= config.logicalRequests, 'phase budgets exceed total logical budget');
}

/** Reservations are synchronous, so concurrent callers cannot overdraw a balance. */
export class BudgetLedger {
  readonly config: BudgetConfig;
  readonly lineageBudgetId: string;
  readonly #logical: Balance;
  readonly #http: Balance;
  readonly #phases: Record<Phase, Balance>;
  readonly #reservations = new Map<string, Reservation>();
  readonly #start = Date.now();
  readonly #priorElapsed: number;
  constructor(config: BudgetConfig, restored?: BudgetSnapshot) {
    validateBudget(config); this.config = structuredClone(config);
    this.lineageBudgetId = restored?.lineageBudgetId ?? randomUUID();
    this.#priorElapsed = restored?.elapsedMs ?? 0;
    this.#logical = balance(config.logicalRequests); this.#http = balance(config.httpAttempts);
    this.#phases = Object.fromEntries(Object.entries(phaseKeys).map(([phase, key]) => [phase, balance(config[key])])) as Record<Phase, Balance>;
    if (restored) {
      assert(restored.version === 1 && JSON.stringify(restored.config) === JSON.stringify(config), 'checkpoint budget changed');
      assert(typeof restored.lineageBudgetId === 'string' && restored.lineageBudgetId.length > 0 && Number.isFinite(restored.elapsedMs) && restored.elapsedMs >= 0, 'invalid budget lineage');
      for (const entry of restored.reservations) {
        assert(!this.#reservations.has(entry.id) && ['logical', 'http'].includes(entry.kind) && Object.hasOwn(phaseKeys, entry.phase), 'invalid restored reservation');
        assert(['reserved', 'dispatched', 'known', 'unknown', 'released'].includes(entry.state), 'invalid restored reservation state');
        const copy = structuredClone(entry);
        // An interrupted durable reservation is conservatively consumed, never refunded.
        if (copy.state === 'reserved' || copy.state === 'dispatched') copy.state = 'unknown';
        this.#reservations.set(copy.id, copy);
        if (copy.state === 'released') continue;
        for (const b of this.balances(copy)) { b.remaining--; b[copy.state === 'known' ? 'consumedKnown' : 'consumedUnknown']++; }
      }
      this.assertInvariant();
      // A checkpoint cannot omit reservations to regain budget.
      for (const [actual, saved] of [[this.#logical, restored.logical], [this.#http, restored.http], ...Object.keys(phaseKeys).map(p => [this.#phases[p as Phase], restored.phases[p as Phase]])] as [Balance, Balance][]) {
        assert(actual.limit === saved.limit && actual.remaining === saved.remaining && actual.consumedKnown === saved.consumedKnown && actual.consumedUnknown === saved.consumedUnknown + saved.activeReserved, 'restored budget accounting mismatch');
      }
    }
  }
  get elapsedMs(): number { return this.#priorElapsed + Date.now() - this.#start; }
  get deadlineReached(): boolean { return this.elapsedMs >= this.config.wallTimeSeconds * 1000; }
  remaining(phase: Phase): number { return Math.min(this.#logical.remaining, this.#phases[phase].remaining); }
  canReserve(phase: Phase, count = 1): boolean { return !this.deadlineReached && this.remaining(phase) >= count; }
  reserve(phase: Phase, kind: 'logical' | 'http', id: string = randomUUID()): Reservation {
    if (this.deadlineReached) throw new FuzzError('DEADLINE', 'campaign deadline reached');
    assert(!this.#reservations.has(id), 'reservation ID already used');
    const entry: Reservation = { id, phase, kind, state: 'reserved' };
    const balances = this.balances(entry);
    if (balances.some(b => b.remaining < 1)) throw new FuzzError('BUDGET', `${kind} budget exhausted`);
    for (const b of balances) { b.remaining--; b.activeReserved++; }
    this.#reservations.set(id, entry); this.assertInvariant(); return structuredClone(entry);
  }
  dispatch(id: string): void {
    const entry = this.entry(id); assert(entry.state === 'reserved', 'reservation cannot dispatch twice'); entry.state = 'dispatched';
  }
  settle(id: string, result: 'known' | 'unknown'): void {
    const entry = this.entry(id); assert(entry.state === 'reserved' || entry.state === 'dispatched', 'reservation is already settled');
    for (const b of this.balances(entry)) { b.activeReserved--; b[result === 'known' ? 'consumedKnown' : 'consumedUnknown']++; }
    entry.state = result; this.assertInvariant();
  }
  release(id: string): void {
    const entry = this.entry(id); assert(entry.state === 'reserved', 'dispatched work cannot be refunded');
    for (const b of this.balances(entry)) { b.activeReserved--; b.remaining++; }
    entry.state = 'released'; this.assertInvariant();
  }
  snapshot(): BudgetSnapshot { return structuredClone({ version: 1, lineageBudgetId: this.lineageBudgetId, config: this.config, elapsedMs: this.elapsedMs, logical: this.#logical, http: this.#http, phases: this.#phases, reservations: [...this.#reservations.values()] }); }
  private entry(id: string): Reservation { const entry = this.#reservations.get(id); assert(entry, 'unknown reservation'); return entry; }
  private balances(entry: Reservation): Balance[] { return entry.kind === 'http' ? [this.#http] : [this.#logical, this.#phases[entry.phase]]; }
  private assertInvariant(): void {
    for (const b of [this.#logical, this.#http, ...Object.values(this.#phases)]) assert(Object.values(b).every(v => Number.isSafeInteger(v) && v >= 0) && b.limit === b.activeReserved + b.consumedKnown + b.consumedUnknown + b.remaining, 'budget ledger invariant violated');
  }
}
