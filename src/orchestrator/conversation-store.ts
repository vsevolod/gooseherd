/**
 * Conversation store — persists full LLM message history per thread.
 * Keyed by `channelId:threadTs`.
 *
 * In-memory with optional file-based persistence in `{dataDir}/conversations/`.
 * Each thread is stored as a separate JSON file, loaded on first access.
 */

import { mkdir, readdir, readFile, writeFile, rename, unlink } from "node:fs/promises";
import path from "node:path";
import type { ChatMessage } from "../llm/caller.js";

interface StoredConversation {
  messages: ChatMessage[];
  lastAccess: number;
}

const DEFAULT_MAX_AGE_MS = 2 * 60 * 60 * 1000; // 2 hours
const DEFAULT_MAX_ENTRIES = 500;
const CLEANUP_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes

export class ConversationStore {
  private conversations = new Map<string, StoredConversation>();
  private readonly maxEntries: number;
  private readonly maxAgeMs: number;
  private cleanupTimer: ReturnType<typeof setInterval> | undefined;
  private readonly persistDir: string | undefined;

  constructor(opts?: { maxEntries?: number; maxAgeMs?: number; persistDir?: string }) {
    this.maxEntries = opts?.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.maxAgeMs = opts?.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
    this.persistDir = opts?.persistDir;
  }

  /** Load persisted conversations from disk. Call once at startup when persistDir is set. */
  async load(): Promise<void> {
    if (!this.persistDir) return;
    await mkdir(this.persistDir, { recursive: true });

    let files: string[];
    try {
      files = await readdir(this.persistDir);
    } catch {
      return;
    }

    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      try {
        const raw = await readFile(path.join(this.persistDir, file), "utf8");
        const entry = JSON.parse(raw) as StoredConversation;
        const key = decodeURIComponent(file.slice(0, -5)); // remove .json, decode URI
        this.conversations.set(key, entry);
      } catch {
        // Corrupted file — skip
      }
    }
  }

  /** Start periodic cleanup. Call once at startup. */
  startCleanupTimer(): void {
    if (this.cleanupTimer) return;
    this.cleanupTimer = setInterval(() => this.cleanup(this.maxAgeMs), CLEANUP_INTERVAL_MS);
    this.cleanupTimer.unref();
  }

  /** Stop periodic cleanup (for graceful shutdown). */
  stopCleanupTimer(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }
  }

  /** Get stored conversation (excluding system message). */
  get(threadKey: string): ChatMessage[] | undefined {
    const entry = this.conversations.get(threadKey);
    if (!entry) return undefined;
    entry.lastAccess = Date.now();
    return entry.messages;
  }

  /** Store conversation (strip system message — it's re-injected each call). */
  set(threadKey: string, messages: ChatMessage[]): void {
    const filtered = messages.filter(m => m.role !== "system");
    const entry: StoredConversation = { messages: filtered, lastAccess: Date.now() };
    this.conversations.set(threadKey, entry);
    this.evictIfOverCap();
    this.persistEntry(threadKey, entry);
  }

  /** Delete a thread's conversation. */
  delete(threadKey: string): void {
    this.conversations.delete(threadKey);
    this.removePersistedEntry(threadKey);
  }

  /**
   * Apply observation masking to old tool results to manage token growth.
   * Tool results older than the last `keepRecentN` messages get replaced
   * with a short summary. Tool_use (assistant) blocks stay intact so the
   * LLM knows what it already called.
   */
  maskOldObservations(messages: ChatMessage[], keepRecentN: number): ChatMessage[] {
    if (messages.length <= keepRecentN) return messages;

    const cutoff = messages.length - keepRecentN;
    return messages.map((msg, i) => {
      if (i >= cutoff) return msg;
      if (msg.role !== "tool") return msg;

      // Summarize the tool result: first 100 chars
      const preview = msg.content.slice(0, 100).replace(/\n/g, " ");
      const suffix = msg.content.length > 100 ? "..." : "";
      return {
        ...msg,
        content: `[previous tool result: ${preview}${suffix}]`
      };
    });
  }

  /** Cleanup threads older than maxAgeMs. */
  cleanup(maxAgeMs: number): void {
    const now = Date.now();
    for (const [key, entry] of this.conversations) {
      if (now - entry.lastAccess > maxAgeMs) {
        this.conversations.delete(key);
        this.removePersistedEntry(key);
      }
    }
  }

  /** Number of stored conversations (for diagnostics). */
  get size(): number {
    return this.conversations.size;
  }

  /** Evict oldest entries when over the max cap. */
  private evictIfOverCap(): void {
    if (this.conversations.size <= this.maxEntries) return;
    const entries = [...this.conversations.entries()]
      .sort((a, b) => a[1].lastAccess - b[1].lastAccess);
    const toRemove = entries.length - this.maxEntries;
    for (let i = 0; i < toRemove; i++) {
      const key = entries[i]![0];
      this.conversations.delete(key);
      this.removePersistedEntry(key);
    }
  }

  /** Safely encode a thread key for use as a filename (round-trip safe). */
  private toFilename(threadKey: string): string {
    return encodeURIComponent(threadKey) + ".json";
  }

  /** Write a conversation entry to disk (async, fire-and-forget). */
  private persistEntry(threadKey: string, entry: StoredConversation): void {
    if (!this.persistDir) return;
    const filePath = path.join(this.persistDir, this.toFilename(threadKey));
    const tmpPath = filePath + ".tmp";
    const data = JSON.stringify(entry);
    writeFile(tmpPath, data, "utf8")
      .then(() => rename(tmpPath, filePath))
      .catch(() => {});
  }

  /** Remove a persisted conversation file (async, fire-and-forget). */
  private removePersistedEntry(threadKey: string): void {
    if (!this.persistDir) return;
    const filePath = path.join(this.persistDir, this.toFilename(threadKey));
    unlink(filePath).catch(() => {});
  }
}
