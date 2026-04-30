/**
 * Parago Cost Tracker
 * ===================
 * Query functions over the telemetry JSONL produced by the provider router.
 * Reads api-calls.jsonl and provides aggregated cost views.
 *
 * Zero dependencies beyond Node.js stdlib.
 */

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { logger } from './logger.js';
import { type TelemetryEntry, DATA_DIR, TELEMETRY_FILE } from './provider-router.js';

// ============================================================================
// Query Functions
// ============================================================================

async function readEntries(since?: Date): Promise<TelemetryEntry[]> {
  if (!existsSync(TELEMETRY_FILE)) return [];

  const content = await readFile(TELEMETRY_FILE, 'utf-8');
  const entries: TelemetryEntry[] = [];

  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as TelemetryEntry;
      if (since && new Date(entry.ts) < since) continue;
      entries.push(entry);
    } catch {
      // Skip malformed lines
    }
  }

  return entries;
}

export interface CostSummary {
  total_usd: number;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cache_creation_tokens: number;
  total_cache_read_tokens: number;
  call_count: number;
  avg_latency_ms: number;
}

function summarise(entries: TelemetryEntry[]): CostSummary {
  const summary: CostSummary = {
    total_usd: 0,
    total_input_tokens: 0,
    total_output_tokens: 0,
    total_cache_creation_tokens: 0,
    total_cache_read_tokens: 0,
    call_count: entries.length,
    avg_latency_ms: 0,
  };

  let totalLatency = 0;
  for (const e of entries) {
    summary.total_usd += e.cost_usd;
    summary.total_input_tokens += e.input_tokens;
    summary.total_output_tokens += e.output_tokens;
    summary.total_cache_creation_tokens += e.cache_creation_tokens;
    summary.total_cache_read_tokens += e.cache_read_tokens;
    totalLatency += e.latency_ms;
  }
  summary.avg_latency_ms = entries.length > 0 ? totalLatency / entries.length : 0;

  return summary;
}

/** Get total cost for today (since midnight local time). */
export async function getCostToday(): Promise<CostSummary> {
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  const entries = await readEntries(midnight);
  return summarise(entries);
}

/** Get cost breakdown by model since a given date. */
export async function getCostByModel(since?: Date): Promise<Record<string, CostSummary>> {
  const entries = await readEntries(since);
  const byModel: Record<string, TelemetryEntry[]> = {};

  for (const e of entries) {
    if (!byModel[e.model]) byModel[e.model] = [];
    byModel[e.model].push(e);
  }

  const result: Record<string, CostSummary> = {};
  for (const [model, modelEntries] of Object.entries(byModel)) {
    result[model] = summarise(modelEntries);
  }
  return result;
}

/** Get cost breakdown by provider since a given date. */
export async function getCostByProvider(since?: Date): Promise<Record<string, CostSummary>> {
  const entries = await readEntries(since);
  const byProvider: Record<string, TelemetryEntry[]> = {};

  for (const e of entries) {
    if (!byProvider[e.provider]) byProvider[e.provider] = [];
    byProvider[e.provider].push(e);
  }

  const result: Record<string, CostSummary> = {};
  for (const [provider, provEntries] of Object.entries(byProvider)) {
    result[provider] = summarise(provEntries);
  }
  return result;
}

/** Get total cost for a time range. */
export async function getCostRange(from: Date, to: Date): Promise<CostSummary> {
  const entries = await readEntries(from);
  const filtered = entries.filter(e => new Date(e.ts) <= to);
  return summarise(filtered);
}

/** Check if daily spend exceeds a threshold. Returns null if under, or the summary if over. */
export async function checkBudget(dailyLimitUsd: number): Promise<{ over: boolean; summary: CostSummary }> {
  const summary = await getCostToday();
  return { over: summary.total_usd >= dailyLimitUsd, summary };
}

/** Format a cost summary as a human-readable string. */
export function formatCostSummary(label: string, summary: CostSummary): string {
  return [
    `${label}:`,
    `  Cost: $${summary.total_usd.toFixed(4)}`,
    `  Calls: ${summary.call_count}`,
    `  Tokens: ${summary.total_input_tokens.toLocaleString()} in / ${summary.total_output_tokens.toLocaleString()} out`,
    `  Cache: ${summary.total_cache_creation_tokens.toLocaleString()} created / ${summary.total_cache_read_tokens.toLocaleString()} read`,
    `  Avg latency: ${Math.round(summary.avg_latency_ms)}ms`,
  ].join('\n');
}
