import { useCallback, useState } from 'react';

/**
 * Page-size state with localStorage persistence and allow-list
 * validation. Returns the same `[value, setter]` shape as `useState`
 * so it's a drop-in for hardcoded `useState(100)`.
 *
 * - Reads localStorage on first render; falls back to `defaultSize` if
 *   the stored value is missing, malformed, or not in `allowedSizes`.
 * - Writes back on every successful set (silently no-ops on storage
 *   errors — private-browsing / quota-exceeded shouldn't crash the UI).
 * - The allow-list check guards against an operator manually editing
 *   localStorage to a value the dropdown won't render (would otherwise
 *   leave the size picker in a "no selection" state).
 *
 * Storage keys MUST be unique per table — passing the same key from
 * two components is a bug, not a feature: the values would clobber
 * each other on the next render.
 */
export function usePersistedPageSize(
  storageKey: string,
  defaultSize: number,
  allowedSizes: readonly number[],
): [number, (next: number) => void] {
  const [size, setSize] = useState<number>(() => {
    const raw = readStorage(storageKey);
    if (raw == null) return defaultSize;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || !allowedSizes.includes(parsed)) {
      return defaultSize;
    }
    return parsed;
  });

  const update = useCallback(
    (next: number) => {
      if (!allowedSizes.includes(next)) return; // silently ignore invalid
      setSize(next);
      writeStorage(storageKey, String(next));
    },
    [storageKey, allowedSizes],
  );

  return [size, update];
}

function readStorage(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null; // SecurityError in some private modes
  }
}

function writeStorage(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* QuotaExceededError or private mode — ignore */
  }
}
