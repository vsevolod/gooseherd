CREATE TABLE IF NOT EXISTS "run_payloads" (
  "run_id" uuid PRIMARY KEY NOT NULL REFERENCES "runs"("id") ON DELETE CASCADE,
  "payload_ref" text NOT NULL,
  "payload_json" jsonb NOT NULL,
  "runtime" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "run_tokens" (
  "run_id" uuid PRIMARY KEY NOT NULL REFERENCES "runs"("id") ON DELETE CASCADE,
  "token_hash" text NOT NULL,
  "issued_at" timestamp with time zone DEFAULT now() NOT NULL,
  "used_at" timestamp with time zone,
  "expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "run_events" (
  "run_id" uuid NOT NULL REFERENCES "runs"("id") ON DELETE CASCADE,
  "event_id" text NOT NULL,
  "sequence" integer NOT NULL,
  "event_type" text NOT NULL,
  "payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "timestamp" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  PRIMARY KEY ("run_id", "event_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "run_completions" (
  "id" bigserial PRIMARY KEY NOT NULL,
  "run_id" uuid NOT NULL REFERENCES "runs"("id") ON DELETE CASCADE,
  "idempotency_key" text NOT NULL,
  "status" text NOT NULL,
  "payload" jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "run_artifacts" (
  "run_id" uuid NOT NULL REFERENCES "runs"("id") ON DELETE CASCADE,
  "artifact_key" text NOT NULL,
  "artifact_class" text NOT NULL,
  "status" text NOT NULL,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  PRIMARY KEY ("run_id", "artifact_key")
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "run_tokens_token_hash_idx" ON "run_tokens" ("token_hash");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "run_events_run_id_sequence_idx" ON "run_events" ("run_id", "sequence");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "run_completions_run_id_idempotency_key_idx"
  ON "run_completions" ("run_id", "idempotency_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "run_completions_run_id_created_at_idx"
  ON "run_completions" ("run_id", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "run_artifacts_run_id_idx" ON "run_artifacts" ("run_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "run_payloads_runtime_idx" ON "run_payloads" ("runtime");
