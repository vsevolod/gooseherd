ALTER TABLE "runs"
  ADD COLUMN IF NOT EXISTS "runtime" text NOT NULL DEFAULT 'local';
--> statement-breakpoint
UPDATE "runs"
SET "runtime" = 'local'
WHERE "runtime" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "runs_runtime_idx" ON "runs" ("runtime");
