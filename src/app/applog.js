import { debug as logDebug, error as logError, info as logInfo, warn as logWarn } from "@tauri-apps/plugin-log";

function describe(value) {
  if (value instanceof Error) return value.stack || value.message;
  if (typeof value === "object" && value !== null) {
    try { return JSON.stringify(value); } catch { return String(value); }
  }
  return String(value);
}

export function tagLogger(tag) {
  const prefix = `[${tag}]`;
  return {
    debug: (...args) => { console.debug(prefix, ...args); logDebug(`${prefix} ${args.map(describe).join(" ")}`).catch(() => {}); },
    info: (...args) => { console.log(prefix, ...args); logInfo(`${prefix} ${args.map(describe).join(" ")}`).catch(() => {}); },
    warn: (...args) => console.warn(prefix, ...args),
    error: (...args) => console.error(prefix, ...args),
  };
}

export function installFileLogging() {
  const origError = console.error.bind(console);
  console.error = (...args) => {
    origError(...args);
    logError(args.map(describe).join(" ")).catch(() => { });
  };

  const origWarn = console.warn.bind(console);
  console.warn = (...args) => {
    origWarn(...args);
    logWarn(args.map(describe).join(" ")).catch(() => {});
  };

  window.addEventListener("error", event => {
    logError(`Необработанная ошибка: ${event.message} (${event.filename}:${event.lineno}:${event.colno})`).catch(() => {});
  });
  window.addEventListener("unhandledrejection", event => {
    logError(`Необработанный отказ промиса: ${describe(event.reason)}`).catch(() => {});
  });
}
