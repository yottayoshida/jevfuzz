import { constants } from 'node:fs';
import { open, type FileHandle } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { assert, FuzzError, record } from '../util.ts';
import { assertNoSecrets, assertSafePath, parseBoundedJson, privateDir, readBoundedText, syncDirectory, writePrivate } from '../storage.ts';

export interface JournalRecord { sequence: number; previousHash: string; type: string; data: unknown; bytes: number; hash: string }
const digest = (value: string): string => createHash('sha256').update(value).digest('hex');
const INITIAL_HASH = '0'.repeat(64);
export interface JournalReader { records: JournalRecord[]; truncatedBytes: number; validBytes: number; headHash: string }

export function decodeJournal(text: string): JournalReader {
  const records: JournalRecord[] = [];
  let previousHash = INITIAL_HASH, validBytes = 0;
  const end = text.lastIndexOf('\n') + 1;
  // Only an incomplete final frame is tolerated. Complete corrupt frames reject.
  for (const line of text.slice(0, end).split('\n').slice(0, -1)) {
    const parsed = parseBoundedJson(line);
    assert(record(parsed) && Object.keys(parsed).length === 6, 'invalid journal frame');
    const { sequence, previousHash: previous, type, data, bytes, hash } = parsed;
    assert(sequence === records.length && previous === previousHash && typeof type === 'string' && /^[a-z][a-z0-9_-]{0,63}$/.test(type), 'journal sequence or chain mismatch');
    const body = JSON.stringify({ sequence, previousHash: previous, type, data });
    assert(bytes === Buffer.byteLength(body) && hash === digest(body), 'journal checksum mismatch');
    records.push(parsed as unknown as JournalRecord); previousHash = hash as string;
    validBytes += Buffer.byteLength(line) + 1;
  }
  return { records, validBytes, truncatedBytes: Buffer.byteLength(text.slice(end)), headHash: previousHash };
}

/** A single-writer, hash-chained, fsynced execution log. Checkpoints are only views. */
export class ExecutionJournal {
  readonly #handle: FileHandle;
  readonly #maxBytes: number;
  readonly #secrets: readonly string[];
  #bytes: number;
  #headHash: string;
  #next: number;
  #queue: Promise<unknown> = Promise.resolve();
  #closed = false;
  readonly records: JournalRecord[];
  private constructor(handle: FileHandle, state: JournalReader, options: { maxBytes: number; secrets: readonly string[] }) {
    this.#handle = handle; this.#bytes = state.validBytes; this.#headHash = state.headHash;
    this.#next = state.records.length; this.records = state.records;
    this.#maxBytes = options.maxBytes; this.#secrets = options.secrets;
  }
  static async create(path: string, options: { maxBytes?: number; secrets?: readonly string[] } = {}): Promise<ExecutionJournal> {
    const safe = await assertSafePath(path); await privateDir(dirname(safe));
    const handle = await open(safe, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    await handle.sync(); await syncDirectory(dirname(safe));
    return new ExecutionJournal(handle, { records: [], truncatedBytes: 0, validBytes: 0, headHash: INITIAL_HASH }, { maxBytes: options.maxBytes ?? 64 * 1024 * 1024, secrets: options.secrets ?? [] });
  }
  static async resume(path: string, options: { maxBytes?: number; secrets?: readonly string[] } = {}): Promise<ExecutionJournal> {
    const maxBytes = options.maxBytes ?? 64 * 1024 * 1024;
    const safe = await assertSafePath(path), text = await readBoundedText(safe, maxBytes);
    const state = decodeJournal(text);
    const handle = await open(safe, constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      assert(stat.nlink === 1 && (stat.mode & 0o077) === 0 && stat.size === Buffer.byteLength(text), 'journal permissions or content changed');
      if (state.truncatedBytes) {
        // Retain the damaged tail for inspection before safely removing it from the active chain.
        await writePrivate(`${safe}.truncated-${Date.now()}`, text.slice(text.lastIndexOf('\n') + 1), options.secrets, maxBytes);
        await handle.truncate(state.validBytes); await handle.sync();
      }
      return new ExecutionJournal(handle, state, { maxBytes, secrets: options.secrets ?? [] });
    } catch (error) { await handle.close(); throw error; }
  }
  get headHash(): string { return this.#headHash; }
  append(type: string, data: unknown): Promise<void> {
    // Serializing here freezes caller-owned data before yielding to another writer.
    const frozen = parseBoundedJson(JSON.stringify(data));
    const task = this.#queue.then(async () => {
      assert(!this.#closed && /^[a-z][a-z0-9_-]{0,63}$/.test(type), 'journal closed or invalid event');
      const body = JSON.stringify({ sequence: this.#next, previousHash: this.#headHash, type, data: frozen });
      assertNoSecrets(body, this.#secrets);
      const row: JournalRecord = { sequence: this.#next, previousHash: this.#headHash, type, data: frozen, bytes: Buffer.byteLength(body), hash: digest(body) };
      const text = `${JSON.stringify(row)}\n`;
      if (this.#bytes + Buffer.byteLength(text) > this.#maxBytes) throw new FuzzError('STORAGE_LIMIT', 'journal byte limit reached');
      await this.#handle.writeFile(text); await this.#handle.sync();
      this.#bytes += Buffer.byteLength(text); this.#headHash = row.hash; this.#next++; this.records.push(row);
    });
    // A failed append poisons this writer: no dispatch may proceed after a lost event.
    this.#queue = task;
    return task;
  }
  async close(): Promise<void> { try { await this.#queue; } finally { this.#closed = true; await this.#handle.close(); } }
}
