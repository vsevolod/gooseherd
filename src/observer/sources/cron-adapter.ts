/**
 * Cron Source Adapter — emits TriggerEvents on a schedule.
 *
 * Parses standard cron expressions (min hour dom month dow) with support
 * for wildcards (*), ranges (1-5), lists (1,3,5), and steps (star/5).
 * No external dependencies — cron parsing is inline.
 */

import { logInfo, logWarn } from "../../logger.js";
import type { TriggerEvent, TriggerRule } from "../types.js";

// ── Cron expression parser ──

export interface CronFields {
  minute: number[] | null;   // null = wildcard (match any)
  hour: number[] | null;
  dayOfMonth: number[] | null;
  month: number[] | null;
  dayOfWeek: number[] | null;
}

/**
 * Parse a single cron field token into a sorted array of matching values,
 * or null for wildcard (*).
 *
 * Supports: *, N, N-M, N,M,O, *​/S, N-M/S
 */
function parseCronField(token: string, min: number, max: number): number[] | null {
  if (token === "*") return null;

  const values = new Set<number>();

  for (const part of token.split(",")) {
    const stepMatch = part.match(/^(.+)\/(\d+)$/);
    if (stepMatch) {
      const [, range, stepStr] = stepMatch;
      const step = Number(stepStr);
      if (step <= 0) throw new Error(`Invalid step: ${token}`);

      let start = min;
      let end = max;

      if (range !== "*") {
        const dashMatch = range!.match(/^(\d+)-(\d+)$/);
        if (dashMatch) {
          start = Number(dashMatch[1]);
          end = Number(dashMatch[2]);
        } else {
          start = Number(range);
          end = max;
        }
      }

      if (isNaN(start) || isNaN(end)) throw new Error(`Invalid range: ${token}`);

      for (let i = start; i <= end; i += step) {
        if (i >= min && i <= max) values.add(i);
      }
      continue;
    }

    const dashMatch = part.match(/^(\d+)-(\d+)$/);
    if (dashMatch) {
      const start = Number(dashMatch[1]);
      const end = Number(dashMatch[2]);
      if (isNaN(start) || isNaN(end) || start > end) throw new Error(`Invalid range: ${token}`);
      for (let i = start; i <= end; i++) {
        if (i >= min && i <= max) values.add(i);
      }
      continue;
    }

    const num = Number(part);
    if (isNaN(num) || num < min || num > max) throw new Error(`Invalid value: ${token}`);
    values.add(num);
  }

  if (values.size === 0) throw new Error(`Empty field: ${token}`);
  return Array.from(values).sort((a, b) => a - b);
}

/**
 * Parse a standard 5-field cron expression.
 *
 * Format: minute hour dayOfMonth month dayOfWeek
 * Returns CronFields or null if the expression is invalid.
 */
export function parseCronExpression(expr: string): CronFields | null {
  const trimmed = expr.trim();
  const parts = trimmed.split(/\s+/);
  if (parts.length !== 5) return null;

  try {
    return {
      minute: parseCronField(parts[0]!, 0, 59),
      hour: parseCronField(parts[1]!, 0, 23),
      dayOfMonth: parseCronField(parts[2]!, 1, 31),
      month: parseCronField(parts[3]!, 1, 12),
      dayOfWeek: parseCronField(parts[4]!, 0, 6)
    };
  } catch {
    return null;
  }
}

/**
 * Check if cron fields match the given date.
 */
export function cronMatchesDate(fields: CronFields, date: Date): boolean {
  const minute = date.getMinutes();
  const hour = date.getHours();
  const dayOfMonth = date.getDate();
  const month = date.getMonth() + 1; // JS months are 0-based
  const dayOfWeek = date.getDay();    // 0 = Sunday

  if (fields.minute !== null && !fields.minute.includes(minute)) return false;
  if (fields.hour !== null && !fields.hour.includes(hour)) return false;
  if (fields.dayOfMonth !== null && !fields.dayOfMonth.includes(dayOfMonth)) return false;
  if (fields.month !== null && !fields.month.includes(month)) return false;
  if (fields.dayOfWeek !== null && !fields.dayOfWeek.includes(dayOfWeek)) return false;

  return true;
}

/**
 * Convenience: check if cron fields match the current time.
 */
export function cronMatchesNow(fields: CronFields): boolean {
  return cronMatchesDate(fields, new Date());
}

// ── Cron scheduler ──

export interface CronSchedulerHandle {
  stop(): void;
}

interface ParsedCronRule {
  rule: TriggerRule;
  cronExpression: string;
  fields: CronFields;
}

/**
 * Extract the cron schedule expression from a trigger rule's conditions.
 *
 * Looks for a condition with field="schedule", operator="equals", and value as the cron expression.
 */
function extractSchedule(rule: TriggerRule): string | null {
  const cond = rule.conditions.find(c => c.field === "schedule" && c.operator === "equals" && c.value);
  return cond?.value ?? null;
}

/**
 * Start a cron scheduler that checks all cron-source rules every 60 seconds
 * and emits TriggerEvents when a schedule matches the current time.
 *
 * Only processes rules where source === "cron".
 */
export function startCronScheduler(
  rules: TriggerRule[],
  onEvent: (event: TriggerEvent) => void
): CronSchedulerHandle {
  const cronRules = rules.filter(r => r.source === "cron");
  const parsed: ParsedCronRule[] = [];

  for (const rule of cronRules) {
    const schedule = extractSchedule(rule);
    if (!schedule) {
      logWarn("Cron rule has no schedule condition, skipping", { ruleId: rule.id });
      continue;
    }

    const fields = parseCronExpression(schedule);
    if (!fields) {
      logWarn("Cron rule has invalid cron expression, skipping", { ruleId: rule.id, schedule });
      continue;
    }

    parsed.push({ rule, cronExpression: schedule, fields });
  }

  if (parsed.length === 0) {
    logInfo("Cron scheduler: no valid cron rules to schedule");
    return { stop() {} };
  }

  logInfo("Cron scheduler: registered rules", {
    count: parsed.length,
    ruleIds: parsed.map(p => p.rule.id)
  });

  const interval = setInterval(() => {
    const now = new Date();

    for (const { rule, cronExpression, fields } of parsed) {
      if (cronMatchesDate(fields, now)) {
        const event: TriggerEvent = {
          id: `cron-${rule.id}-${Date.now()}`,
          source: "cron",
          timestamp: now.toISOString(),
          repoSlug: rule.repoSlug,
          suggestedTask: rule.task,
          baseBranch: rule.baseBranch,
          priority: "medium",
          rawPayload: { schedule: cronExpression, ruleId: rule.id },
          notificationTarget: {
            type: rule.notificationChannel ? "slack" : "dashboard_only",
            channelId: rule.notificationChannel
          }
        };

        logInfo("Cron scheduler: schedule matched, emitting event", {
          ruleId: rule.id,
          schedule: cronExpression
        });

        onEvent(event);
      }
    }
  }, 60_000);

  // Don't keep the process alive just for cron checks
  interval.unref?.();

  return {
    stop() {
      clearInterval(interval);
    }
  };
}
