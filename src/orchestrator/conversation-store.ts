/**
 * Conversation store — persists full LLM message history per thread in PostgreSQL.
 * Keyed by `channelId:threadTs`.
 */

import { eq, sql } from "drizzle-orm";
import type { ChatMessage } from "../llm/caller.js";
import type { Database } from "../db/index.js";
import { conversations } from "../db/schema.js";

const DEFAULT_MAX_AGE_MS = 2 * 60 * 60 * 1000; // 2 hours
const CLEANUP_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes

export class ConversationStore {
  private readonly db: Database;
  private readonly maxAgeMs: number;
  private cleanupTimer: ReturnType<typeof setInterval> | undefined;

  constructor(opts: { db: Database; maxAgeMs?: number }) {
    this.db = opts.db;
    this.maxAgeMs = opts.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  }

  /** Load — no-op, migrations handle schema. */
  async load(): Promise<void> {
    // Nothing to do
  }

  /** Start periodic cleanup. */
  startCleanupTimer(): void {
    if (this.cleanupTimer) return;
    this.cleanupTimer = setInterval(() => {
      this.cleanup(this.maxAgeMs).catch(() => {});
    }, CLEANUP_INTERVAL_MS);
    this.cleanupTimer.unref();
  }

  /** Stop periodic cleanup. */
  stopCleanupTimer(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }
  }

  /** Get stored conversation (excluding system message). */
  async get(threadKey: string): Promise<ChatMessage[] | undefined> {
    const rows = await this.db
      .select()
      .from(conversations)
      .where(eq(conversations.threadKey, threadKey));
    const row = rows[0];
    if (!row) return undefined;

    // Update last access
    await this.db
      .update(conversations)
      .set({ lastAccess: new Date() })
      .where(eq(conversations.threadKey, threadKey));

    return row.messages as ChatMessage[];
  }

  /** Store conversation (strip system message). */
  async set(threadKey: string, messages: ChatMessage[]): Promise<void> {
    const filtered = messages.filter((m) => m.role !== "system");
    await this.db
      .insert(conversations)
      .values({ threadKey, messages: filtered, lastAccess: new Date() })
      .onConflictDoUpdate({
        target: conversations.threadKey,
        set: { messages: filtered, lastAccess: new Date() },
      });
  }

  /** Delete a thread's conversation. */
  async delete(threadKey: string): Promise<void> {
    await this.db
      .delete(conversations)
      .where(eq(conversations.threadKey, threadKey));
  }

  /**
   * Apply observation masking to old tool results to manage token growth.
   */
  maskOldObservations(messages: ChatMessage[], keepRecentN: number): ChatMessage[] {
    if (messages.length <= keepRecentN) return messages;

    const cutoff = messages.length - keepRecentN;
    return messages.map((msg, i) => {
      if (i >= cutoff) return msg;
      if (msg.role !== "tool") return msg;

      const preview = msg.content.slice(0, 100).replace(/\n/g, " ");
      const suffix = msg.content.length > 100 ? "..." : "";
      return {
        ...msg,
        content: `[previous tool result: ${preview}${suffix}]`,
      };
    });
  }

  /** Cleanup threads older than maxAgeMs. */
  async cleanup(maxAgeMs: number): Promise<void> {
    const cutoff = new Date(Date.now() - maxAgeMs);
    await this.db
      .delete(conversations)
      .where(sql`${conversations.lastAccess} < ${cutoff}`);
  }

  /** Number of stored conversations (for diagnostics). */
  async getSize(): Promise<number> {
    const rows = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(conversations);
    return rows[0]?.count ?? 0;
  }

  /** Synchronous size accessor — returns 0, use getSize() for actual count. */
  get size(): number {
    // Kept for backward compat — callers should migrate to getSize()
    return 0;
  }
}
