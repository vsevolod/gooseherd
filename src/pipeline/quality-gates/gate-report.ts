import type { ContextBag } from "../context-bag.js";

export interface GateReportEntry {
  gate: string;
  verdict: string;
  reasons: string[];
}

/**
 * Append a gate result to the accumulated gate report in context.
 * Replaces any previous entry for the same gate (prevents duplication
 * when a gate is re-run in a fix loop).
 */
export function appendGateReport(
  ctx: ContextBag,
  gateName: string,
  verdict: string,
  reasons: string[]
): void {
  const report = (ctx.get<GateReportEntry[]>("gateReport") ?? [])
    .filter(entry => entry.gate !== gateName);
  report.push({ gate: gateName, verdict, reasons });
  ctx.set("gateReport", report);
}
