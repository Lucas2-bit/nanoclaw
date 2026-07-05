/**
 * Dynamic Model Selector for NanoClaw
 * ====================================
 * Config-driven model routing. Edit model-routing.json to update
 * models, pricing, or rules without code changes.
 *
 * Phase 1: Cloud models only (Opus/Sonnet/Haiku).
 * Phase 2: Local models via Ollama (add "local" tier to config).
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger } from './logger.js';

// ============================================================================
// Types
// ============================================================================

export type TaskComplexity = 'heavy' | 'medium' | 'light';

export interface RoutingContext {
  /** Character count of user prompt */
  promptLength: number;
  /** Mentions files, code, or technical work */
  hasCodeContext: boolean;
  /** From task-scheduler */
  isScheduledTask: boolean;
  /** Explicit model override from task config */
  taskModel?: string;
  /** Which group triggered this */
  groupFolder: string;
  /** Parago formation session */
  isFormation?: boolean;
  /** Estimated number of tool calls (file reads, searches, etc.) */
  estimatedToolCalls?: number;
}

export interface RoutingDecision {
  model: string;
  complexity: TaskComplexity;
  reason: string;
}

export interface RoutingLog {
  timestamp: string;
  groupFolder: string;
  complexity: TaskComplexity;
  model: string;
  reason: string;
  promptLengthBucket: '<1k' | '1k-10k' | '10k-50k' | '>50k';
  escalated: boolean;
  inputTokens?: number;
  outputTokens?: number;
  cost?: number;
}

export interface TokenPricing {
  input: number;
  output: number;
  cache_write: number;
  cache_read: number;
}

interface RoutingConfig {
  models: Record<TaskComplexity, string>;
  pricing: Record<string, TokenPricing>;
  pinnedGroups: string[];
  rules: Array<{
    condition: string;
    complexity: TaskComplexity;
    reason: string;
  }>;
  defaultComplexity: TaskComplexity;
  scheduledDefaultComplexity?: TaskComplexity;
  scheduledOpusTaskIds?: string[];
}

// ============================================================================
// Config Loading (reads once at import, restart to reload)
// ============================================================================

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadConfig(): RoutingConfig {
  try {
    // __dirname resolves to dist/ at runtime; model-routing.json lives in src/
    const configPath = join(__dirname, '..', 'src', 'model-routing.json');
    const raw = readFileSync(configPath, 'utf-8');
    const config = JSON.parse(raw) as RoutingConfig;
    logger.info(
      { models: config.models, ruleCount: config.rules.length },
      'Model routing config loaded',
    );
    return config;
  } catch (err) {
    logger.warn({ err }, 'Failed to load model-routing.json, using defaults');
    return {
      models: {
        heavy: 'claude-opus-4-8',
        medium: 'claude-sonnet-5',
        light: 'claude-haiku-4-5-20251001',
      },
      pricing: {
        'claude-opus-4-8': {
          input: 5.0,
          output: 25.0,
          cache_write: 6.25,
          cache_read: 0.5,
        },
        'claude-sonnet-4-6': {
          input: 3.0,
          output: 15.0,
          cache_write: 3.75,
          cache_read: 0.3,
        },
        'claude-sonnet-5': {
          input: 2.0,
          output: 10.0,
          cache_write: 2.5,
          cache_read: 0.2,
        },
        'claude-haiku-4-5-20251001': {
          input: 0.8,
          output: 4.0,
          cache_write: 1.0,
          cache_read: 0.08,
        },
        default: {
          input: 3.0,
          output: 15.0,
          cache_write: 3.75,
          cache_read: 0.3,
        },
      },
      pinnedGroups: ['telegram_main', 'whatsapp_main'],
      rules: [],
      defaultComplexity: 'medium',
      scheduledDefaultComplexity: 'medium',
      scheduledOpusTaskIds: ['pdny84', '8f7tzw', 'q6ssk4', 'n6h3tc'],
    };
  }
}

const config = loadConfig();

// ============================================================================
// Exported Config Accessors
// ============================================================================

/** Get pricing for a model (falls back to 'default' entry). */
export function getPricing(model: string): TokenPricing {
  return (
    config.pricing[model] ||
    config.pricing['default'] || {
      input: 3.0,
      output: 15.0,
      cache_write: 3.75,
      cache_read: 0.3,
    }
  );
}

/** Get the full pricing table (for credential-proxy SSE telemetry). */
export function getAllPricing(): Record<string, TokenPricing> {
  return config.pricing;
}

// ============================================================================
// Rule Evaluation
// ============================================================================

/**
 * Evaluate a condition string from the config against a routing context.
 * Supports: isFormation, hasCodeContext, promptLength, estimatedToolCalls
 */
