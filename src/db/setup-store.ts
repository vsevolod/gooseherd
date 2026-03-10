/**
 * Setup store — manages single-row wizard configuration in PostgreSQL.
 *
 * Handles first-run detection, credential encryption, and config injection.
 */

import { eq } from "drizzle-orm";
import { scrypt, randomBytes, timingSafeEqual } from "node:crypto";
import { open, readFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { Database } from "./index.js";
import { setup } from "./schema.js";
import { encrypt, decrypt, generateEncryptionKey } from "./encryption.js";

const scryptAsync = promisify(scrypt);

export interface SetupStatus {
  complete: boolean;
  hasPassword: boolean;
  hasGithub: boolean;
  hasLlm: boolean;
  hasSlack: boolean;
}

export interface GitHubSetupConfig {
  authMode: "pat" | "app";
  defaultOwner?: string;
  repos?: string[];
  // PAT mode
  token?: string;
  // App mode
  appId?: string;
  installationId?: string;
  privateKey?: string;
}

export interface LLMSetupConfig {
  provider: "openrouter" | "anthropic" | "openai";
  apiKey: string;
  defaultModel?: string;
}

export interface SlackSetupConfig {
  botToken: string;
  appToken: string;
  signingSecret?: string;
  commandName?: string;
}

const SCRYPT_KEYLEN = 64;

export class SetupStore {
  private readonly db: Database;
  private encryptionKey: string | undefined;

  // In-memory cache to avoid 2 DB queries per HTTP request
  private cachedComplete: boolean | undefined;
  private cachedPasswordHash: string | undefined | null; // null = queried, not set

  constructor(db: Database, encryptionKey?: string) {
    this.db = db;
    this.encryptionKey = encryptionKey;
  }

  /** Check if first-run setup is complete. */
  async isComplete(): Promise<boolean> {
    if (this.cachedComplete !== undefined) return this.cachedComplete;
    const rows = await this.db.select().from(setup).where(eq(setup.id, 1));
    this.cachedComplete = rows[0]?.completedAt != null;
    return this.cachedComplete;
  }

  /** Get current setup status for the wizard UI. */
  async getStatus(): Promise<SetupStatus> {
    const rows = await this.db.select().from(setup).where(eq(setup.id, 1));
    const row = rows[0];
    if (!row) {
      return { complete: false, hasPassword: false, hasGithub: false, hasLlm: false, hasSlack: false };
    }
    return {
      complete: row.completedAt != null,
      hasPassword: row.passwordHash != null,
      hasGithub: row.githubTokenEnc != null || row.githubAppKeyEnc != null,
      hasLlm: row.llmApiKeyEnc != null,
      hasSlack: row.slackBotTokenEnc != null,
    };
  }

  /** Hash and save the dashboard password (scrypt). */
  async setPassword(password: string): Promise<string> {
    const hash = await hashPassword(password);

    // Ensure encryption key exists
    await this.ensureEncryptionKey();

    await this.db
      .insert(setup)
      .values({ id: 1, passwordHash: hash, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: setup.id,
        set: { passwordHash: hash, updatedAt: new Date() },
      });

    // Invalidate cache
    this.cachedPasswordHash = hash;

    return hash;
  }

  /** Get the stored password hash for auth. */
  async getPasswordHash(): Promise<string | undefined> {
    if (this.cachedPasswordHash !== undefined) {
      return this.cachedPasswordHash ?? undefined;
    }
    const rows = await this.db
      .select({ passwordHash: setup.passwordHash })
      .from(setup)
      .where(eq(setup.id, 1));
    const hash = rows[0]?.passwordHash ?? null;
    this.cachedPasswordHash = hash;
    return hash ?? undefined;
  }

  /** Save GitHub configuration (encrypted). */
  async saveGitHub(config: GitHubSetupConfig): Promise<void> {
    const key = await this.getEncryptionKey();

    const githubConfig: Record<string, unknown> = {
      authMode: config.authMode,
      defaultOwner: config.defaultOwner,
      repos: config.repos,
    };

    let githubTokenEnc: Buffer | null = null;
    let githubAppKeyEnc: Buffer | null = null;

    if (config.authMode === "pat" && config.token) {
      githubTokenEnc = encrypt(config.token, key);
    } else if (config.authMode === "app") {
      githubConfig.appId = config.appId;
      githubConfig.installationId = config.installationId;
      if (config.privateKey) {
        githubAppKeyEnc = encrypt(config.privateKey, key);
      }
    }

    await this.db
      .insert(setup)
      .values({
        id: 1,
        githubConfig,
        githubTokenEnc,
        githubAppKeyEnc,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: setup.id,
        set: { githubConfig, githubTokenEnc, githubAppKeyEnc, updatedAt: new Date() },
      });
  }

  /** Save LLM configuration (encrypted). */
  async saveLLM(config: LLMSetupConfig): Promise<void> {
    const key = await this.getEncryptionKey();

    const llmConfig: Record<string, unknown> = {
      provider: config.provider,
      defaultModel: config.defaultModel,
    };

    const llmApiKeyEnc = encrypt(config.apiKey, key);

    await this.db
      .insert(setup)
      .values({ id: 1, llmConfig, llmApiKeyEnc, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: setup.id,
        set: { llmConfig, llmApiKeyEnc, updatedAt: new Date() },
      });
  }

  /** Save Slack configuration (encrypted). */
  async saveSlack(config: SlackSetupConfig): Promise<void> {
    const key = await this.getEncryptionKey();

    const slackConfig: Record<string, unknown> = {
      signingSecret: config.signingSecret,
      commandName: config.commandName,
    };

    const slackBotTokenEnc = encrypt(config.botToken, key);
    const slackAppTokenEnc = encrypt(config.appToken, key);

    await this.db
      .insert(setup)
      .values({ id: 1, slackConfig, slackBotTokenEnc, slackAppTokenEnc, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: setup.id,
        set: { slackConfig, slackBotTokenEnc, slackAppTokenEnc, updatedAt: new Date() },
      });
  }

  /** Mark setup as complete. Throws if password hasn't been set. */
  async markComplete(): Promise<void> {
    const status = await this.getStatus();
    if (!status.hasPassword) {
      throw new Error("Cannot complete setup without a password");
    }
    await this.db
      .update(setup)
      .set({ completedAt: new Date(), updatedAt: new Date() })
      .where(eq(setup.id, 1));

    // Invalidate cache
    this.cachedComplete = true;
  }

  /** Get the full setup row for config injection. */
  async getSetupRow(): Promise<typeof setup.$inferSelect | undefined> {
    const rows = await this.db.select().from(setup).where(eq(setup.id, 1));
    return rows[0];
  }

  /**
   * Apply wizard-stored secrets into process.env (env vars always win via ??=).
   * Called on startup (if setup complete) and after wizard completion.
   */
  async applyToEnv(): Promise<void> {
    const row = await this.getSetupRow();
    if (!row || !row.completedAt) return;

    const key = await this.getEncryptionKey();

    // GitHub PAT
    if (row.githubTokenEnc) {
      const token = decrypt(row.githubTokenEnc, key);
      process.env.GITHUB_TOKEN ??= token;
    }

    // GitHub App
    if (row.githubAppKeyEnc) {
      const privateKey = decrypt(row.githubAppKeyEnc, key);
      process.env.GITHUB_APP_PRIVATE_KEY ??= privateKey;
    }

    const ghConfig = row.githubConfig as Record<string, unknown> | null;
    if (ghConfig) {
      if (ghConfig.appId) process.env.GITHUB_APP_ID ??= String(ghConfig.appId);
      if (ghConfig.installationId) process.env.GITHUB_APP_INSTALLATION_ID ??= String(ghConfig.installationId);
      if (ghConfig.defaultOwner) process.env.GITHUB_DEFAULT_OWNER ??= String(ghConfig.defaultOwner);
      if (Array.isArray(ghConfig.repos) && ghConfig.repos.length > 0) {
        process.env.REPO_ALLOWLIST ??= (ghConfig.repos as string[]).join(",");
      }
    }

    // LLM
    if (row.llmApiKeyEnc) {
      const apiKey = decrypt(row.llmApiKeyEnc, key);
      const llmConfig = row.llmConfig as Record<string, unknown> | null;
      const provider = llmConfig?.provider as string | undefined;

      if (provider === "anthropic") {
        process.env.ANTHROPIC_API_KEY ??= apiKey;
      } else if (provider === "openai") {
        process.env.OPENAI_API_KEY ??= apiKey;
      } else {
        // Default: openrouter
        process.env.OPENROUTER_API_KEY ??= apiKey;
      }

      if (llmConfig?.defaultModel) {
        process.env.DEFAULT_LLM_MODEL ??= String(llmConfig.defaultModel);
      }
    }

    // Slack
    if (row.slackBotTokenEnc) {
      process.env.SLACK_BOT_TOKEN ??= decrypt(row.slackBotTokenEnc, key);
    }
    if (row.slackAppTokenEnc) {
      process.env.SLACK_APP_TOKEN ??= decrypt(row.slackAppTokenEnc, key);
    }
    const slackConfig = row.slackConfig as Record<string, unknown> | null;
    if (slackConfig) {
      if (slackConfig.signingSecret) process.env.SLACK_SIGNING_SECRET ??= String(slackConfig.signingSecret);
      if (slackConfig.commandName) process.env.SLACK_COMMAND_NAME ??= String(slackConfig.commandName);
    }
  }

  // ── Encryption key management ──

  /**
   * Ensure an encryption key exists.
   * Priority: env var → key file → auto-generate to file (exclusive create).
   */
  private async ensureEncryptionKey(): Promise<void> {
    if (this.encryptionKey) return;

    // Try reading from key file
    const keyPath = this.keyFilePath();
    try {
      const key = (await readFile(keyPath, "utf8")).trim();
      if (key.length === 64 && /^[0-9a-fA-F]+$/.test(key)) {
        this.encryptionKey = key;
        return;
      }
    } catch {
      // File doesn't exist yet
    }

    // Generate and write atomically (O_EXCL prevents TOCTOU race)
    const newKey = generateEncryptionKey();
    await mkdir(path.dirname(keyPath), { recursive: true });
    try {
      const fh = await open(keyPath, "wx", 0o600);
      await fh.writeFile(newKey);
      await fh.close();
      this.encryptionKey = newKey;
    } catch (err) {
      // Another process created the file first — read their key
      if ((err as NodeJS.ErrnoException).code === "EEXIST") {
        const key = (await readFile(keyPath, "utf8")).trim();
        this.encryptionKey = key;
      } else {
        throw err;
      }
    }
  }

  /** Get the encryption key (from memory, env, or key file). */
  private async getEncryptionKey(): Promise<string> {
    if (this.encryptionKey) return this.encryptionKey;
    await this.ensureEncryptionKey();
    if (!this.encryptionKey) {
      throw new Error("No encryption key available. Set ENCRYPTION_KEY env var or ensure the key file is writable.");
    }
    return this.encryptionKey;
  }

  /** Resolve the key file path (env override or default). Uses data/ dir which is writable. */
  private keyFilePath(): string {
    return process.env.ENCRYPTION_KEY_FILE ?? path.join(process.env.DATA_DIR ?? "data", ".encryption-key");
  }
}

/** Password hashing using async scrypt (N=16384, r=8, p=1, keylen=64). */
async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scryptAsync(password, salt, SCRYPT_KEYLEN) as Buffer;
  return `scrypt:${salt.toString("hex")}:${hash.toString("hex")}`;
}

/** Verify password against stored scrypt hash using constant-time comparison. */
export async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  const parts = storedHash.split(":");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  const salt = Buffer.from(parts[1]!, "hex");
  const expectedHash = Buffer.from(parts[2]!, "hex");
  const actualHash = await scryptAsync(password, salt, SCRYPT_KEYLEN) as Buffer;
  if (actualHash.length !== expectedHash.length) return false;
  return timingSafeEqual(actualHash, expectedHash);
}
