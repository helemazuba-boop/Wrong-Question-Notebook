/** Shared cancellation and monotonic time budgets for one voice operation. */
const deadlines = new WeakMap<AbortSignal, number>();

export class VoiceOperationStopped extends Error {
  constructor(public readonly reason: 'cancelled' | 'deadline') {
    super(
      reason === 'deadline'
        ? 'Voice operation deadline exceeded'
        : 'Voice operation cancelled'
    );
    this.name = reason === 'deadline' ? 'TimeoutError' : 'AbortError';
  }
}

function stoppedReason(signal: AbortSignal): VoiceOperationStopped {
  return signal.reason instanceof VoiceOperationStopped
    ? signal.reason
    : new VoiceOperationStopped('cancelled');
}

export function throwIfVoiceStopped(
  signal?: AbortSignal,
  timeoutError?: () => Error
): void {
  if (!signal?.aborted) return;
  const reason = stoppedReason(signal);
  if (reason.reason === 'deadline' && timeoutError) throw timeoutError();
  throw reason;
}

export function combineVoiceSignals(
  ...signals: Array<AbortSignal | undefined>
): AbortSignal | undefined {
  const present = signals.filter((signal): signal is AbortSignal =>
    Boolean(signal)
  );
  const combined = present.length > 1 ? AbortSignal.any(present) : present[0];
  const deadline = Math.min(
    ...present.map(signal => deadlines.get(signal) ?? Infinity)
  );
  if (combined && Number.isFinite(deadline)) deadlines.set(combined, deadline);
  return combined;
}

export function createVoiceOperation(timeoutMs: number, parent?: AbortSignal) {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
    throw new RangeError(
      'Voice operation requires a finite non-negative budget'
    );
  }
  const controller = new AbortController();
  const deadline = Math.min(
    performance.now() + timeoutMs,
    parent ? (deadlines.get(parent) ?? Infinity) : Infinity
  );
  deadlines.set(controller.signal, deadline);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const abortFromParent = () => controller.abort(stoppedReason(parent!));
  const expire = () => {
    const remaining = deadline - performance.now();
    if (remaining <= 0) {
      controller.abort(new VoiceOperationStopped('deadline'));
    } else {
      timer = setTimeout(expire, Math.min(remaining, 2 ** 31 - 1));
    }
  };
  if (parent?.aborted) abortFromParent();
  else {
    parent?.addEventListener('abort', abortFromParent, { once: true });
    expire();
  }
  return {
    signal: controller.signal,
    remainingMs: () => Math.max(0, deadline - performance.now()),
    dispose() {
      clearTimeout(timer);
      parent?.removeEventListener('abort', abortFromParent);
    },
  };
}

/** Stop waiting without detaching a rejection handler from the original work. */
export function waitForVoiceOperation<T>(
  work: PromiseLike<T>,
  signal?: AbortSignal
): Promise<T> {
  if (!signal) return Promise.resolve(work);
  return new Promise<T>((resolve, reject) => {
    const cleanup = () => signal.removeEventListener('abort', abort);
    const abort = () => {
      cleanup();
      reject(stoppedReason(signal));
    };
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(work).then(
      value => {
        cleanup();
        if (signal.aborted) abort();
        else resolve(value);
      },
      error => {
        cleanup();
        reject(signal.aborted ? stoppedReason(signal) : error);
      }
    );
    if (signal.aborted) abort();
  });
}

export function sleepForVoiceOperation(
  ms: number,
  signal?: AbortSignal
): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    };
    const abort = () => {
      cleanup();
      reject(stoppedReason(signal!));
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}

/** Cancel an actual response reader, including test/custom streams, on abort. */
export function cancelVoiceReaderOnAbort<T>(
  reader: ReadableStreamDefaultReader<T>,
  signal?: AbortSignal
) {
  const abort = () => {
    void reader.cancel(signal?.reason).catch(() => {});
  };
  if (signal?.aborted) abort();
  else signal?.addEventListener('abort', abort, { once: true });
  return () => {
    signal?.removeEventListener('abort', abort);
    reader.releaseLock();
  };
}
