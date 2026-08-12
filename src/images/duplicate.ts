import { findImageByHash } from "../database/db.js";
import { sha256 } from "./inspector.js";

export function isDuplicateHash(buffer: Buffer): { duplicate: boolean; sha256: string; existingPath?: string } {
  const hash = sha256(buffer);
  const existing = findImageByHash(hash);
  if (existing) {
    return { duplicate: true, sha256: hash, existingPath: existing.localPath };
  }
  return { duplicate: false, sha256: hash };
}
