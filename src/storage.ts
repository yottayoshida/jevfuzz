import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname, join, parse, resolve } from 'node:path';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { assert, FuzzError } from './util.ts';

export const MAX_JSON_BYTES = 8 * 1024 * 1024;
export const MAX_JSON_DEPTH = 64;

export function boundedJson(value: unknown, maxDepth = MAX_JSON_DEPTH, maxNodes = 100_000): void {
  const pending: [unknown, number][] = [[value, 0]];
  const seen = new Set<object>();
  let count = 0;
  while (pending.length) {
    const [node, depth] = pending.pop()!;
    assert(++count <= maxNodes && depth <= maxDepth, 'JSON structural limit exceeded');
    if (node && typeof node === 'object') {
      assert(!seen.has(node), 'JSON must not contain cycles or shared object references');
      seen.add(node);
      for (const child of Object.values(node)) pending.push([child, depth + 1]);
    } else assert(node === null || typeof node === 'string' || typeof node === 'boolean' || (typeof node === 'number' && Number.isFinite(node)), 'invalid JSON value');
  }
}
export function parseBoundedJson(text: string, maxBytes = MAX_JSON_BYTES): unknown {
  assert(Buffer.byteLength(text) <= maxBytes, 'JSON byte limit exceeded');
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new FuzzError('CONFIG', 'invalid JSON'); }
  boundedJson(value);
  return value;
}
export function assertNoSecrets(text: string, secrets: readonly string[] = []): void {
  const known = secrets.flatMap(value => [value, value.trim()]).filter(Boolean);
  assert(!known.some(secret => text.includes(secret)), 'credential detected; refusing persistence');
}

/** Fixed macOS aliases are resolved before validating caller-controlled components. */
export function storagePath(path: string): string {
  let absolute = resolve(path);
  if (process.platform === 'darwin') for (const alias of ['/tmp', '/var']) {
    if (absolute === alias || absolute.startsWith(`${alias}/`)) absolute = `/private${absolute}`;
  }
  return absolute;
}
export async function assertSafePath(path: string): Promise<string> {
  const absolute = storagePath(path), root = parse(absolute).root;
  let part = root;
  for (const name of absolute.slice(root.length).split('/').filter(Boolean)) {
    part = join(part, name);
    try { assert(!(await lstat(part)).isSymbolicLink(), 'symbolic links are not permitted'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  return absolute;
}
export async function readBoundedText(path: string, maxBytes = MAX_JSON_BYTES): Promise<string> {
  const safe = await assertSafePath(path);
  const handle = await open(safe, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    assert(stat.isFile() && stat.nlink === 1 && stat.size <= maxBytes, 'input must be a bounded regular file');
    // Read at most limit+1 even if another process grows the file after fstat.
    const buffer = Buffer.alloc(Math.min(maxBytes + 1, stat.size + 1));
    let offset = 0;
    while (offset < buffer.length) {
      const result = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (!result.bytesRead) break;
      offset += result.bytesRead;
    }
    assert(offset <= maxBytes && offset <= stat.size, 'input changed or exceeds byte limit');
    return buffer.subarray(0, offset).toString('utf8');
  } finally { await handle.close(); }
}
export async function readJson(path: string, maxBytes = MAX_JSON_BYTES): Promise<unknown> {
  return parseBoundedJson(await readBoundedText(path, maxBytes), maxBytes);
}
export async function privateDir(path: string): Promise<string> {
  const safe = await assertSafePath(path);
  await mkdir(safe, { recursive: true, mode: 0o700 });
  await assertSafePath(safe);
  const stat = await lstat(safe);
  assert(stat.isDirectory() && (!process.getuid || stat.uid === process.getuid()), 'storage directory must be owned by the current user');
  assert((stat.mode & 0o077) === 0, 'storage directory must have mode 0700');
  return safe;
}
export async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}
export async function writePrivate(path: string, text: string, secrets: readonly string[] = [], maxBytes = MAX_JSON_BYTES): Promise<void> {
  assertNoSecrets(text, secrets);
  assert(Buffer.byteLength(text) <= maxBytes, 'storage byte limit exceeded');
  const safe = await assertSafePath(path);
  await privateDir(dirname(safe));
  const handle = await open(safe, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(text); await handle.sync(); } finally { await handle.close(); }
  await syncDirectory(dirname(safe));
}
export async function atomicPrivate(path: string, text: string, secrets: readonly string[] = [], maxBytes = MAX_JSON_BYTES): Promise<void> {
  const safe = await assertSafePath(path);
  const temporary = `${safe}.${randomUUID()}.tmp`;
  await writePrivate(temporary, text, secrets, maxBytes);
  try { await assertSafePath(safe); await rename(temporary, safe); await syncDirectory(dirname(safe)); }
  finally { await rm(temporary, { force: true }); }
}
export interface WriterLock { release(): Promise<void> }
export async function writerLock(directory: string): Promise<WriterLock> {
  const root = await privateDir(directory), file = join(root, '.writer.lock');
  const owner = { pid: process.pid, host: hostname(), token: randomUUID(), created: new Date().toISOString() };
  try { await writePrivate(file, JSON.stringify(owner)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new FuzzError('LOCKED', 'storage already has a writer; explicit stale-lock recovery is required'); throw error; }
  return { async release() {
    const current = await readJson(file) as typeof owner;
    assert(current.token === owner.token, 'writer lock ownership changed');
    await rm(file); await syncDirectory(root);
  } };
}

/** Explicit local recovery: only a dead process on this host can relinquish a lock. */
export async function recoverWriterLock(directory: string): Promise<void> {
  const root = await privateDir(directory), file = join(root, '.writer.lock');
  const owner = await readJson(file) as { pid?: number; host?: string };
  assert(owner.host === hostname() && Number.isSafeInteger(owner.pid) && owner.pid! > 0, 'cannot recover an unknown lock owner');
  let alive = true;
  try { process.kill(owner.pid!, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') alive = false; else throw error; }
  assert(!alive, 'lock owner is still alive');
  await rm(file); await syncDirectory(root);
}
