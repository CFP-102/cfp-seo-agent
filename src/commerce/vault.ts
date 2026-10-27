import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * Encryption of gift card codes at rest (AES-256-GCM). The order id is bound as associated data, so a sealed code copied
 * to another order row does not open. The key comes from GIFTCARDS_ENCRYPTION_KEY (64 hex characters) and never
 * touches the database or the logs.
 */
export function createVault(keyHex: string) {
  if (!/^[0-9a-fA-F]{64}$/.test(keyHex)) throw new Error("GIFTCARDS_ENCRYPTION_KEY must be 64 hex characters");
  const key = Buffer.from(keyHex, "hex");
  return {
    seal(plain: string, orderId: string): string {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      cipher.setAAD(Buffer.from(orderId));
      const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
      return ["v1", iv.toString("base64"), cipher.getAuthTag().toString("base64"), data.toString("base64")].join(":");
    },
    open(sealed: string, orderId: string): string {
      const [version, iv, tag, data] = sealed.split(":");
      if (version !== "v1" || !iv || !tag || !data) throw new Error("unknown sealed format");
      const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"));
      decipher.setAAD(Buffer.from(orderId));
      decipher.setAuthTag(Buffer.from(tag, "base64"));
      return Buffer.concat([decipher.update(Buffer.from(data, "base64")), decipher.final()]).toString("utf8");
    },
  };
}

export type Vault = ReturnType<typeof createVault>;
