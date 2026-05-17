/**
 * Parago Provider Router
 * ======================
 * Intercepts API calls flowing through the credential proxy.
 * v0.1: Anthropic-only with telemetry logging.
 * v0.2+: Multi-provider routing (Ollama, OpenAI, Gemini, Mistral).
 *
 * Architecture: all container API calls flow through the credential proxy.
 * This module wraps the upstream call to:
 *  1. Parse the request (extract model, detect provider)
 *  2. Route to the correct upstream
 *  3. Capture the response (extract token usage)
 *  4. Log telemetry (model, tokens, cost, latency)
 *
 * Zero new dependencies. Uses Node.js stdlib only.
 */

import { appendFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger } from './logger.js';
import type { RoutingLog } from './model-selector.js';

// ============================================================================
// Types
// ============================================================================

export interface ProviderAdapter {
  name: string;
  /** Can this adapter handle the given model? */
  supportsModel(model: string): boolean;
  /** Transform request headers for this provider */
  transformHeaders(headers: Record<string, string>, credentials: Record<string, string>): Record<string, string>;
  /** Target upstream URL */
  getUpstreamUrl(): URL;
  /** Extract token usage from response body */
  extractUsage(responseBody: Record<string, unknown>): TokenUsage | null;
  /** Calculate cost in USD for given usage */
  calculateCost(model: string, usage: TokenUsage): number;
}

export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

export interface TelemetryEntry {
  ts: string;
  model: string;
  provider: string;
  input_tokens: number;
  output_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
  cost_usd: number;
  latency_ms: number;
  request_path: string;
  status_code: number;
}

// ============================================================================
// Pricing: loaded from model-routing.json via model-selector
// ============================================================================

import { getPricing, type TokenPricing } from './model-selector.js';

// ============================================================================
// Anthropic Adapter (v0.1 - the only real adapter)
// ============================================================================

class AnthropicAdapter implements ProviderAdapter {
  name = 'anthropic';

  supportsModel(model: string): boolean {
    return model.startsWith('claude-');
  }

  transformHeaders(headers: Record<string, string>, credentials: Record<string, string>): Record<string, string> {
    // Credential proxy already handles auth injection - this is a no-op for v0.1
    return headers;
  }

  getUpstreamUrl(): URL {
    return new URL('https://api.anthropic.com');
  }

  extractUsage(body: Record<string, unknown>): TokenUsage | null {
    const usage = body.usage as Record<string, number> | undefined;
    if (!usage) return null;
    return {
      input_tokens: usage.input_tokens || 0,
      output_tokens: usage.output_tokens || 0,
      cache_creation_input_tokens: usage.cache_creation_input_tokens || 0,
      cache_read_input_tokens: usage.cache_read_input_tokens || 0,
    };
  }

  calculateCost(model: string, usage: TokenUsage): number {
    const pricing = getPricing(model);
    const perM = 1_000_000;
    return (
      (usage.input_tokens * pricing.input) / perM +
      (usage.output_tokens * pricing.output) / perM +
      ((usage.cache_creation_input_tokens || 0) * pricing.cache_write) / perM +
      ((usage.cache_read_input_tokens || 0) * pricing.cache_read) / perM
    );
  }
}

// ============================================================================
// Stub Adapters (interface-only, v0.2+)
// ============================================================================

class OllamaAdapter implements ProviderAdapter {
  name = 'ollama';
  supportsModel(model: string): boolean { return false; } // Not active in v0.1
  transformHeaders(h: Record<string, string>): Record<string, string> { return h; }
  getUpstreamUrl(): URL { return new URL('http://localhost:11434'); }
  extractUsage(): TokenUsage | null { return null; }
  calculateCost(): number { return 0; } // Local = free
}

class OpenAIAdapter implements ProviderAdapter {
  name = 'openai';
  supportsModel(model: string): boolean { return false; } // Not active in v0.1
  transformHeaders(h: Record<string, string>): Record<string, string> { return h; }
  getUpstreamUrl(): URL { return new URL('https://api.openai.com'); }
  extractUsage(): TokenUsage | null { return null; }
  calculateCost(): number { return 0; }
}

// ============================================================================
// Provider Router
// ============================================================================

