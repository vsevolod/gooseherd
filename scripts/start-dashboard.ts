#!/usr/bin/env npx tsx
/**
 * Standalone dashboard launcher for testing.
 * Usage: npx tsx scripts/start-dashboard.ts
 */

import dotenv from "dotenv";
dotenv.config();

import { loadConfig } from "../src/config.js";
import { RunStore } from "../src/store.js";
import { startDashboardServer } from "../src/dashboard-server.js";

const config = loadConfig();
const store = new RunStore(config.dataDir);
await store.init();

console.log(`Dashboard running on http://localhost:${config.dashboardPort}`);
startDashboardServer(config, store);
