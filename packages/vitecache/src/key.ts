import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { json } from './dependencies.js';
import type { Dependencies, Resolved } from './types.js';

export function digest(bytes: Uint8Array): string {
  return bytesToHex(sha256(bytes));
}

export function key(version: string, dependencies: Dependencies<Resolved>): string {
  return digest(new TextEncoder().encode(JSON.stringify(json({ version, dependencies }))));
}
