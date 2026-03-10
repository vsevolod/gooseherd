ALTER TABLE "setup" ADD COLUMN "slack_config" jsonb;--> statement-breakpoint
ALTER TABLE "setup" ADD COLUMN "slack_bot_token_enc" "bytea";--> statement-breakpoint
ALTER TABLE "setup" ADD COLUMN "slack_app_token_enc" "bytea";