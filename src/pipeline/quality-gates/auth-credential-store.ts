/**
 * Credential store backed by PostgreSQL.
 *
 * Persists auth credentials discovered during browser verification
 * so that subsequent retry attempts can reuse them.
 * Credentials are encrypted at rest via AES-256-GCM.
 */

import { eq } from "drizzle-orm";
import { logInfo } from "../../logger.js";
import type { Database } from "../../db/index.js";
import { authCredentials } from "../../db/schema.js";
import { encrypt, decrypt } from "../../db/encryption.js";

export interface StoredCredentials {
  email: string;
  password: string;
  createdAt: string;
  lastUsedAt: string;
  loginSuccessful: boolean;
}

export class AuthCredentialStore {
  private readonly db: Database;
  private readonly encryptionKey: string | undefined;

  constructor(db: Database, encryptionKey?: string) {
    this.db = db;
    this.encryptionKey = encryptionKey;
  }

  async load(): Promise<void> {
    // No-op — migrations handle schema, data is in DB
    const rows = await this.db.select().from(authCredentials);
    logInfo("auth_credential_store: loaded", { domains: rows.length });
  }

  async flush(): Promise<void> {
    // No-op — writes are immediate to DB
  }

  async getForDomain(domain: string): Promise<StoredCredentials | undefined> {
    const rows = await this.db
      .select()
      .from(authCredentials)
      .where(eq(authCredentials.domain, domain));
    const row = rows[0];
    if (!row) return undefined;

    return {
      email: this.encryptionKey ? decrypt(row.emailEnc, this.encryptionKey) : row.emailEnc.toString("utf8"),
      password: this.encryptionKey ? decrypt(row.passwordEnc, this.encryptionKey) : row.passwordEnc.toString("utf8"),
      createdAt: row.createdAt.toISOString(),
      lastUsedAt: row.lastUsedAt.toISOString(),
      loginSuccessful: row.loginSuccessful,
    };
  }

  async save(domain: string, creds: StoredCredentials): Promise<void> {
    const emailEnc = this.encryptionKey
      ? encrypt(creds.email, this.encryptionKey)
      : Buffer.from(creds.email, "utf8");
    const passwordEnc = this.encryptionKey
      ? encrypt(creds.password, this.encryptionKey)
      : Buffer.from(creds.password, "utf8");

    await this.db
      .insert(authCredentials)
      .values({
        domain,
        emailEnc,
        passwordEnc,
        createdAt: new Date(),
        lastUsedAt: new Date(),
        loginSuccessful: creds.loginSuccessful,
      })
      .onConflictDoUpdate({
        target: authCredentials.domain,
        set: { emailEnc, passwordEnc, lastUsedAt: new Date(), loginSuccessful: creds.loginSuccessful },
      });
  }

  /** Mark existing credentials as recently used. */
  async touch(domain: string): Promise<void> {
    await this.db
      .update(authCredentials)
      .set({ lastUsedAt: new Date() })
      .where(eq(authCredentials.domain, domain));
  }
}
