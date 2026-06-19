export interface LogEntry {
  ts: string;
  level: string;
  message: string;
  meta?: unknown;
}

const MAX_LOG_ENTRIES = 300;
const logEntries: LogEntry[] = [];

export function log(message: string, meta?: unknown): void {
  write("info", message, meta);
}

export function warn(message: string, meta?: unknown): void {
  write("warn", message, meta);
}

export function error(message: string, meta?: unknown): void {
  write("error", message, meta);
}

function write(level: string, message: string, meta?: unknown): void {
  const entry = {
    ts: new Date().toISOString(),
    level,
    message,
    ...(meta === undefined ? {} : { meta }),
  };
  logEntries.push(entry);
  if (logEntries.length > MAX_LOG_ENTRIES) {
    logEntries.splice(0, logEntries.length - MAX_LOG_ENTRIES);
  }
  process.stderr.write(`${JSON.stringify(entry)}\n`);
}

export function recentLogs(limit = 100): LogEntry[] {
  const boundedLimit = Math.min(Math.max(limit, 1), MAX_LOG_ENTRIES);
  return logEntries.slice(-boundedLimit);
}
