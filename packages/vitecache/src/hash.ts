import { createHash } from 'node:crypto';
import { stat } from 'node:fs/promises';
import * as disk from './disk.js';

/** SHA-256 hex, computed natively since files can be large. */
export function contentHash(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Content hashes of dependency files by absolute path, shared by every storage in the process, so that each
 * `CacheEntry` does not read and hash a large file again. Reused while the file's identity, size, mtime and ctime are
 * unchanged. As git does for its index, a hash taken within `RACY_NS` of the file's mtime is not kept: a write in the
 * same timestamp tick could follow it unseen. That compares the process's clock with the filesystem's: one whose clock
 * runs more than `RACY_NS` behind, as a network filesystem's can, may have a hash reused across such a write.
 *
 * Nothing evicts a hash except a failed read, so a long-running server holds one per dependency file it ever hashed.
 */
const fileHashes = new Map<string, { stats: string; hash: Promise<string | undefined> }>();
const RACY_NS = 2_000_000_000n;

/** The content hash of the file at absolute `path`, or undefined when it does not exist. */
export async function fileHash(path: string): Promise<string | undefined> {
  try {
    const { dev, ino, size, mtimeNs, ctimeNs } = await stat(path, { bigint: true });
    const stats = [dev, ino, size, mtimeNs, ctimeNs].join();
    const known = fileHashes.get(path);
    if (known?.stats === stats) return await known.hash;
    const hash = disk.load(path).then((bytes) => bytes === undefined ? undefined : contentHash(bytes));
    if (BigInt(Date.now()) * 1_000_000n - mtimeNs < RACY_NS) fileHashes.delete(path);
    else fileHashes.set(path, { stats, hash });
    return await hash;
  } catch (error) {
    fileHashes.delete(path);
    if (disk.notFound(error)) return undefined;
    throw error;
  }
}
