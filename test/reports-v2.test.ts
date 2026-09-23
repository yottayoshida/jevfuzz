import assert from 'node:assert/strict';
import test from 'node:test';
import { renderReportHtml, renderReportText } from '../src/reports-v2.ts';
import { buildCandidate } from '../src/mutators/index.ts';
import { confirmCandidate, createFinding } from '../src/oracles/index.ts';
import { evaluateRelation } from '../src/contracts/index.ts';
import type { Contract, Observation, Phase } from '../src/campaign-types.ts';
import type { JevResponse } from '../src/types.ts';
import { loadCampaign } from '../src/campaign-config.ts';
import { campaign } from '../src/engine/campaign.ts';
import { FakeProvider } from '../src/provider.ts';
async function sampleReport() { const config = await loadCampaign('fixtures/v2/routing.campaign.json'); config.search.maxCandidates = 2; return campaign(config, new FakeProvider(), { persist: false }); }
test('offline HTML escapes hostile report content, has CSP, and rejects unknown payload fields', async () => {
  const report = await sampleReport(); report.warnings = ['<script>alert(1)</script>', '<img src=x>', '[x](javascript:bad)'];
  const html = renderReportHtml(report); assert.match(html, /Content-Security-Policy/); assert.equal(html.includes('<script>alert'), false); assert.equal(html.includes('<img src=x>'), false); assert.equal(html.includes('href='), false);
  assert.throws(() => renderReportHtml({ ...report, candidate: { basePayload: 'unvalidated payload' } }), /invalid v2 report/);
});
test('text includes evidence and nonreplayable payload notice', async () => { const text = renderReportText(await sampleReport()); assert.match(text, /Payload unavailable/); assert.match(text, /Samples/); });
test('rejects malformed and excessive artifacts',()=>{assert.throws(()=>renderReportText({version:1,kind:'check'}));let value:any={};let node=value;for(let i=0;i<40;i++)node=node.a={};assert.throws(()=>renderReportHtml({version:2,kind:'check',x:value}));});
test('campaign text exposes actual consumption, pending coverage and completion boundaries', async () => {
  const balance = { limit: 10, activeReserved: 1, consumedKnown: 3, consumedUnknown: 2, remaining: 4 };
  const report = await sampleReport(); report.provider = 'cloudflare'; report.stopReason = 'budget_exhausted'; report.exitCode = 3;
  report.budget.logical = balance; report.budget.http = balance; report.budget.phases.discovery = balance; report.budget.lineageBudgetId = 'lineage'; report.budget.elapsedMs = 125;
  Object.assign(report.summary, { pending: 4, invalid: 2, noops: 3, requiredUnevaluated: 1 });
  const text = renderReportText(report);
  assert.match(text, /Budget logical: planned 10; reserved 1; consumed 5 \(known 3, unknown 2\); remaining 4/);
  assert.match(text, /Budget discovery: planned 10/); assert.match(text, /pending 4; invalid 2; noops 3; required unevaluated 1/);
  assert.match(text, /stop: budget_exhausted; exit: 3/); assert.match(text, /Provider: cloudflare; target: [a-f0-9]{64}/);
  assert.match(text, /lineage: lineage/); assert.match(text, /Elapsed: 125 ms/);
});

test('validated full findings may display escaped hostile payload bytes', async () => {
  const contract: Contract={id:'route',question:'route',relation:'invariant',projection:'choice',mutations:['question_id_rename'],admissibility:'structural',assumptions:[],required:true};
  const candidate=buildCandidate({id:'s',mutations:{builtin:true,unorderedArrays:[],irrelevantFields:[],prosePaths:[]},request:{model:'fake',state:{},questions:{route:{type:'choice',instructions:'<script>alert(1)</script>',criteria:{yes:'yes',no:'no'}}}}},[{operator:'question_id_rename',version:'1',admissibility:'structural',renames:{route:'r'},reads:[],writes:[],requires:[],invalidates:[]}],[contract],undefined,'custom'); let n=0;
  const executor={modelChanged:false,async evaluate(payload:string,phase:Phase):Promise<Observation>{const id=Object.keys(JSON.parse(payload).questions)[0]!;const response:JevResponse={model:'fake',answers:{[id]:{type:'choice',choice:id==='route'?'yes':'no',confidence:1,probabilities:{yes:id==='route'?1:0,no:id==='route'?0:1}}},usage:{input_tokens:0,output_tokens:0}};n++;return{id:`o${n}`,operationId:`p${n}`,phase,wireHash:payload===candidate.basePayload?candidate.baseWireHash:candidate.mutantWireHash,response,provider:'fake',observedModel:'fake',cache:'fresh'};}};
  const a=await executor.evaluate(candidate.basePayload,'discovery'),b=await executor.evaluate(candidate.mutantPayload,'discovery'),oracle={profile:'paired-v1' as const,pairs:1,minimumSupport:1,maxControlViolationRate:0,minimumEffect:0,alpha:.05,originalSlots:0,shrinkSlots:0};
  const finding=createFinding(candidate,contract,oracle,await confirmCandidate(candidate,contract,executor,oracle,{signature:evaluateRelation(candidate,contract,a.response,b.response).signature!,seed:1}),{provider:'custom',reducers:{independentQuestions:false,optionalStatePaths:[],unorderedArrayPaths:[],prosePaths:[]}});
  const html=renderReportHtml(finding);assert.match(html,/&lt;script&gt;alert\(1\)&lt;\/script&gt;/);assert.equal(html.includes('<script>alert(1)</script>'),false);
  const campaignReport = await sampleReport();
  const replay = { version: 2, kind: 'replay' as const, status: 'complete' as const, findingId: finding.id, confirmation: finding.confirmation,
    observations: finding.confirmation.blocks.flatMap(block => [block.a, block.control, block.b]), provider: finding.provider, targetHashes: [finding.candidate.targetHash], requestedModels: ['fake'], observedModels: ['fake'], cohort: 'single' as const, budget: campaignReport.budget };
  const text = renderReportText(replay);
  assert.match(text, /Provider: custom; target: [a-f0-9]{64}/); assert.match(text, /Requested models: fake; observed models: fake; cohort: single/);
});
