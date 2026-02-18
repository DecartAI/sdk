export type LogLevel = "debug" | "info" | "warn" | "error";

export type Logger = {
  debug: (message: string, data?: Record<string, unknown>) => void;
  info: (message: string, data?: Record<string, unknown>) => void;
  warn: (message: string, data?: Record<string, unknown>) => void;
  error: (message: string, data?: Record<string, unknown>) => void;
};

/** A logger that discards all messages. Zero overhead. */
export const noopLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

const LOG_LEVELS: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

/**
 * Creates a console-based logger that only logs messages at or above the given level.
 *
 * @param minLevel - Minimum log level to output. Default: "warn".
 */
export function createConsoleLogger(minLevel: LogLevel = "warn"): Logger {
  const threshold = LOG_LEVELS[minLevel];

  const log = (level: LogLevel, message: string, data?: Record<string, unknown>) => {
    if (LOG_LEVELS[level] < threshold) return;
    const prefix = "[DecartSDK]";
    if (data) {
      console[level](prefix, message, data);
    } else {
      console[level](prefix, message);
    }
  };

  return {
    debug: (msg, data) => log("debug", msg, data),
    info: (msg, data) => log("info", msg, data),
    warn: (msg, data) => log("warn", msg, data),
    error: (msg, data) => log("error", msg, data),
  };
}
