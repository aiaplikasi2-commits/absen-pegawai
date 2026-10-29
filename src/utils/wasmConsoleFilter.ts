const FILTER_MARKER = '__wasmStderrFiltered__';

const BENIGN_WASM_STDERR_PATTERNS: RegExp[] = [
  /^INFO:\s*Created TensorFlow Lite XNNPACK delegate/i,
  /^INFO:\s*Initialized TensorFlow Lite runtime/i,
  /^(?:INFO|WARNING):\s*.*TensorFlow Lite/i,
  /^[IW]0000\s+\d{2}:\d{2}:\d{2}\.\d+/,
  /^Graph successfully started running\.?$/i,
];

function isBenignWasmStderr(args: unknown[]): boolean {
  if (args.length === 0) return false;
  const first = args[0];
  const text =
    typeof first === 'string'
      ? first.trim()
      : first instanceof Error && typeof first.message === 'string'
        ? first.message.trim()
        : '';

  if (!text) return false;
  return BENIGN_WASM_STDERR_PATTERNS.some((pattern) => pattern.test(text));
}

type MarkedConsoleFn = ((...args: unknown[]) => void) & {
  [FILTER_MARKER]?: boolean;
};

/**
 * Emscripten-compiled MediaPipe / TensorFlow Lite WASM routes C++ `stderr`
 * informational status lines (e.g. "INFO: Created TensorFlow Lite XNNPACK delegate for CPU.")
 * to `console.error`. This filter suppresses only benign WASM INFO/WARNING
 * messages while forwarding all genuine errors untouched.
 */
export function installWasmConsoleFilter(): void {
  if (typeof window === 'undefined' || typeof console === 'undefined') return;

  try {
    const currentError = console.error as MarkedConsoleFn;
    if (typeof currentError === 'function' && !currentError[FILTER_MARKER]) {
      const wrappedError: MarkedConsoleFn = function (this: unknown, ...args: unknown[]) {
        if (isBenignWasmStderr(args)) {
          return;
        }
        return currentError.apply(this ?? console, args);
      };
      wrappedError[FILTER_MARKER] = true;
      console.error = wrappedError;
    }

    const currentWarn = console.warn as MarkedConsoleFn;
    if (typeof currentWarn === 'function' && !currentWarn[FILTER_MARKER]) {
      const wrappedWarn: MarkedConsoleFn = function (this: unknown, ...args: unknown[]) {
        if (isBenignWasmStderr(args)) {
          return;
        }
        return currentWarn.apply(this ?? console, args);
      };
      wrappedWarn[FILTER_MARKER] = true;
      console.warn = wrappedWarn;
    }
  } catch {
    // Ignore if console methods are non-writable in restricted environments
  }
}

installWasmConsoleFilter();
