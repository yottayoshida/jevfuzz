import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';
import { addToCorpus, checkCorpus, initializeCorpus, inspectCorpus, triageCorpus } from '../src/corpus/index.ts';
import { readJson, writePrivate } from '../src/storage.ts';
import { ExecutionJournal } from '../src/engine/journal.ts';
import { buildCandidate } from '../src/mutators/index.ts';
import { confirmCandidate, createFinding } from '../src/oracles/index.ts';
import { FakeProvider } from '../src/provider.ts';
import type { Contract, Finding, Observation, Phase } from '../src/campaign-types.ts';
import type { JevResponse } from '../src/types.ts';

const root = await mkdtemp(join(tmpdir(), 'jevfuzz-corpus-'));
after(() => rm(root, { recursive: true, force: true }));
const contract: Contract = { id: 'route', question: 'route', relation: 'invariant', projection: 'choice', mutations: ['question_id_rename'], admissibility: 'structural', assumptions: [], required: true };
const oracle = { profile: 'paired-v1' as const, pairs: 1, minimumSupport: 1, maxControlViolationRate: 0, minimumEffect: 0, alpha: .05, originalSlots: 0, shrinkSlots: 0 };
function provider(model = 'sim') { return new FakeProvider((request) => { const id = Object.keys(request.questions)[0]!, choice = id === 'route' ? 'billing' : 'general'; return { model, answers: { [id]: { type: 'choice', choice, probabilities: { billing: choice === 'billing' ? 1 : 0, general: choice === 'general' ? 1 : 0 }, confidence: 1 } }, usage: { input_tokens: 0, output_tokens: 0 } }; }); }
async function finding(): Promise<Finding> { const seed = { id: 's', mutations: { builtin: true, unorderedArrays: [], irrelevantFields: [], prosePaths: [] }, request: { model: 'jev-latest', state: {}, questions: { route: { type: 'choice' as const, instructions: 'x', criteria: { billing: 'b', general: 'g' } } } } }; const candidate = buildCandidate(seed, [{ operator: 'question_id_rename', version: '1', admissibility: 'structural', renames: { route: 'r' }, reads: [], writes: [], requires: [], invalidates: [] }], [contract]); let n=0; const execute={modelChanged:false,async evaluate(payload:string,phase:Phase):Promise<Observation>{const request=JSON.parse(payload), id=Object.keys(request.questions)[0]!, choice=id==='route'?'billing':'general', response:JevResponse={model:'sim',answers:{[id]:{type:'choice',choice,probabilities:{billing:choice==='billing'?1:0,general:choice==='general'?1:0},confidence:1}},usage:{input_tokens:0,output_tokens:0}};n++;return{id:`o${n}`,operationId:`p${n}`,phase,wireHash:createHash('sha256').update(payload).digest('hex'),response,provider:'fake',observedModel:'sim',cache:'fresh'};}}; const signature='["relation-v1","route","route","invariant","choice","label","billing","general"]'; const confirmation=await confirmCandidate(candidate,contract,execute,oracle,{signature,seed:1}); return createFinding(candidate,contract,oracle,confirmation,{provider:'custom',reducers:{independentQuestions:false,optionalStatePaths:[],unorderedArrayPaths:[],prosePaths:[]}}); }

