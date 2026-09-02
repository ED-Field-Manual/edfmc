/**
 * Structured logging (§25).
 *
 * Two rules shape this module:
 *  - journal payloads are never logged. A journal line contains commander identity,
 *    financial state and travel history; §21 says none of that leaves the machine,
 *    and writing it to a log file that a user later attaches to a bug report is a
 *    quiet way to break that promise. Event *names* and counts are fine.
 *  - anything resembling a secret is redacted before it reaches a sink.
 */

export type LogLevel = 'error' | 'warn' | 'info' | 'debug' | 'trace';

const ORDER: Record<LogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3, trace: 4 };

export interface LogEntry {
  readonly at: string;
  readonly level: LogLevel;
  readonly scope: string;
  readonly message: string;
  readonly fields?: Record<string, unknown>;
}

const SECRET_KEYS = /^(token|secret|password|passwd|apikey|api_key|authorization|webhook|cookie)$/i;
const SECRET_VALUE = /(https:\/\/discord(app)?\.com\/api\/webhooks\/\S+)|(Bearer\s+\S+)/gi;

/** Redact obvious secrets. Applied to every entry, including developer-authored ones. */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[deep]';
  if (typeof value === 'string') return value.replace(SECRET_VALUE, '[redacted]');
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redact(v, depth + 1));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEYS.test(k) ? '[redacted]' : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

export class Logger {
  private level: LogLevel = 'info';
  private readonly buffer: LogEntry[] = [];
  private readonly limit = 1000;
  private readonly listeners = new Set<(e: LogEntry) => void>();

  setLevel(level: LogLevel): void {
    this.level = level;
  }

  getLevel(): LogLevel {
    return this.level;
  }

  subscribe(fn: (e: LogEntry) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Most recent entries, newest last. Used by the Diagnostics screen. */
  entries(): readonly LogEntry[] {
    return this.buffer;
  }

  log(level: LogLevel, scope: string, message: string, fields?: Record<string, unknown>): void {
    if (ORDER[level] > ORDER[this.level]) return;

    const entry: LogEntry = {
      at: new Date().toISOString(),
      level,
      scope,
      message,
      ...(fields ? { fields: redact(fields) as Record<string, unknown> } : {}),
    };

    this.buffer.push(entry);
    if (this.buffer.length > this.limit) this.buffer.splice(0, this.buffer.length - this.limit);
    for (const fn of this.listeners) fn(entry);

    const line = `[${entry.level}] ${entry.scope}: ${entry.message}`;
    if (level === 'error') console.error(line, entry.fields ?? '');
    else if (level === 'warn') console.warn(line, entry.fields ?? '');
    else console.log(line, entry.fields ?? '');
  }

  error(scope: string, msg: string, f?: Record<string, unknown>) { this.log('error', scope, msg, f); }
  warn(scope: string, msg: string, f?: Record<string, unknown>) { this.log('warn', scope, msg, f); }
  info(scope: string, msg: string, f?: Record<string, unknown>) { this.log('info', scope, msg, f); }
  debug(scope: string, msg: string, f?: Record<string, unknown>) { this.log('debug', scope, msg, f); }
  trace(scope: string, msg: string, f?: Record<string, unknown>) { this.log('trace', scope, msg, f); }

  /**
   * Diagnostics bundle (§25). Contains versions, watcher state and counters —
   * deliberately no journal content and no commander identity.
   */
  exportDiagnostics(extra: Record<string, unknown>): string {
    return JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : 'unknown',
        logLevel: this.level,
        ...(redact(extra) as Record<string, unknown>),
        recentLogs: this.buffer.slice(-200),
      },
      null,
      2,
    );
  }
}

export const logger = new Logger();
