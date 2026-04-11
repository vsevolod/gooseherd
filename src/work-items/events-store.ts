import type { Database } from "../db/index.js";
import { workItemEvents } from "../db/schema.js";
import type { AppendWorkItemEventInput } from "./types.js";

export class WorkItemEventsStore {
  constructor(private readonly db: Database) {}

  async append(input: AppendWorkItemEventInput): Promise<void> {
    await this.db.insert(workItemEvents).values({
      workItemId: input.workItemId,
      eventType: input.eventType,
      payload: input.payload ?? {},
      actorUserId: input.actorUserId,
      createdAt: new Date(),
    });
  }
}
