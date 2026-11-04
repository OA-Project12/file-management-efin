// Abort the actual network operation. Never automatically retry mutations.
export function boundedFetch(input, init = {}, timeoutMs = 15_000) {
  return fetch(input, { ...init, signal: AbortSignal.any([
    AbortSignal.timeout(timeoutMs), ...(init.signal ? [init.signal] : []),
  ]) });
}
