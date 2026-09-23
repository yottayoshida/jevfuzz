import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../src/cli/main.ts';
import { FakeProvider } from '../src/provider.ts';
import { resumeCampaign } from '../src/engine/campaign.ts';
import { decodeJournal } from '../src/engine/journal.ts';

test('hard-killed dispatcher recovers its stale lock through CLI without reviving spent budget', { timeout: 20_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'jevfuzz-hard-crash-'));
  const moduleUrl = (path: string) => new URL(path, import.meta.url).href;
  const child = spawn(process.execPath, ['--input-type=module', '--eval', `
    import { loadCampaign } from ${JSON.stringify(moduleUrl('../src/campaign-config.ts'))};
    import { campaign } from ${JSON.stringify(moduleUrl('../src/engine/campaign.ts'))};
    import { FakeProvider } from ${JSON.stringify(moduleUrl('../src/provider.ts'))};
    const config = await loadCampaign(${JSON.stringify(new URL('../fixtures/v2/routing.campaign.json', import.meta.url).pathname)});
    config.storage.directory = ${JSON.stringify(root)}; config.search.maxCandidates = 4;
    config.search.batchSize = 1; config.search.concurrency = 1;
    await campaign(config, new FakeProvider(() => {
      process.stdout.write('dispatched' + String.fromCharCode(10));
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
      throw new Error('unreachable');
    }));
  `], { stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    let stderr = ''; child.stderr.on('data', bytes => { stderr += String(bytes); });
    const dispatched = await Promise.race([once(child.stdout, 'data').then(([bytes]) => String(bytes)), once(child, 'exit').then(() => { throw new Error(stderr || 'child exited before dispatch'); })]);
    assert.match(dispatched, /dispatched/);
    const ended = once(child, 'exit'); child.kill('SIGKILL'); await ended;
    const lock = JSON.parse(await readFile(join(root, '.writer.lock'), 'utf8')); assert.equal(lock.pid, child.pid);
    const run = (await readdir(join(root, 'runs')))[0]!, checkpoint = join(root, 'runs', run, 'checkpoint.json');
    let error = '';
    assert.equal(await main(['recover-lock', root, '--json'], { env: {}, stdout: () => {}, stderr: text => { error += text; } }), 0, error);
    const resumed = await resumeCampaign(checkpoint, new FakeProvider());
    assert.equal(resumed.exitCode, 3); assert.equal(resumed.budget.logical.consumedUnknown, 1);
    assert.equal(resumed.budget.logical.limit, resumed.budget.logical.remaining + resumed.budget.logical.consumedKnown + resumed.budget.logical.consumedUnknown);
  } finally { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await rm(root, { recursive: true, force: true }); }
});

test('hard kill around terminal durability never exposes a premature report and resumes without calls', {timeout:20_000}, async()=>{
  for(const position of ['before','after']) {
    const root=await mkdtemp(join(tmpdir(),'jevfuzz-publication-crash-'));
    const moduleUrl=(path:string)=>new URL(path,import.meta.url).href;
    const child=spawn(process.execPath,['--input-type=module','--eval',`
      import {loadCampaign} from ${JSON.stringify(moduleUrl('../src/campaign-config.ts'))};
      import {campaign} from ${JSON.stringify(moduleUrl('../src/engine/campaign.ts'))};
      import {ExecutionJournal} from ${JSON.stringify(moduleUrl('../src/engine/journal.ts'))};
      import {FakeProvider} from ${JSON.stringify(moduleUrl('../src/provider.ts'))};
      const original=ExecutionJournal.prototype.append;
      ExecutionJournal.prototype.append=async function(type,data){
        if(type!=='campaign-finished')return original.call(this,type,data);
        if(${JSON.stringify(position)}==='after')await original.call(this,type,data);
        process.stdout.write('publication-boundary'+String.fromCharCode(10));
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);
      };
      const config=await loadCampaign(${JSON.stringify(new URL('../fixtures/v2/routing.campaign.json',import.meta.url).pathname)});
      config.storage.directory=${JSON.stringify(root)};config.search.maxCandidates=1;config.oracle.pairs=1;
      await campaign(config,new FakeProvider());
    `],{stdio:['ignore','pipe','pipe']});
    try {
      let error='';child.stderr.on('data',bytes=>{error+=String(bytes);});
      await Promise.race([once(child.stdout,'data'),once(child,'exit').then(()=>{throw new Error(error||'child exited too soon');})]);
      const ended=once(child,'exit');child.kill('SIGKILL');await ended;
      const run=(await readdir(join(root,'runs')))[0]!,directory=join(root,'runs',run);
      await assert.rejects(readFile(join(directory,'report.json')),/ENOENT/);
      await assert.rejects(readFile(join(directory,'report.txt')),/ENOENT/);
      const records=decodeJournal(await readFile(join(directory,'events.jsonl'),'utf8')).records;
      assert.equal(records.some(row=>row.type==='campaign-finished'),position==='after');
      assert.equal(await main(['recover-lock',root],{env:{},stdout:()=>{},stderr:()=>{}}),0);
      let calls=0;
      const resumed=await resumeCampaign(join(directory,'checkpoint.json'),new FakeProvider(()=>{calls++;throw new Error('must reuse durable evidence');}));
      assert.equal(calls,0);assert.equal(resumed.status,'complete');
      assert.equal(JSON.parse(await readFile(join(resumed.directory!,'report.json'),'utf8')).status,'complete');
    } finally {if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');await rm(root,{recursive:true,force:true});}
  }
});
