CREATE TABLE "auth_credentials" (
	"domain" text PRIMARY KEY NOT NULL,
	"email_enc" "bytea" NOT NULL,
	"password_enc" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone DEFAULT now() NOT NULL,
	"login_successful" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"thread_key" text PRIMARY KEY NOT NULL,
	"messages" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"last_access" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "learning_outcomes" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"rule_id" text,
	"source" text NOT NULL,
	"repo_slug" text NOT NULL,
	"status" text NOT NULL,
	"error_category" text,
	"duration_ms" integer NOT NULL,
	"cost_usd" numeric(10, 4) NOT NULL,
	"changed_files" integer DEFAULT 0 NOT NULL,
	"pipeline_id" text,
	"timestamp" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "observer_daily_counters" (
	"counter_day" date PRIMARY KEY NOT NULL,
	"daily_count" integer DEFAULT 0 NOT NULL,
	"per_repo" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "observer_dedup" (
	"key" text PRIMARY KEY NOT NULL,
	"seen_at" bigint NOT NULL,
	"ttl_ms" bigint NOT NULL,
	"run_id" text,
	"rule_id" text,
	"completed_at" bigint
);
--> statement-breakpoint
CREATE TABLE "observer_poll_cursors" (
	"source_type" text NOT NULL,
	"source_key" text NOT NULL,
	"cursor_value" text NOT NULL,
	CONSTRAINT "observer_poll_cursors_source_type_source_key_pk" PRIMARY KEY("source_type","source_key")
);
--> statement-breakpoint
CREATE TABLE "observer_rate_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"timestamp_ms" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "observer_rule_outcomes" (
	"rule_id" text PRIMARY KEY NOT NULL,
	"success" integer DEFAULT 0 NOT NULL,
	"failure" integer DEFAULT 0 NOT NULL,
	"last_outcome" text DEFAULT '' NOT NULL,
	"last_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "pipelines" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"yaml" text NOT NULL,
	"is_built_in" boolean DEFAULT false NOT NULL,
	"node_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"status" text NOT NULL,
	"phase" text,
	"repo_slug" text NOT NULL,
	"task" text NOT NULL,
	"base_branch" text NOT NULL,
	"branch_name" text NOT NULL,
	"requested_by" text NOT NULL,
	"channel_id" text NOT NULL,
	"thread_ts" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"logs_path" text,
	"status_message_ts" text,
	"commit_sha" text,
	"changed_files" text[],
	"pr_url" text,
	"feedback" jsonb,
	"error" text,
	"parent_run_id" uuid,
	"root_run_id" uuid,
	"chain_index" integer,
	"parent_branch_name" text,
	"feedback_note" text,
	"pipeline_hint" text,
	"skip_nodes" text[],
	"enable_nodes" text[],
	"ci_fix_attempts" integer,
	"ci_conclusion" text,
	"pr_number" integer,
	"title" text,
	"token_usage" jsonb,
	"team_id" text
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"goal" text NOT NULL,
	"repo_slug" text NOT NULL,
	"base_branch" text NOT NULL,
	"status" text NOT NULL,
	"plan" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"context" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"max_runs" integer DEFAULT 10 NOT NULL,
	"completed_runs" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"requested_by" text NOT NULL,
	"channel_id" text NOT NULL,
	"thread_ts" text NOT NULL,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "setup" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"password_hash" text,
	"github_config" jsonb,
	"github_token_enc" "bytea",
	"github_app_key_enc" "bytea",
	"llm_config" jsonb,
	"llm_api_key_enc" "bytea",
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "conversations_last_access_idx" ON "conversations" USING btree ("last_access");--> statement-breakpoint
CREATE INDEX "lo_repo_slug_idx" ON "learning_outcomes" USING btree ("repo_slug");--> statement-breakpoint
CREATE INDEX "lo_rule_id_idx" ON "learning_outcomes" USING btree ("rule_id") WHERE rule_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "lo_source_idx" ON "learning_outcomes" USING btree ("source");--> statement-breakpoint
CREATE INDEX "lo_timestamp_idx" ON "learning_outcomes" USING btree ("timestamp");--> statement-breakpoint
CREATE INDEX "ore_source_ts_idx" ON "observer_rate_events" USING btree ("source","timestamp_ms");--> statement-breakpoint
CREATE INDEX "runs_status_idx" ON "runs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "runs_channel_thread_idx" ON "runs" USING btree ("channel_id","thread_ts");--> statement-breakpoint
CREATE INDEX "runs_repo_slug_idx" ON "runs" USING btree ("repo_slug");--> statement-breakpoint
CREATE INDEX "runs_created_at_idx" ON "runs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "runs_team_id_idx" ON "runs" USING btree ("team_id") WHERE team_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "sessions_status_idx" ON "sessions" USING btree ("status");