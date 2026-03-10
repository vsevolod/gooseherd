/**
 * AES-256-GCM encryption for secrets stored in PostgreSQL.
 *
 * Format: [iv:12][authTag:16][ciphertext]
 * Key: 64-char hex string (= 32 bytes).
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

function keyFromHex(keyHex: string): Buffer {
  if (keyHex.length !== 64 || !/^[0-9a-fA-F]+$/.test(keyHex)) {
    throw new Error("ENCRYPTION_KEY must be exactly 64 hex characters (32 bytes)");
  }
  return Buffer.from(keyHex, "hex");
}

export function encrypt(plaintext: string, keyHex: string): Buffer {
  const key = keyFromHex(keyHex);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]);
}

export function decrypt(data: Buffer, keyHex: string): string {
  const key = keyFromHex(keyHex);
  if (data.length < IV_LENGTH + TAG_LENGTH) {
    throw new Error("Encrypted data too short");
  }
  const iv = data.subarray(0, IV_LENGTH);
  const tag = data.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
  const ciphertext = data.subarray(IV_LENGTH + TAG_LENGTH);
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  return decipher.update(ciphertext, undefined, "utf8") + decipher.final("utf8");
}

/** Generate a random 64-char hex key suitable for ENCRYPTION_KEY. */
export function generateEncryptionKey(): string {
  return randomBytes(32).toString("hex");
}