const __dirname = dirname(fileURLToPath(import.meta.url));
// Use __dirname (not process.cwd()) so telemetry path survives pm2 restarts from any cwd
const DATA_DIR = join(__dirname, '..', 'data');
const TELEMETRY_FILE = join(DATA_DIR, 'api-calls.jsonl');
const ROUTING_LOG_FILE = join(DATA_DIR, 'routing-decisions.jsonl');

const adapters: ProviderAdapter[] = [
  new AnthropicAdapter(),
  new OllamaAdapter(),
  new OpenAIAdapter(),
];

let dataReady = false;

async function ensureDataDir(): Promise<void> {
  if (dataReady) return;
  if (!existsSync(DATA_DIR)) {
    await mkdir(DATA_DIR, { recursive: true });
  }
  dataReady = true;
}

/**
 * Extract model name from a request body buffer.
 * Anthropic format: { "model": "claude-sonnet-4-6", ... }
 */
export function extractModelFromRequest(body: Buffer): string | null {
  try {
    const parsed = JSON.parse(body.toString('utf-8'));
    return parsed.model || null;
  } catch {
    return null;
  }
}

/**
 * Resolve which adapter handles a given model.
 * v0.1: always returns Anthropic.
 */
export function resolveAdapter(model: string | null): ProviderAdapter {
  if (!model) return adapters[0]; // Default to Anthropic
  for (const adapter of adapters) {
    if (adapter.supportsModel(model)) return adapter;
  }
  return adapters[0]; // Fallback to Anthropic
}

/**
 * Log telemetry for a completed API call.
 * Appends a JSON line to the telemetry file.
 */
export async function logTelemetry(entry: TelemetryEntry): Promise<void> {
  try {
    await ensureDataDir();
    const line = JSON.stringify(entry) + '\n';
    await appendFile(TELEMETRY_FILE, line, 'utf-8');
    logger.debug(
      { model: entry.model, cost: entry.cost_usd.toFixed(4), tokens: entry.input_tokens + entry.output_tokens },
      'API call logged',
    );
  } catch (err) {
    logger.error({ err }, 'Failed to write telemetry');
  }
}

/**
 * Process a completed API response: extract usage, calculate cost, log.
 * Called by the credential proxy after buffering the response body.
 */
export function processResponse(
  requestBody: Buffer,
  responseBody: Buffer,
  statusCode: number,
  requestPath: string,
  startTime: number,
): void {
  // Only process /v1/messages (the main inference endpoint)
  if (!requestPath.includes('/messages')) return;

  const model = extractModelFromRequest(requestBody);
  const adapter = resolveAdapter(model);

  let usage: TokenUsage | null = null;
  try {
    const parsed = JSON.parse(responseBody.toString('utf-8'));
    usage = adapter.extractUsage(parsed);
  } catch {
    // Response might be streaming or error - skip
    return;
  }

  if (!usage) return;

  const cost = adapter.calculateCost(model || 'unknown', usage);
  const latency = Date.now() - startTime;

  const entry: TelemetryEntry = {
    ts: new Date().toISOString(),
    model: model || 'unknown',
    provider: adapter.name,
    input_tokens: usage.input_tokens,
    output_tokens: usage.output_tokens,
    cache_creation_tokens: usage.cache_creation_input_tokens || 0,
    cache_read_tokens: usage.cache_read_input_tokens || 0,
    cost_usd: cost,
    latency_ms: latency,
    request_path: requestPath,
    status_code: statusCode,
  };

  // Fire-and-forget - but log errors instead of swallowing them
  logTelemetry(entry).catch((err) => {
    logger.error({ err }, 'Telemetry fire-and-forget failed');
  });
}

/**
 * Log a routing decision for auditing and cost analysis.
 */
export async function logRoutingDecision(entry: RoutingLog): Promise<void> {
  try {
    await ensureDataDir();
    const line = JSON.stringify(entry) + '\n';
    await appendFile(ROUTING_LOG_FILE, line, 'utf-8');
  } catch (err) {
    logger.error({ err }, 'Failed to write routing log');
  }
}

export { TELEMETRY_FILE, DATA_DIR, ROUTING_LOG_FILE };
