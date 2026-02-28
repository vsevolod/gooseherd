#!/usr/bin/env npx tsx
/**
 * Standalone dashboard launcher for testing.
 * Usage: npx tsx scripts/start-dashboard.ts
 */

import dotenv from "dotenv";
dotenv.config({ override: true });

// Provide dummy Slack env vars so config validation passes
process.env.SLACK_BOT_TOKEN ??= "xoxb-dummy";
process.env.SLACK_APP_TOKEN ??= "xapp-dummy";
process.env.SLACK_SIGNING_SECRET ??= "dummy-signing-secret";

import { loadConfig } from "../src/config.js";
import { RunStore } from "../src/store.js";
import { startDashboardServer } from "../src/dashboard-server.js";

const config = loadConfig();
const store = new RunStore(config.workRoot);
await store.init();

console.log(`Dashboard running on http://localhost:${config.dashboardPort}`);
startDashboardServer(config, store);
