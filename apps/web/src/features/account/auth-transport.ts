// Tokens stay in Privy's SDK. This bridge stores only a getter and aborts
// outstanding private requests when the authenticated identity changes.
type TokenGetter = () => Promise<string | null>;

let getter: TokenGetter | null = null;
let expired: (() => void) | null = null;
let epoch = 0;
const pending = new Set<AbortController>();

export const authEpoch = () => epoch;

export function assertAuthEpoch(expected: number) {
  if (expected !== epoch) {
    throw new DOMException("Account changed", "AbortError");
  }
}

export function resetAuthTransport() {
  epoch++;
  getter = null;
  expired = null;

  for (const controller of pending) {
    controller.abort();
  }

  pending.clear();
}

export function installAuthTransport(
  getToken: TokenGetter,
  onExpired: () => void,
) {
  resetAuthTransport();
  getter = getToken;
  expired = onExpired;

  const installed = epoch;

  return () => {
    if (installed === epoch) {
      resetAuthTransport();
    }
  };
}

export async function authenticatedFetch(path: string, init: RequestInit = {}) {
  const started = epoch;
  const getToken = getter;
  const onExpired = expired;
  const controller = new AbortController();

  pending.add(controller);

  const assertCurrent = () => {
    if (started !== epoch || controller.signal.aborted) {
      throw new DOMException("Account changed", "AbortError");
    }
  };

  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await getToken?.();

      assertCurrent();

      const headers = new Headers(init.headers);

      if (token) {
        headers.set("authorization", `Bearer ${token}`);
      }

      const response = await fetch(path, {
        ...init,
        headers,
        signal: init.signal
          ? AbortSignal.any([controller.signal, init.signal])
          : controller.signal,
        cache: "no-store",
      });

      assertCurrent();

      if (response.status !== 401 || !getToken) {
        return response;
      }

      if (attempt === 1) {
        onExpired?.();

        return response;
      }

      // A 401 is returned before protected work. Refresh once, with bounded
      // backoff, rather than replaying arbitrary failures or provider requests.
      await new Promise((resolve) => setTimeout(resolve, 250));
      assertCurrent();
    }

    throw new Error("Session could not be restored.");
  } finally {
    pending.delete(controller);
  }
}
