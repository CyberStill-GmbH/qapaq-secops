import { useEffect, useRef, useState } from 'react';
import { api, type ChangeView } from '../../api/client.js';

interface UseChangesOptions {
  readonly resourceTypes: readonly string[];
  readonly enabled?: boolean;
  readonly onChange: (changes: readonly ChangeView[], resync: boolean) => void;
}

/** One active long-poll feed for the mounted workspace view. */
export function useChanges({
  resourceTypes,
  enabled = true,
  onChange,
}: UseChangesOptions): readonly ChangeView[] {
  const callbackRef = useRef(onChange);
  callbackRef.current = onChange;
  const [lastChanges, setLastChanges] = useState<readonly ChangeView[]>([]);
  const typeKey = [...resourceTypes].sort().join('|');

  useEffect(() => {
    if (!enabled) return;
    let active = true;
    let cursor: string | undefined;
    let failureCount = 0;
    let controller: AbortController | null = null;
    let retryTimer: number | undefined;
    let highlightTimer: number | undefined;
    let cancelRetryWait: (() => void) | undefined;
    let cancelVisibilityWait: (() => void) | undefined;
    const allowed = new Set(typeKey ? typeKey.split('|') : []);

    const wait = (milliseconds: number): Promise<void> =>
      new Promise((resolve) => {
        retryTimer = window.setTimeout(() => {
          retryTimer = undefined;
          cancelRetryWait = undefined;
          resolve();
        }, milliseconds);
        cancelRetryWait = () => {
          if (retryTimer !== undefined) window.clearTimeout(retryTimer);
          retryTimer = undefined;
          cancelRetryWait = undefined;
          resolve();
        };
      });

    const waitForVisible = (): Promise<void> => {
      if (document.visibilityState === 'visible') return Promise.resolve();
      return new Promise((resolve) => {
        const onVisible = (): void => {
          if (document.visibilityState !== 'visible') return;
          cancelVisibilityWait?.();
        };
        cancelVisibilityWait = () => {
          document.removeEventListener('visibilitychange', onVisible);
          cancelVisibilityWait = undefined;
          resolve();
        };
        document.addEventListener('visibilitychange', onVisible);
      });
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        controller?.abort();
      } else {
        cancelRetryWait?.();
      }
    };
    document.addEventListener('visibilitychange', onVisibilityChange);

    const poll = async (): Promise<void> => {
      while (active) {
        await waitForVisible();
        if (!active) break;
        controller = new AbortController();
        let result: Awaited<ReturnType<typeof api.changes>>;
        try {
          result = await api.changes(cursor, controller.signal);
        } catch {
          controller = null;
          if (!active) break;
          if (document.visibilityState !== 'visible') continue;
          failureCount += 1;
          await wait(Math.min(1000 * 2 ** Math.min(failureCount, 5), 30_000));
          continue;
        }
        controller = null;
        if (!active) break;
        if (document.visibilityState !== 'visible') continue;
        if (!result.ok) {
          failureCount += 1;
          await wait(Math.min(1000 * 2 ** Math.min(failureCount, 5), 30_000));
          continue;
        }
        failureCount = 0;
        cursor = result.data.cursor;
        if (result.data.resync) {
          setLastChanges([]);
          callbackRef.current([], true);
          continue;
        }
        const visibleChanges = result.data.changes.filter((change) =>
          allowed.has(change.resource.type),
        );
        if (visibleChanges.length) {
          setLastChanges(visibleChanges);
          callbackRef.current(visibleChanges, false);
          if (highlightTimer !== undefined) window.clearTimeout(highlightTimer);
          highlightTimer = window.setTimeout(() => {
            highlightTimer = undefined;
            setLastChanges([]);
          }, 1600);
        }
      }
    };

    void poll();
    return () => {
      active = false;
      controller?.abort();
      document.removeEventListener('visibilitychange', onVisibilityChange);
      cancelVisibilityWait?.();
      cancelRetryWait?.();
      if (highlightTimer !== undefined) window.clearTimeout(highlightTimer);
    };
  }, [enabled, typeKey]);

  return lastChanges;
}
