import pc from 'picocolors';

export interface LoggerOptions {
  quiet?: boolean;
  verbose?: boolean;
  color?: boolean;
}

export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  debug(message: string): void;
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const quiet = options.quiet ?? false;
  const verbose = options.verbose ?? false;
  const color = options.color ?? process.stdout.isTTY;
  const paint = (fn: (value: string) => string, value: string): string =>
    color ? fn(value) : value;
  return {
    info(message) {
      if (!quiet) console.log(paint(pc.cyan, 'mockline'), message);
    },
    warn(message) {
      if (!quiet) console.warn(paint(pc.yellow, 'warning'), message);
    },
    error(message) {
      console.error(paint(pc.red, 'error'), message);
    },
    debug(message) {
      if (verbose && !quiet) console.log(paint(pc.dim, 'debug'), message);
    },
  };
}
