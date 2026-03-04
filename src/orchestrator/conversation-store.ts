/**
 * In-memory conversation store — persists full LLM message history per thread.
 * Keyed by `channelId:threadTs`. Ephemeral (no database).
 */

import type { ChatMessage } from "../llm/caller.js";

interface StoredConversation {
  messages: ChatMessage[];
  lastAccess: number;
}

export class ConversationStore {
  private conversations = new Map<string, StoredConversation>();

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
    this.conversations.set(threadKey, {
      messages: filtered,
      lastAccess: Date.now()
    });
  }

  /** Delete a thread's conversation. */
  delete(threadKey: string): void {
    this.conversations.delete(threadKey);
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
      }
    }
  }

  /** Number of stored conversations (for diagnostics). */
  get size(): number {
    return this.conversations.size;
  }
}
