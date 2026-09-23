import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { assert, record } from '../util.ts';
import { readJson, StorageQuota } from '../storage.ts';

export interface CorpusStorageManifest { version: 2; kind: 'corpus-storage'; maxBytes: number }
const manifestName = 'corpus.json';
const defaultLimit = 512 * 1024 * 1024;
function validManifest(value: unknown): CorpusStorageManifest {
  assert(record(value) && Object.keys(value).length === 3 && value.version === 2 && value.kind === 'corpus-storage' && Number.isSafeInteger(value.maxBytes) && (value.maxBytes as number) > 0, 'invalid corpus storage manifest');
  return value as unknown as CorpusStorageManifest;
}
/** Bounded no-follow inventory. The writer lock must be held by the caller. */
export async function openCorpusStorage(root: string, requestedLimit?: number): Promise<{ manifest: CorpusStorageManifest; quota: StorageQuota }> {
  let manifest: CorpusStorageManifest | undefined;
  try { manifest = validManifest(await readJson(join(root, manifestName))); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (manifest && requestedLimit !== undefined) assert(manifest.maxBytes === requestedLimit, 'corpus storage limit mismatch');
  const quota = new StorageQuota(manifest?.maxBytes ?? requestedLimit ?? defaultLimit);
  const pending = [root]; let seen = 0;
  while (pending.length) {
    const folder = pending.pop()!;
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      assert(++seen <= 100_000 && !entry.isSymbolicLink(), 'unsafe or oversized corpus storage');
      if (entry.name === '.writer.lock') continue;
      const path = join(folder, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else {
        assert(entry.isFile() && entry.name !== '.writer.lock', 'unsafe corpus storage entry');
        const stat = await lstat(path);
        assert(stat.isFile() && stat.nlink === 1 && !stat.isSymbolicLink(), 'unsafe corpus storage file');
        quota.adopt(path, stat.size);
      }
    }
  }
  if (!manifest) {
    manifest = { version: 2, kind: 'corpus-storage', maxBytes: quota.limit };
    await quota.write(join(root, manifestName), JSON.stringify(manifest));
  }
  return { manifest, quota };
}
export async function initializeCorpusStorage(root: string, maxBytes?: number): Promise<CorpusStorageManifest> {
  const storage = await openCorpusStorage(root, maxBytes);
  return storage.manifest;
}
