import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const asset = (...parts) => resolve(root, 'docs', 'assets', ...parts);
const sha256 = value => createHash('sha256').update(value).digest('hex');
const fail = message => { throw new Error(`readme demo evidence invalid: ${message}`); };
const object = (value, label) => value !== null && typeof value === 'object' && !Array.isArray(value) ? value : fail(`${label} must be an object`);
const string = (value, label) => typeof value === 'string' ? value : fail(`${label} must be a string`);
const number = (value, label) => typeof value === 'number' && Number.isFinite(value) ? value : fail(`${label} must be a finite number`);
const list = (value, label) => Array.isArray(value) ? value : fail(`${label} must be an array`);

function sameJson(value, other, path = '$') {
  if (value === null || other === null || typeof value !== 'object' || typeof other !== 'object') {
    if (!Object.is(value, other)) fail(`payload values differ at ${path}`);
    return;
  }
  if (Array.isArray(value) || Array.isArray(other)) {
    if (!Array.isArray(value) || !Array.isArray(other) || value.length !== other.length) fail(`payload arrays differ at ${path}`);
    const values = value, others = other;
    values.forEach((item, index) => sameJson(item, others[index], `${path}[${index}]`));
    return;
  }
  const keys = Object.keys(value), otherKeys = Object.keys(other);
  if (keys.length !== otherKeys.length || [...keys].sort().some((key, index) => key !== [...otherKeys].sort()[index])) fail(`payload keys differ at ${path}`);
  if (path !== '$.state' && keys.some((key, index) => key !== otherKeys[index])) fail(`payload order differs outside $.state at ${path}`);
  for (const key of keys) sameJson(value[key], other[key], `${path}.${key}`);
}

function movedPositions(base, mutant) {
  if (base.length !== mutant.length || new Set(base).size !== base.length || new Set(mutant).size !== mutant.length || base.some(key => !mutant.includes(key))) fail('state keys do not form a reordering');
  return base.filter((key, index) => mutant[index] !== key).length;
}

function candidatePayloads(finding, label) {
  const candidate = object(finding.candidate, `${label}.candidate`);
  const baseText = string(candidate.basePayload, `${label}.basePayload`);
  const mutantText = string(candidate.mutantPayload, `${label}.mutantPayload`);
  const base = object(JSON.parse(baseText), `${label}.base payload`);
  const mutant = object(JSON.parse(mutantText), `${label}.mutant payload`);
  sameJson(base, mutant);
  return { base, mutant, baseText, mutantText };
}

function escapeXml(value) { return value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[char]); }

