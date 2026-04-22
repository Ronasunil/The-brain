import crypto from "node:crypto";
import { env } from "../../config/env";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

export interface EncryptedPayload {
  ciphertext: string;
  iv: string;
  tag: string;
}

function getKey(): Buffer {
  const key = Buffer.from(env.INTEGRATION_ENCRYPTION_KEY, "base64");
  if (key.length !== 32) {
    throw new Error(
      "INTEGRATION_ENCRYPTION_KEY must decode to exactly 32 bytes (AES-256)",
    );
  }
  return key;
}

export function encrypt(plaintext: string): EncryptedPayload {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, getKey(), iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  return {
    ciphertext: encrypted.toString("base64"),
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
  };
}

export function decrypt(payload: EncryptedPayload): string {
  const iv = Buffer.from(payload.iv, "base64");
  const tag = Buffer.from(payload.tag, "base64");
  const ciphertext = Buffer.from(payload.ciphertext, "base64");

  if (tag.length !== TAG_LENGTH) {
    throw new Error("Invalid auth tag length");
  }

  const decipher = crypto.createDecipheriv(ALGORITHM, getKey(), iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);

  return decrypted.toString("utf8");
}
