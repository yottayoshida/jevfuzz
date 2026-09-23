import { MAX_JSON_BYTES } from './storage.ts';
import { validateFinding } from './artifacts-v2.ts';
import { assert, record } from './util.ts';
import { validateReportArtifact } from './report-validator.ts';

const escape = (value: unknown) => String(value).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]!));
const kinds = new Set(['finding', 'shrink', 'campaign', 'check', 'replay', 'experiment-report', 'corpus']);
function checked(raw: unknown): Record<string, unknown> {
  // Runtime reports contain optional undefined properties and shared evidence
  // objects. Normalize like JSON persistence while still bounding the traversal
  // before serialization; a shared value is valid, an ancestor cycle is not.
  const ancestors = new Set<object>(); let nodes = 0, bytes = 0;
  const visit = (value: unknown, depth: number): unknown => {
    assert(++nodes <= 20_000 && depth <= 32, 'report structural limit exceeded');
    if (value && typeof value === 'object') {
      assert(!ancestors.has(value), 'report must not contain cycles'); ancestors.add(value);
      const result = Array.isArray(value) ? value.map(v => visit(v === undefined ? null : v, depth + 1))
        : Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined).map(([k, v]) => {
          bytes += Buffer.byteLength(k); assert(bytes <= MAX_JSON_BYTES, 'report byte limit exceeded');
          return [k, visit(v, depth + 1)];
        }));
      ancestors.delete(value); return result;
    }
    assert(value === null || typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value)), 'invalid report value');
    bytes += typeof value === 'string' ? Buffer.byteLength(value) : 8;
    assert(bytes <= MAX_JSON_BYTES, 'report byte limit exceeded'); return value;
  };
  const value = visit(raw, 0);
  assert(record(value) && value.version === 2 && typeof value.kind === 'string' && kinds.has(value.kind), 'unsupported report artifact');
  validateReportArtifact(value); return value;
}
function candidateFor(value: Record<string, unknown>): Record<string, unknown> | undefined { if (value.kind === 'finding') { validateFinding(value); return value.candidate as Record<string, unknown>; } if (value.kind === 'shrink' && record(value.finding)) { validateFinding(value.finding); return value.finding.candidate as Record<string, unknown>; } return undefined; }
function payload(candidate: Record<string, unknown> | undefined, key: string): string { return candidate && typeof candidate[key] === 'string' ? candidate[key] as string : 'Payload unavailable (redacted or hash-only).'; }
function lines(before: string, after: string): string { const a=before.split('\n'), b=after.split('\n'), size=Math.max(a.length,b.length); return Array.from({length:size},(_,i)=>a[i]===b[i]?`  ${a[i]??''}`:`- ${a[i]??''}\n+ ${b[i]??''}`).join('\n'); }
function number(value: unknown): string { return typeof value === 'number' && Number.isFinite(value) ? String(value) : 'n/a'; }
function balance(value: unknown): string {
  if (!record(value)) return 'unavailable';
  const known = typeof value.consumedKnown === 'number' ? value.consumedKnown : 0;
  const unknown = typeof value.consumedUnknown === 'number' ? value.consumedUnknown : 0;
  return `planned ${number(value.limit)}; reserved ${number(value.activeReserved)}; consumed ${known + unknown} (known ${known}, unknown ${unknown}); remaining ${number(value.remaining)}`;
}
function list(value: unknown): string { return Array.isArray(value) ? value.join(', ') : 'unavailable'; }
export function renderReportText(raw: unknown): string {
  const value=checked(raw), candidate=candidateFor(value), confirmation=record(value.confirmation)?value.confirmation:value.kind==='shrink'&&record(value.finding)&&record(value.finding.confirmation)?value.finding.confirmation:{};
  const summary=record(value.summary)?value.summary:{}, budget=record(value.budget)?value.budget:{}, coverage=record(value.coverageProxy)?value.coverageProxy:{};
  const base=payload(candidate,'basePayload'), mutant=payload(candidate,'mutantPayload');
  const original=value.kind==='shrink'&&record(value.original)&&record(value.original.candidate)?value.original.candidate:undefined;
  const finding = value.kind === 'shrink' && record(value.finding) ? value.finding : value;
  const output = [`JevFuzz v2 ${value.kind}`, `ID: ${value.id ?? finding.id ?? value.findingId ?? 'n/a'}`,
    `Tool: ${value.toolVersion ?? 'unrecorded'}; schema: ${value.version}`,
    `Status: ${confirmation.verdict ?? value.status ?? 'unknown'}; stop: ${value.stopReason ?? confirmation.reason ?? 'n/a'}; exit: ${value.exitCode ?? 'n/a'}`,
    `Provider: ${finding.provider ?? value.provider ?? 'unrecorded'}; target: ${candidate?.targetHash ?? list(value.targetHashes)}`,
    `Requested models: ${list(value.requestedModels)}; observed models: ${list(value.observedModels ?? confirmation.observedModels)}; cohort: ${value.cohort ?? 'see observed models'}`,
    `Config: ${value.configHash ?? 'n/a'}; seed: ${value.seed ?? 'unrecorded'}; lineage: ${budget.lineageBudgetId ?? 'n/a'}`,
    `Input hashes: ${candidate ? `${candidate.baseWireHash} -> ${candidate.mutantWireHash}` : list(value.inputHashes)}`,
    `Contract hashes: ${candidate?.contractHash ?? list(value.contractHashes)}; components: ${JSON.stringify(value.componentVersions ?? {})}`,
    `Evidence: ${confirmation.evidenceLevel ?? 'n/a'}; profile: ${confirmation.profileVersion ?? 'n/a'}; reason: ${confirmation.reason ?? 'n/a'}`,
    `Samples: discovery ${number(confirmation.discoverySamples)}; formal ${number(confirmation.confirmationSamples)}; controls ${number(confirmation.controls)}`,
    `Support: ${number(confirmation.support)}; control violations: ${number(confirmation.controlViolations)}; effect: ${number(confirmation.effect)}`,
    `Statistical family: ${number(confirmation.familySize)}; adjustment: ${confirmation.adjustment ?? 'n/a'}; p-value: ${number(confirmation.pValue)}; alpha: ${number(confirmation.alpha)}`,
    `Cases: ${number(summary.cases)}; questions: ${number(summary.questions)}; contracts: ${number(summary.contracts)}`,
    `Campaign: candidates ${number(summary.candidates)}; evaluated ${number(summary.evaluated)}; findings ${Array.isArray(value.findings) ? value.findings.length : 'n/a'}; pending ${number(summary.pending)}; invalid ${number(summary.invalid)}; noops ${number(summary.noops)}; required unevaluated ${number(summary.requiredUnevaluated)}`,
    `Coverage proxy: ${coverage.name ?? 'unavailable'} ${coverage.version ?? ''}; observed ${number(coverage.observed)}; stable ${number(coverage.stable)}; denominator undefined`,
    `Budget logical: ${balance(budget.logical)}`, `Budget HTTP: ${balance(budget.http)}`,
    ...Object.entries(record(budget.phases) ? budget.phases : {}).map(([phase, used]) => `Budget ${phase}: ${balance(used)}`),
    `Elapsed: ${number(budget.elapsedMs)} ms; token usage: ${JSON.stringify(value.usage ?? null)}; estimated cost: ${value.estimatedCost ?? 'unknown'}`,
    `Persistence: ${value.persistenceMode ?? finding.replayability ?? 'unrecorded'}; replayable: ${value.replayable ?? Boolean(candidate)}`,
    `Assumptions: ${Array.isArray(confirmation.assumptions) ? confirmation.assumptions.join('; ') : 'none'}`,
    `Warnings: ${Array.isArray(value.warnings) ? value.warnings.join('; ') : 'none'}`];
  if (candidate) {
    const contract = record(finding.contract) ? finding.contract : {};
    output.push(`Contract: ${contract.id}; question: ${contract.question}; relation: ${contract.relation}; projection: ${contract.projection}; admissibility: ${contract.admissibility}`,
      `Contract assumptions: ${list(contract.assumptions)}`, `Recipe: ${JSON.stringify(candidate.recipe)}`, `Question map: ${JSON.stringify(candidate.questionMap)}; label maps: ${JSON.stringify(candidate.labelMaps)}`);
    const first = Array.isArray(confirmation.blocks) && record(confirmation.blocks[0]) ? confirmation.blocks[0] : undefined;
    if (first) {
      const before = record(first.a) && record(first.a.response) ? first.a.response.answers : undefined;
      const after = record(first.b) && record(first.b.response) ? first.b.response.answers : undefined;
      const relation = record(first.violation) ? first.violation : {};
      output.push(`First fresh block answers: ${JSON.stringify(before)} -> ${JSON.stringify(after)}`,
        `${contract.projection === 'policy' ? 'Action' : 'Projected answer'}: ${relation.before ?? 'unknown'} -> ${relation.after ?? 'unknown'}; relation: ${relation.status}`);
    }
  }
  if (Array.isArray(value.results)) for (const row of value.results.filter(record)) {
    output.push(`Result ${row.entryId ?? row.candidateId ?? 'n/a'}: ${row.verdict ?? 'discovery'} ${row.reason ?? ''}`);
    if (Array.isArray(row.relations)) for (const relation of row.relations.filter(record)) {
      const formal = record(relation.confirmation) ? relation.confirmation : {}, discovery = record(relation.discovery) ? relation.discovery : {};
      output.push(`  ${relation.contractId}: ${formal.verdict ?? discovery.status}; reason ${formal.reason ?? list(discovery.reasons)}; pending ${relation.pending}`);
    }
  }
  if (value.kind === 'check') output.push(`Regression: total ${value.total}; required ${value.required}; excluded ${value.excluded}; quarantined ${value.quarantined}; expired ${value.expired}`);
  if (value.kind === 'experiment-report' && Array.isArray(value.cases)) for (const item of value.cases.filter(record)) output.push(`Comparison ${item.id}: ${item.status}; old ${JSON.stringify(item.old)}; new ${JSON.stringify(item.new)}`);
  output.push(`Replay: ${candidate ? 'jevfuzz replay <finding-file.json> --out <replay-result.json>' : 'not available for this artifact'}`,
    'Corpus: jevfuzz corpus add <finding-file.json> --corpus <corpus-directory>', `Shrink: ${value.kind === 'shrink' ? value.status : 'n/a'}; original complexity: ${list(value.originalComplexity)}; final complexity: ${list(value.finalComplexity)}; accepted: ${number(value.accepted)}`,
    value.kind === 'shrink' && original ? `Shrink diff:\n${lines(payload(original, 'mutantPayload'), mutant)}` : `Diff:\n${lines(base, mutant)}`);
  return output.join('\n');
}
export function renderReportHtml(raw: unknown): string { const text=renderReportText(raw); return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>JevFuzz report</title><style>body{font-family:ui-monospace,monospace;max-width:100ch;margin:2rem auto;white-space:pre-wrap}pre{overflow:auto}</style></head><body><h1>JevFuzz v2 report</h1><pre>${escape(text)}</pre></body></html>`; }