function render(data) {
  const [a, b, c] = data.baseKeys.map(escapeXml);
  const values = '{…}';
  const rows = data.baseKeys.map((key, index) => ({
    key: escapeXml(key), baseY: 118 + index * 32,
    initialOffset: (data.initialKeys.indexOf(key) - index) * 32,
    finalOffset: (data.finalKeys.indexOf(key) - index) * 32,
  }));
  const rowCss = rows.map((row, index) => `.row-${index}{transform:translateY(${row.finalOffset}px);fill:${row.finalOffset === 0 ? '#172326' : '#087b78'}}`).join('');
  const animationCss = rows.map((row, index) => `@keyframes move${index}{0%,10%{transform:translateY(0);fill:#172326}20%,48%{transform:translateY(${row.initialOffset}px);fill:#c86729}62%,90%{transform:translateY(${row.finalOffset}px);fill:${row.finalOffset === 0 ? '#172326' : '#087b78'}}100%{transform:translateY(0);fill:#172326}}`).join('');
  const rowAnimations = rows.map((_, index) => `.row-${index}{animation:move${index} 12s ease-in-out infinite}`).join('');
  const rowSvg = rows.map((row, index) => `<text x="35" y="${row.baseY}" class="mutant-row row-${index} mono" font-size="15">"${row.key}": ${values}</text>`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 960 600" role="img" aria-labelledby="title desc">
  <title id="title">JevFuzz found a decision change caused only by JSON object key order</title>
  <desc id="desc">A recorded ${escapeXml(data.provider)} ${escapeXml(data.model)} result: the same values at state keys ${escapeXml(data.baseKeys.join(', '))} produced ${escapeXml(data.question)} labels ${escapeXml(data.before)} and ${escapeXml(data.after)} after key order changed. The reduced regression moves ${data.finalMoved} key positions, confirmed in ${data.support} of ${data.support} blocks with ${data.controlChanges} of ${data.controls} controls changing.</desc>
  <style>
    :root { color-scheme: light; }
    .bg{fill:#f8f6f0}.ink{fill:#172326}.muted{fill:#607174}.teal{fill:#087b78}.orange{fill:#c86729}.line{stroke:#d7ddd8}.mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}.sans{font-family:ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.small{font-size:12px}.label{font-size:11px;font-weight:700;letter-spacing:1.4px}.heading{font-size:25px;font-weight:700;letter-spacing:-.6px}.card{fill:#fffdf8;stroke:#d7ddd8;stroke-width:1}.code{fill:#eef4f1}.divider{stroke:#cbd4d0;stroke-width:1}.chip{fill:#e3f1ee}.warning{fill:#fff0e7}.verdict{font-size:25px;font-weight:700;letter-spacing:-.5px}.mutant-row{transform-box:fill-box;transform-origin:center}${rowCss}.trial-note,.baseline-label{opacity:0}.changed-label{opacity:1}
    @media (prefers-reduced-motion:no-preference){${rowAnimations}.trial-note{animation:showTrial 12s ease-in-out infinite}.baseline-label{animation:showBaseline 12s ease-in-out infinite}.changed-label{animation:showChanged 12s ease-in-out infinite}${animationCss}@keyframes showBaseline{0%,10%{opacity:1}20%,100%{opacity:0}}@keyframes showTrial{0%,10%,62%,100%{opacity:0}20%,48%{opacity:1}}@keyframes showChanged{0%,10%{opacity:0}20%,90%{opacity:1}100%{opacity:0}}}
  </style>
  <rect class="bg" width="960" height="600" rx="18"/>
  <g class="sans"><text x="48" y="55" class="teal label">JEVFUZZ · RECORDED EMPIRICAL FINDING</text><text x="48" y="89" class="ink heading">Same values. Different decision.</text><text x="48" y="115" class="muted" font-size="14">${escapeXml(data.provider)} · ${escapeXml(data.model)} · question: ${escapeXml(data.question)} · public synthetic example</text>
  <g transform="translate(48 145)"><rect class="card" width="404" height="300" rx="12"/><rect class="code" x="1" y="1" width="402" height="42" rx="11"/><text x="22" y="27" class="ink label">ORIGINAL JSON</text><text x="382" y="27" class="muted small mono" text-anchor="end">${data.bytes.toLocaleString('en-US')} bytes</text><text x="22" y="72" class="muted small mono">$.state</text><line class="divider" x1="22" y1="86" x2="382" y2="86"/><text x="35" y="118" class="ink mono" font-size="15">"${a}": ${values}</text><text x="35" y="150" class="ink mono" font-size="15">"${b}": ${values}</text><text x="35" y="182" class="ink mono" font-size="15">"${c}": ${values}</text><line class="divider" x1="22" y1="207" x2="382" y2="207"/><text x="22" y="231" class="muted small">JSON excerpt · values unchanged</text><text x="22" y="258" class="muted label">RECORDED LABEL</text><text x="22" y="286" class="ink verdict">${escapeXml(data.before)}</text></g>
  <g transform="translate(508 145)"><rect class="card" width="404" height="300" rx="12"/><rect class="warning" x="1" y="1" width="402" height="42" rx="11"/><text x="22" y="27" class="ink label">MUTATED JSON · KEY ORDER ONLY</text><text x="382" y="27" class="muted small mono" text-anchor="end">${data.bytes.toLocaleString('en-US')} bytes</text><text x="22" y="72" class="muted small mono">$.state</text><line class="divider" x1="22" y1="86" x2="382" y2="86"/>
    ${rowSvg}
    <line class="divider" x1="22" y1="207" x2="382" y2="207"/><text x="22" y="231" class="muted small">JSON excerpt · values unchanged</text><text x="382" y="231" class="orange small trial-note" text-anchor="end">${data.initialMoved} moved positions</text><text x="22" y="258" class="muted label">RECORDED LABEL</text><text x="22" y="286" class="ink verdict baseline-label">${escapeXml(data.before)}</text><text x="22" y="286" class="teal verdict changed-label">${escapeXml(data.after)}</text></g>
  <g transform="translate(48 470)"><rect fill="#172326" width="864" height="81" rx="12"/><text x="22" y="27" fill="#9fbbb7" class="label sans">PAIRED CONFIRMATION · NEW CALLS</text><text x="22" y="56" fill="#fffdf8" class="sans" font-size="17" font-weight="700">${data.support}/${data.support} original + final</text><text x="258" y="56" fill="#9fbbb7" class="sans" font-size="15">·</text><text x="278" y="56" fill="#fffdf8" class="sans" font-size="17" font-weight="700">${data.controlChanges}/${data.controls} controls changed</text><text x="515" y="56" fill="#9fbbb7" class="sans" font-size="15">·</text><text x="535" y="56" fill="#fffdf8" class="sans" font-size="17" font-weight="700">${data.calls} new calls</text><rect fill="#0b5755" x="683" y="21" width="160" height="38" rx="19"/><text x="763" y="46" fill="#d8f4ed" class="sans" font-size="14" font-weight="700" text-anchor="middle">FAIL · empirical</text></g>
  <g class="sans"><path d="M452 274h56" class="line" stroke-width="2"/><path d="m499 267 9 7-9 7" fill="none" class="line" stroke-width="2"/><text x="480" y="255" class="muted small" text-anchor="middle">key order only</text><text x="48" y="580" class="muted small">reduced mutation: ${data.initialMoved} → ${data.finalMoved} moved key positions</text><rect class="chip" x="634" y="563" width="278" height="27" rx="13"/><text x="773" y="581" class="teal small" text-anchor="middle">saved as accepted regression · ${escapeXml(data.corpusId.slice(0, 12))}…</text></g>
  </g>
</svg>\n`;
}

async function main() {
  const [manifestText, sourceText, corpusText] = await Promise.all([
    readFile(asset('readme-demo.json'), 'utf8'), readFile(asset('readme-finding.json'), 'utf8'), readFile(asset('readme-corpus.json'), 'utf8'),
  ]);
  const manifest = object(JSON.parse(manifestText), 'manifest');
  const source = object(manifest.source, 'manifest.source');
  const corpusManifest = object(manifest.corpus, 'manifest.corpus');
  if (sha256(sourceText) !== string(source.sha256, 'manifest source hash')) fail('source SHA-256 does not match manifest');
  if (sha256(corpusText) !== string(corpusManifest.sha256, 'manifest corpus hash')) fail('corpus SHA-256 does not match manifest');
  const report = JSON.parse(sourceText);
  const shrink = object(report, 'shrink report');
  if (shrink.kind !== 'shrink' || shrink.status !== 'reduced') fail('expected a reduced shrink artifact');
  const reduced = shrink.finding;
  if (string(reduced.parentFindingId, 'reduced parent finding') !== string(shrink.original.id, 'original finding id')) fail('reduced finding does not retain parent lineage');
  if (string(source.originalFindingId, 'manifest original finding') !== shrink.original.id || string(source.reducedFindingId, 'manifest reduced finding') !== reduced.id) fail('manifest finding IDs do not match artifact');
  const originalPayloads = candidatePayloads(shrink.original, 'original');
  const reducedPayloads = candidatePayloads(reduced, 'reduced');
  const display = object(manifest.display, 'manifest display');
  const state = string(display.objectPath, 'display object path');
  if (state !== '$.state') fail('README demo must display $.state');
  const originalBaseState = object(originalPayloads.base.state, 'original base state');
  const originalMutantState = object(originalPayloads.mutant.state, 'original mutant state');
  const reducedBaseState = object(reducedPayloads.base.state, 'reduced base state');
  const reducedMutantState = object(reducedPayloads.mutant.state, 'reduced mutant state');
  const baseKeys = Object.keys(reducedBaseState), initialKeys = Object.keys(originalMutantState), finalKeys = Object.keys(reducedMutantState);
  if (baseKeys.length !== 3 || initialKeys.length !== 3 || finalKeys.length !== 3) fail('README demo card requires exactly three state keys');
  if (JSON.stringify(Object.keys(originalBaseState)) !== JSON.stringify(baseKeys)) fail('original and reduced base orders differ');
  const initialMoved = movedPositions(baseKeys, initialKeys), finalMoved = movedPositions(baseKeys, finalKeys);
  if (initialMoved !== 3 || finalMoved !== 2) fail('expected the documented shrink from three to two moved positions');
  const bytes = Buffer.byteLength(reducedPayloads.baseText);
  if ([originalPayloads.baseText, originalPayloads.mutantText, reducedPayloads.baseText, reducedPayloads.mutantText].some(payload => Buffer.byteLength(payload) !== 2349)) fail('documented payload byte count changed');
  sameJson(originalPayloads.base, reducedPayloads.base);
  if (originalPayloads.baseText !== reducedPayloads.baseText) fail('shrink changed the original base payload');
  const confirmation = object(reduced.confirmation, 'reduced confirmation');
  const blocks = list(confirmation.blocks, 'confirmation blocks');
  const support = number(confirmation.support, 'confirmation support'), controls = number(confirmation.controls, 'confirmation controls');
  const controlChanges = number(confirmation.controlViolations, 'control violations');
  if (string(confirmation.verdict, 'confirmation verdict') !== 'FAIL' || string(confirmation.evidenceLevel, 'confirmation evidence') !== 'empirical' || support !== blocks.length || controls !== blocks.length || controlChanges !== 0) fail('reduced confirmation does not support the displayed empirical finding');
  const question = string(object(reduced.contract, 'reduced contract').question, 'contract question');
  if (string(display.question, 'display question') !== question || string(manifest.provider, 'manifest provider') !== reduced.provider) fail('manifest display/provider do not match the reduced finding');
  if (string(object(shrink.original.candidate, 'original candidate').seedId, 'original public provenance') !== 'historical-public-synthetic' || string(object(reduced.candidate, 'reduced candidate').seedId, 'reduced public provenance') !== 'historical-public-synthetic') fail('finding provenance is not the public synthetic example');
  const observationIds = blocks.flatMap(block => [block.a.id, block.control.id, block.b.id]);
  const originalBlocks = list(object(shrink.original.confirmation, 'original confirmation').blocks, 'original blocks');
  const originalIds = originalBlocks.flatMap(block => [block.a.id, block.control.id, block.b.id]);
  if (new Set(originalIds).size !== originalIds.length || new Set(observationIds).size !== observationIds.length || originalIds.some(id => observationIds.includes(id))) fail('observation IDs are not distinct across shrink lineage');
  const originalConfirmation = object(shrink.original.confirmation, 'original confirmation');
  if (string(originalConfirmation.verdict, 'original confirmation verdict') !== string(confirmation.verdict, 'reduced confirmation verdict') || string(originalConfirmation.evidenceLevel, 'original confirmation evidence') !== string(confirmation.evidenceLevel, 'reduced confirmation evidence') || number(originalConfirmation.support, 'original confirmation support') !== originalBlocks.length || number(originalConfirmation.controls, 'original confirmation controls') !== originalBlocks.length || number(originalConfirmation.controlViolations, 'original control violations') !== 0 || originalBlocks.length !== blocks.length || blocks.length !== 8) fail('original confirmation does not support the documented empirical finding');
  const first = blocks[0] ?? fail('no confirmation blocks');
  const before = string(first.a.response.answers[question]?.choice, 'original answer');
  const after = string(first.b.response.answers[question]?.choice, 'mutated answer');
  if (before !== 'unrelated' || after !== 'may_violate') fail('unexpected recorded answer labels');
  const model = string(first.a.observedModel, 'observed model');
  const provider = string(reduced.provider, 'provider');
  if (model !== string(manifest.observedModel, 'manifest model')) fail('manifest model does not match observation');
  for (const [label, confirmationBlocks] of [['original', originalBlocks], ['reduced', blocks]]) for (const block of confirmationBlocks) {
    const answers = [block.a.response.answers[question]?.choice, block.control.response.answers[question]?.choice, block.b.response.answers[question]?.choice];
    if (answers[0] !== before || answers[1] !== before || answers[2] !== after) fail(`${label} confirmation labels do not match the displayed result`);
    for (const observation of [block.a, block.control, block.b]) if (observation.observedModel !== model || observation.provider !== provider) fail(`${label} confirmation observation has a different provider or model`);
  }
  const corpus = object(JSON.parse(corpusText), 'corpus');
  const entry = list(corpus.entries, 'corpus entries').find(item => item.id === corpusManifest.id) ?? fail('manifest corpus entry missing');
  if (!list(entry.sourceFindingIds, 'corpus source finding IDs').includes(reduced.id) || string(object(entry.triage, 'corpus triage').status, 'corpus status') !== 'accepted_regression') fail('reduced finding is not an accepted regression');
  const svg = render({ provider, model, question, before, after, baseKeys, initialKeys, finalKeys, initialMoved, finalMoved, calls: blocks.length * 3, support, controls, controlChanges, bytes, corpusId: string(entry.id, 'corpus entry id') });
  const output = asset('readme-demo.svg');
  if (process.argv.includes('--check')) {
    const existing = await readFile(output, 'utf8').catch(() => fail('generated SVG is missing'));
    if (existing !== svg) fail('generated SVG is stale; run node scripts/render-readme-demo.mjs');
    console.log(`readme demo is current (${Buffer.byteLength(svg)} bytes; ${support}/${support} final, ${controlChanges}/${controls} controls changed)`);
    return;
  }
  await writeFile(output, svg);
  console.log(`wrote ${output} (${Buffer.byteLength(svg)} bytes; ${initialMoved} → ${finalMoved} moved positions)`);
}

await main();