function evaluateCondition(condition: string, ctx: RoutingContext): boolean {
  const c = condition.trim();

  // Boolean flags
  if (c === 'isFormation') return !!ctx.isFormation;
  if (c === 'hasCodeContext') return ctx.hasCodeContext;
  if (c === '!hasCodeContext') return !ctx.hasCodeContext;

  // Compound conditions with &&
  if (c.includes('&&')) {
    return c.split('&&').every((part) => evaluateCondition(part, ctx));
  }

  // Numeric comparisons
  const numMatch = c.match(/^(\w+)\s*(>|<|>=|<=|===?)\s*(\d+)$/);
  if (numMatch) {
    const [, field, op, valStr] = numMatch;
    const val = Number(valStr);
    let actual: number;

    switch (field) {
      case 'promptLength':
        actual = ctx.promptLength;
        break;
      case 'estimatedToolCalls':
        actual = ctx.estimatedToolCalls ?? 0;
        break;
      default:
        return false;
    }

    switch (op) {
      case '>':
        return actual > val;
      case '<':
        return actual < val;
      case '>=':
        return actual >= val;
      case '<=':
        return actual <= val;
      case '==':
      case '===':
        return actual === val;
      default:
        return false;
    }
  }

  return false;
}

// ============================================================================
// Core Selection
// ============================================================================

/**
 * Select the optimal model for a given task context.
 * Config-driven - edit model-routing.json to change behavior.
 */
export function selectModel(ctx: RoutingContext): RoutingDecision {
  // Explicit task model override always wins
  if (ctx.taskModel) {
    return {
      model: ctx.taskModel,
      complexity: 'heavy',
      reason: 'explicit-override',
    };
  }

  // Scheduled task model routing (safety-net fallback; task-scheduler normally pre-sets input.model)
  if (ctx.isScheduledTask) {
    const scheduledDefault = config.scheduledDefaultComplexity ?? 'medium';
    return {
      model:
        scheduledDefault === 'heavy'
          ? config.models.heavy
          : config.models.medium,
      complexity: scheduledDefault as TaskComplexity,
      reason: 'scheduled-default',
    };
  }

  // Pinned main groups default to the medium (Sonnet 5) model; escalate to Opus on demand.
  if (config.pinnedGroups.includes(ctx.groupFolder)) {
    return {
      model: config.models.medium,
      complexity: 'medium',
      reason: 'pinned-sonnet5-default',
    };
  }

  // Evaluate config-driven rules in order
  for (const rule of config.rules) {
    if (evaluateCondition(rule.condition, ctx)) {
      const complexity = rule.complexity as TaskComplexity;
      return {
        model: config.models[complexity],
        complexity,
        reason: rule.reason,
      };
    }
  }

  // Default
  const defaultComplexity = config.defaultComplexity;
  return {
    model: config.models[defaultComplexity],
    complexity: defaultComplexity,
    reason: 'default',
  };
}

// ============================================================================
// Scheduled Task Model Helper
// ============================================================================

/**
 * Resolve the model string for a scheduled task.
 * Carve-out IDs (scheduledOpusTaskIds in model-routing.json) get heavy (Opus).
 * All other scheduled tasks get medium (Sonnet).
 * Falls back to medium if config is unreadable (per loadConfig() defaults above).
 */
export function getScheduledTaskModel(taskId: string): string {
  const opusIds = new Set<string>(config.scheduledOpusTaskIds ?? []);
  return opusIds.has(taskId) ? config.models.heavy : config.models.medium;
}

// ============================================================================
// Escalation
// ============================================================================

const ESCALATION_MAP: Record<TaskComplexity, TaskComplexity | null> = {
  light: 'medium',
  medium: 'heavy',
  heavy: null,
};

/**
 * Escalate to the next tier when current tier produces a poor result.
 * Returns null if already at max tier.
 */
export function escalateModel(
  currentComplexity: TaskComplexity,
): RoutingDecision | null {
  const next = ESCALATION_MAP[currentComplexity];
  if (!next) return null;

  return {
    model: config.models[next],
    complexity: next,
    reason: `escalated-from-${currentComplexity}`,
  };
}

/**
 * Detect if a response indicates the model was too weak for the task.
 */
export function shouldEscalate(
  response: string | null,
  stopReason?: string,
  promptLength?: number,
): boolean {
  if (!response) return true;
  if (stopReason === 'max_tokens') return true;
  if (promptLength && promptLength > 1000 && response.length < 100) return true;
  return false;
}

// ============================================================================
// Logging Helpers
// ============================================================================

function getPromptLengthBucket(
  length: number,
): RoutingLog['promptLengthBucket'] {
  if (length < 1000) return '<1k';
  if (length < 10000) return '1k-10k';
  if (length < 50000) return '10k-50k';
  return '>50k';
}

/**
 * Build a structured routing log entry.
 * Caller is responsible for persisting this.
 */
export function buildRoutingLog(
  ctx: RoutingContext,
  decision: RoutingDecision,
  escalated = false,
): RoutingLog {
  return {
    timestamp: new Date().toISOString(),
    groupFolder: ctx.groupFolder,
    complexity: decision.complexity,
    model: decision.model,
    reason: decision.reason,
    promptLengthBucket: getPromptLengthBucket(ctx.promptLength),
    escalated,
  };
}
