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
  process.stderr.write(`${JSON.stringify(entry)}\n`);
}
