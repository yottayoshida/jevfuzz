/** Offline, preregistered directed-contrast power and assumption stress measurements. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildCandidate } from '../src/mutators/index.ts';
import { confirmCandidate, HypothesisSlots } from '../src/oracles/index.ts';
import { EvaluationBroker } from '../src/engine/broker.ts';
import { BudgetLedger } from '../src/engine/budget.ts';
import { FakeProvider } from '../src/provider.ts';
import { rng } from '../src/util.ts';
import type { Contract, OracleConfig, Phase } from '../src/campaign-types.ts';

const root = join(import.meta.dirname, '..');
const contract: Contract = { id:'power', question:'route', relation:'invariant', projection:'choice', mutations:['question_id_rename'], admissibility:'structural', assumptions:[], required:true };
const seed = { id:'power', request:{model:'power-sim',state:{},questions:{route:{type:'choice' as const,instructions:'Route',criteria:{billing:'billing',general:'general'}}}}, mutations:{builtin:true,unorderedArrays:[],irrelevantFields:[],prosePaths:[]} };
const candidate = buildCandidate(seed,[{operator:'question_id_rename',version:'1',admissibility:'structural',renames:{route:'renamed'},reads:[],writes:[],requires:[],invalidates:[]}],[contract]);
// Fixed before discovery and all formal samples: never select the favorable tail afterward.
const signature = JSON.stringify(['relation-v1','power','route','invariant','choice','label','billing','general']);
const profile: OracleConfig = {profile:'fixed-stat-v1',pairs:64,minimumSupport:.75,maxControlViolationRate:.125,minimumEffect:0,alpha:.05,originalSlots:5,shrinkSlots:5};
type Condition = {name:string;effect:number;noise:number;correlation:number;fault?:'cached'|'unknown'|'transport'|'drift'|'model-switch'|'rate-limit-schedule'};
const conditions:Condition[] = [];
for(const noise of [0,.1,.3]) for(const effect of [0,.1,.3,.6]) conditions.push({name:`independent-noise-${noise}-effect-${effect}`,noise,effect,correlation:0});
for(const correlation of [.5,.9]) for(const effect of [0,.3]) conditions.push({name:`correlated-${correlation}-effect-${effect}`,noise:.2,effect,correlation});
for(const fault of ['cached','unknown','transport','drift','model-switch','rate-limit-schedule'] as const) {
  const metadata=['cached','unknown','transport'].includes(fault);
  conditions.push({name:`assumption-${fault}`,noise:metadata?0:.2,effect:metadata?1:0,correlation:0,fault});
}
const trials:{condition:string;seed:number;verdict:string;reason:string;logicalCalls:number;formalCalls:number;controls:number;httpAttempts:number;observedModels:string[];discoveryChoices:string[];virtualElapsedSteps:number;simulatedBackoffs:number}[]=[];
for(const condition of conditions) for(let seedIndex=0;seedIndex<100;seedIndex++) {
  const random=rng(0x501900+seedIndex); let previous=random(), virtualElapsedSteps=0, simulatedBackoffs=0;
  const source=new FakeProvider((request,index)=>{
    const id=Object.keys(request.questions)[0]!, mutant=id==='renamed';
    virtualElapsedSteps++;
    if(condition.fault==='rate-limit-schedule' && mutant) {virtualElapsedSteps+=5;simulatedBackoffs++;}
    if(random()>=condition.correlation) previous=random();
    const probability=condition.fault==='rate-limit-schedule' ? .5+.4*Math.sin(virtualElapsedSteps/10) : condition.fault==='drift' ? .1+.8*Math.min(1,index/193) : Math.min(1,condition.noise+(mutant?condition.effect:0));
    const choice=previous<probability?'general':'billing';
    return {model:condition.fault==='model-switch' && index>=50?'power-sim-v2':'power-sim-v1',answers:{[id]:{type:'choice',choice,confidence:1,probabilities:{billing:choice==='billing'?1:0,general:choice==='general'?1:0}}},usage:{input_tokens:0,output_tokens:0}};
  });
  const ledger=new BudgetLedger({logicalRequests:194,httpAttempts:0,wallTimeSeconds:60,discoveryRequests:2,confirmationRequests:192,shrinkRequests:0,finalConfirmationRequests:0});
  const broker=new EvaluationBroker(source,ledger,{strict:true,providerName:'power-simulator'});
  const a=await broker.evaluate(candidate.basePayload,'discovery'), b=await broker.evaluate(candidate.mutantPayload,'discovery');
  // Fault injection changes only metadata returned to the production oracle.
  // There is no live transport, retry, or independence claim for these scenarios.
  const executor={get modelChanged(){return broker.modelChanged;},async evaluate(payload:string,phase:Phase,operationId?:string){
    const observation=await broker.evaluate(payload,phase,operationId);
    return {...observation,...(condition.fault==='cached'?{cache:'cached' as const}:condition.fault==='unknown'?{cache:'unknown' as const}:{}),...(condition.fault==='transport'?{transportUncertain:true}:{})};
  }};
  const result=await confirmCandidate(candidate,contract,executor,profile,{signature,seed:seedIndex,ledger,slots:new HypothesisSlots(profile),discoverySamples:2});
  const snapshot=ledger.snapshot();
  trials.push({condition:condition.name,seed:seedIndex,verdict:result.verdict,reason:result.reason,logicalCalls:snapshot.logical.consumedKnown+snapshot.logical.consumedUnknown,formalCalls:result.confirmationSamples,controls:result.controls,httpAttempts:snapshot.http.consumedKnown+snapshot.http.consumedUnknown,observedModels:broker.observedModels,virtualElapsedSteps,simulatedBackoffs,discoveryChoices:[String(a.response.answers.route && 'choice' in a.response.answers.route?a.response.answers.route.choice:''),String(b.response.answers.renamed && 'choice' in b.response.answers.renamed?b.response.answers.renamed.choice:'')]});
  assert.equal(snapshot.http.consumedKnown+snapshot.http.consumedUnknown,0);
  assert.ok(result.confirmationSamples<=192 && snapshot.logical.consumedKnown<=194);
  if(['cached','unknown','transport','model-switch'].includes(condition.fault??'')) assert.equal(result.verdict,'INCONCLUSIVE',condition.name);
}
const groups=conditions.map(condition=>{
  const rows=trials.filter(row=>row.condition===condition.name);
  return {...condition,trials:rows.length,confirmed:rows.filter(row=>row.verdict==='FAIL').length,noConfirmedViolation:rows.filter(row=>row.verdict==='NO_CONFIRMED_VIOLATION').length,inconclusive:rows.filter(row=>row.verdict==='INCONCLUSIVE').length,powerOrFalseDetectionRate:rows.filter(row=>row.verdict==='FAIL').length/rows.length,meanLogicalCalls:rows.reduce((n,row)=>n+row.logicalCalls,0)/rows.length,meanFormalCalls:rows.reduce((n,row)=>n+row.formalCalls,0)/rows.length,meanControls:rows.reduce((n,row)=>n+row.controls,0)/rows.length,independenceClaim:condition.correlation===0&&!condition.fault?'controlled independent simulator only':'none; assumption stress'};
});
const hash=(text:string)=>createHash('sha256').update(text).digest('hex');
const productionPaths=(await readdir(join(root,'src'),{recursive:true})).filter(path=>path.endsWith('.ts')).map(path=>`src/${path}`).sort();
const sources=Object.fromEntries(await Promise.all(['scripts/benchmark-v09-power.ts',...productionPaths].map(async path=>[path,hash(await readFile(join(root,path),'utf8'))])));
const result={version:1,kind:'jevfuzz-power-supplement',evidence:'offline-synthetic',runtime:process.version,profile,signature,selection:'a-priori directed contrast; discovery never selects a formal signature',seeds:100,totalTrials:trials.length,sources,groups,trials,limitations:['Per-slot descriptive power with alpha/10, not a second family-wise calibration experiment.','100 fixed seeds per condition; no seed searching or aggregate power threshold.','Correlation and drift violate assumptions; rates are descriptive and do not transfer to live providers.','Transport stress injects uncertainty metadata. Rate-limit scheduling uses a virtual clock: mutant backoffs advance time by five steps and responses depend on time alone; no real HTTP retry timing is claimed.','No live HTTP request or external workload evidence.']};
await mkdir(join(root,'fixtures/benchmarks'),{recursive:true});
await writeFile(join(root,'fixtures/benchmarks/power-v09.json'),JSON.stringify(result,null,2));
console.log(JSON.stringify({trials:trials.length,conditions:conditions.length,httpAttempts:0,groups},null,2));
