import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { eq, and } from "drizzle-orm";
import { logInfo, logWarn } from "../logger.js";
import { loadPipelineFromString, PipelineLoadError } from "./pipeline-loader.js";
import type { PipelineConfig } from "./types.js";
import type { Database } from "../db/index.js";
import { pipelines } from "../db/schema.js";

export interface StoredPipeline {
  id: string;
  name: string;
  description?: string;
  yaml: string;
  isBuiltIn: boolean;
  nodeCount: number;
  createdAt: string;
  updatedAt: string;
}

function rowToStored(row: typeof pipelines.$inferSelect): StoredPipeline {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? undefined,
    yaml: row.yaml,
    isBuiltIn: row.isBuiltIn,
    nodeCount: row.nodeCount,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export class PipelineStore {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  /** Initialize: seed from disk YAML files. Migrations handle schema. */
  async init(pipelinesDir: string): Promise<void> {
    await this.seedFromDisk(pipelinesDir);
  }

  /** List all pipelines (built-in + user-created). */
  list(): StoredPipeline[] {
    // Sync wrapper for cached data — but now we use async internally
    // This is called synchronously in some places, so we maintain the cache pattern
    return this._cachedList;
  }

  /** Async version for when you can await. */
  async listAsync(): Promise<StoredPipeline[]> {
    const rows = await this.db.select().from(pipelines);
    this._cachedList = rows.map(rowToStored);
    return this._cachedList;
  }

  /** Get a pipeline by ID. */
  get(id: string): StoredPipeline | undefined {
    return this._cachedList.find((p) => p.id === id);
  }

  /** Async get from DB. */
  async getAsync(id: string): Promise<StoredPipeline | undefined> {
    const rows = await this.db.select().from(pipelines).where(eq(pipelines.id, id));
    return rows[0] ? rowToStored(rows[0]) : undefined;
  }

  /** Save a new or updated pipeline. Validates YAML first. */
  async save(id: string, yaml: string): Promise<StoredPipeline> {
    const existing = await this.getAsync(id);
    if (existing?.isBuiltIn) {
      throw new PipelineLoadError(`Cannot overwrite built-in pipeline '${id}'`);
    }

    const config = loadPipelineFromString(yaml);
    const now = new Date();

    if (existing) {
      await this.db
        .update(pipelines)
        .set({
          name: config.name,
          description: config.description,
          yaml,
          nodeCount: config.nodes.length,
          updatedAt: now,
        })
        .where(eq(pipelines.id, id));
    } else {
      await this.db.insert(pipelines).values({
        id,
        name: config.name,
        description: config.description,
        yaml,
        isBuiltIn: false,
        nodeCount: config.nodes.length,
        createdAt: now,
        updatedAt: now,
      });
    }

    await this.refreshCache();
    return this._cachedList.find((p) => p.id === id)!;
  }

  /** Delete a pipeline (only non-built-in). Returns true if deleted. */
  async delete(id: string): Promise<boolean> {
    const existing = await this.getAsync(id);
    if (!existing || existing.isBuiltIn) return false;

    await this.db
      .delete(pipelines)
      .where(and(eq(pipelines.id, id), eq(pipelines.isBuiltIn, false)));
    await this.refreshCache();
    return true;
  }

  /** Validate YAML without saving. Returns the parsed config or throws. */
  validate(yaml: string): PipelineConfig {
    return loadPipelineFromString(yaml);
  }

  // ── Private helpers ──

  /** In-memory cache for sync access. Refreshed on mutations and init. */
  private _cachedList: StoredPipeline[] = [];

  private async refreshCache(): Promise<void> {
    const rows = await this.db.select().from(pipelines);
    this._cachedList = rows.map(rowToStored);
  }

  private async seedFromDisk(pipelinesDir: string): Promise<void> {
    let files: string[];
    try {
      const entries = await readdir(pipelinesDir);
      files = entries.filter((f) => f.endsWith(".yml"));
    } catch {
      logWarn("Pipelines directory not found, skipping seed", { dir: pipelinesDir });
      return;
    }

    for (const file of files) {
      const id = file.replace(/\.yml$/, "");
      const filePath = path.join(pipelinesDir, file);
      let yaml: string;
      try {
        yaml = await readFile(filePath, "utf8");
      } catch {
        logWarn("Could not read pipeline file", { file: filePath });
        continue;
      }

      let config: PipelineConfig;
      try {
        config = loadPipelineFromString(yaml);
      } catch (err) {
        const msg = err instanceof Error ? err.message : "unknown";
        logWarn("Invalid built-in pipeline, skipping", { file, error: msg });
        continue;
      }

      const now = new Date();
      // Upsert: update existing built-in, insert new ones
      const existing = await this.getAsync(id);
      if (existing) {
        await this.db
          .update(pipelines)
          .set({
            name: config.name,
            description: config.description,
            yaml,
            isBuiltIn: true,
            nodeCount: config.nodes.length,
            updatedAt: now,
          })
          .where(eq(pipelines.id, id));
      } else {
        await this.db.insert(pipelines).values({
          id,
          name: config.name,
          description: config.description,
          yaml,
          isBuiltIn: true,
          nodeCount: config.nodes.length,
          createdAt: now,
          updatedAt: now,
        });
      }
    }

    await this.refreshCache();
    if (files.length > 0) {
      logInfo("Seeded built-in pipelines", { count: files.length });
    }
  }
}
