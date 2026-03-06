#!/usr/bin/env node
/**
 * Backfill costUsd on existing run records using Sonnet pricing.
 * Usage: node scripts/backfill-costs.mjs <runs.json path>
 */
import { readFileSync, writeFileSync, renameSync } from "fs";

const INPUT_PER_M = 3.00;   // anthropic/claude-sonnet-4-6
const OUTPUT_PER_M = 15.00;

const filePath = process.argv[2];
if (!filePath) { console.error("Usage: node backfill-costs.mjs <path/to/runs.json>"); process.exit(1); }

const data = JSON.parse(readFileSync(filePath, "utf8"));
const runs = data.runs || [];
let updated = 0;

for (const run of runs) {
  const tu = run.tokenUsage;
  if (!tu) continue;
  if (tu.costUsd) continue;

  const gateIn = tu.qualityGateInputTokens || 0;
  const gateOut = tu.qualityGateOutputTokens || 0;
  if (gateIn === 0 && gateOut === 0) continue;

  const costUsd = (gateIn / 1_000_000) * INPUT_PER_M + (gateOut / 1_000_000) * OUTPUT_PER_M;
  tu.costUsd = Math.round(costUsd * 10000) / 10000;
  updated++;
  console.log(`  ${run.id.slice(0,8)}  gate=${gateIn}/${gateOut}  cost=$${tu.costUsd.toFixed(4)}  ${(run.title || "(none)").slice(0,45)}`);
}

if (updated > 0) {
  const tmpPath = filePath + ".tmp";
  writeFileSync(tmpPath, JSON.stringify(data, null, 2));
  renameSync(tmpPath, filePath);
  console.log(`\nUpdated ${updated} runs in ${filePath}`);
} else {
  console.log(`No runs to update in ${filePath}`);
}