test('immutable add dedupes exact evidence before journaling and rejects quota changes', async () => { await mkdir(root,{recursive:true,mode:0o700}); const value=await finding(), id=await addToCorpus(value,root,{maxBytes:1_000_000}); assert.equal(await addToCorpus(value,root),id); await assert.rejects(addToCorpus(value,root,{maxBytes:1}),/limit mismatch/); const index=await inspectCorpus(root); assert.equal(index.entries.length,1); assert.equal(index.entries[0]!.evidence.length,1); });
test('initialization persists a versioned quota manifest and cannot silently change it', async () => { const directory=join(root,'manifest'); await initializeCorpus(directory,100_000); assert.deepEqual(await readJson(join(directory,'corpus.json')),{version:2,kind:'corpus-storage',maxBytes:100_000}); await assert.rejects(initializeCorpus(directory,100_001),/limit mismatch/); });
test('inspection rejects malformed durable triage fields', async () => { const directory=join(root,'malformed-triage'), id=await addToCorpus(await finding(),directory); const journal=await ExecutionJournal.resume(join(directory,'triage.jsonl')); try { await journal.append('triaged',{id,triage:{status:'quarantined',actor:'a',reason:'r',timestamp:'not-a-date'}}); } finally { await journal.close(); } await assert.rejects(inspectCorpus(directory),/triage|quarantine/i); });
test('quarantine excludes before expiry and expired quarantine is required again', async () => { const value=await finding(), id=await addToCorpus(value,root); await triageCorpus(root,id,'quarantined',{actor:'a',reason:'r',expiresAt:'2000-01-01T00:00:00.000Z',reevaluate:'fresh'}); const index=await inspectCorpus(root); assert.equal(index.entries[0]!.triage.status,'quarantined'); const report=await checkCorpus(root,provider(),{oracle,now:'2001-01-01T00:00:00.000Z'}); assert.equal(report.expired,1); assert.ok(report.results.length===1); });
test('fixed-stat slot preflight makes no provider calls', async () => { const directory=join(root,'fixed-slots'), id=await addToCorpus(await finding(),directory); await triageCorpus(directory,id,'accepted_regression',{actor:'a',reason:'accepted'}); let calls=0; const source=new FakeProvider(request => { calls++; const id=Object.keys(request.questions)[0]!, choice=id==='route'?'billing':'general'; return {model:'sim',answers:{[id]:{type:'choice',choice,probabilities:{billing:choice==='billing'?1:0,general:choice==='general'?1:0},confidence:1}},usage:{input_tokens:0,output_tokens:0}}; }); await assert.rejects(checkCorpus(directory,source,{oracle:{...oracle,profile:'fixed-stat-v1',originalSlots:0,shrinkSlots:0}}),/reserved slot/); assert.equal(calls,0); });
test('empty corpus is incomplete exit three', async () => { const empty=join(root,'empty'); await mkdir(empty,{recursive:true,mode:0o700}); const report=await checkCorpus(empty,provider()); assert.equal(report.exitCode,3); assert.equal(report.total,0); });
test('foreign provider corpus check rejects before calls or journal creation', async () => {
  const directory=join(root,'foreign-provider'), id=await addToCorpus(await finding(),directory);
  await triageCorpus(directory,id,'accepted_regression',{actor:'a',reason:'reviewed'});
  const before=await readdir(directory); let calls=0;
  await assert.rejects(checkCorpus(directory,new FakeProvider(()=>{calls++;throw new Error('must not dispatch');}),{providerName:'cloudflare',oracle}),/provider identity/);
  assert.equal(calls,0); assert.deepEqual(await readdir(directory),before);
});
test('orphaned immutable evidence is reused without a second quota charge', async () => {
  const directory=join(root,'orphan-recovery'), value=await finding(), text=JSON.stringify(value), bytes=Buffer.byteLength(text);
  await initializeCorpus(directory,bytes+5000);
  const object=createHash('sha256').update(text).digest('hex'); await writePrivate(join(directory,'objects',object+'.json'),text);
  const id=await addToCorpus(value,directory);
  assert.equal((await inspectCorpus(directory)).entries[0]!.id,id);
  assert.equal(await readFile(join(directory,'objects',object+'.json'),'utf8'),text);
});

test('new evidence requires explicit acceptance and invalid triage never appends', async () => {
  const directory=join(root,'explicit'), id=await addToCorpus(await finding(),directory);
  assert.equal((await inspectCorpus(directory)).entries[0]!.triage.status,'confirmed');
  const excluded=await checkCorpus(directory,provider(),{oracle});
  assert.equal(excluded.required,0); assert.equal(excluded.exitCode,3);
  const before=await readFile(join(directory,'triage.jsonl'),'utf8');
  await assert.rejects(triageCorpus(directory,id,'accepted_regression',{actor:'a',reason:'r',expiresAt:'2000-01-01T00:00:00.000Z',reevaluate:'fresh'}),/quarantine/);
  await assert.rejects(triageCorpus(directory,id,'quarantined',{actor:'a',reason:'r',expiresAt:'2000-01-01T00:00:00.000Z',reevaluate:'x'.repeat(4097)}),/quarantine/);
  assert.equal(await readFile(join(directory,'triage.jsonl'),'utf8'),before);
  await triageCorpus(directory,id,'accepted_regression',{actor:'a',reason:'reviewed'});
  assert.equal((await checkCorpus(directory,provider(),{oracle})).required,1);
});

test('aggregate corpus quota covers repeated triage, check journals and reports before dispatch', async () => {
  const directory=join(root,'aggregate-quota'), limit=50_000, id=await addToCorpus(await finding(),directory,{maxBytes:limit});
  await triageCorpus(directory,id,'accepted_regression',{actor:'a',reason:'reviewed'});
  const bytes=async (folder:string):Promise<number> => {
    let total=0;
    for(const entry of await readdir(folder,{withFileTypes:true})) {
      const path=join(folder,entry.name);
      total+=entry.isDirectory()?await bytes(path):(await stat(path)).size;
    }
    return total;
  };
  let previous=await bytes(directory);
  for(let i=0;i<2;i++) {
    await triageCorpus(directory,id,'accepted_regression',{actor:'a',reason:`review ${i}`});
    await checkCorpus(directory,provider(),{oracle});
    const current=await bytes(directory); assert.ok(current>previous && current<=limit); previous=current;
  }
  // Fill only the remaining persistent quota; a reservation must fail before evaluation.
  await writeFile(join(directory,'retained-evidence.bin'),Buffer.alloc(limit-previous),{mode:0o600});
  let calls=0;
  const forbidden=new FakeProvider(()=>{calls++; throw new Error('must not dispatch');});
  await assert.rejects(checkCorpus(directory,forbidden,{oracle}),/byte limit/);
  assert.equal(calls,0); assert.equal(await bytes(directory),limit);
  assert.equal((await inspectCorpus(directory)).entries[0]!.triage.status,'accepted_regression');
});
