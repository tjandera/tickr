// AES-256-GCM authenticated encryption for sensitive data at rest (note text).
//
// Why encryption, not hashing: notes must be readable again, so we need a
// reversible transform. GCM also authenticates the ciphertext (tamper-evident
// via the auth tag). The key is derived from ENCRYPTION_KEY (falling back to
// JWT_SECRET) so a database leak alone never exposes note contents.
import { createCipheriv, createDecipheriv, randomBytes, createHash } from "node:crypto";

const PREFIX = "enc:v1:"; // marks an encrypted value + lets us evolve the scheme

// A stable 32-byte key from whatever secret length is configured.
function key() {
  const secret = (process.env.ENCRYPTION_KEY || process.env.JWT_SECRET || "").trim();
  if (!secret) throw new Error("ENCRYPTION_KEY or JWT_SECRET must be set to encrypt notes");
  return createHash("sha256").update(secret).digest();
}

export function isEncrypted(value) {
  return typeof value === "string" && value.startsWith(PREFIX);
}

// Encrypt a string. Returns PREFIX + base64(iv | authTag | ciphertext).
export function encrypt(plain) {
  if (plain == null || plain === "") return plain;
  const iv = randomBytes(12); // 96-bit nonce, recommended for GCM
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const ct = Buffer.concat([cipher.update(String(plain), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + Buffer.concat([iv, tag, ct]).toString("base64");
}

// Decrypt a value produced by encrypt(). Plaintext / legacy values (no prefix)
// pass through unchanged, and a bad key or corrupt data returns the input rather
// than throwing, so a single unreadable note never breaks the whole list.
export function decrypt(value) {
  if (!isEncrypted(value)) return value;
  try {
    const raw = Buffer.from(value.slice(PREFIX.length), "base64");
    const iv = raw.subarray(0, 12);
    const tag = raw.subarray(12, 28);
    const ct = raw.subarray(28);
    const decipher = createDecipheriv("aes-256-gcm", key(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
  } catch {
    return value;
  }
}
