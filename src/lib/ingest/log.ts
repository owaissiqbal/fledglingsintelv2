type Level = "info" | "warn" | "error" | "debug";

const PREFIX_COLOUR: Record<Level, string> = {
  info: "\x1b[36m", // cyan
  warn: "\x1b[33m", // yellow
  error: "\x1b[31m", // red
  debug: "\x1b[90m", // grey
};
const RESET = "\x1b[0m";

function timestamp(): string {
  return new Date().toISOString().slice(11, 23);
}

function emit(level: Level, msg: string) {
  const colour = PREFIX_COLOUR[level];
  const line = `${colour}[${timestamp()} ${level.toUpperCase()}]${RESET} ${msg}`;
  if (level === "error") {
    console.error(line);
  } else {
    console.log(line);
  }
}

export const log = {
  info: (msg: string) => emit("info", msg),
  warn: (msg: string) => emit("warn", msg),
  error: (msg: string) => emit("error", msg),
  debug: (msg: string) => {
    if (process.env.LOG_LEVEL === "debug") emit("debug", msg);
  },
};
