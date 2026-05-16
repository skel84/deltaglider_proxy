import { useLayoutEffect, useState } from 'react';
import type { RefObject } from 'react';

type OverlayPlacement = 'bottom' | 'top';

interface OverlayPosition {
  top: number;
  left: number;
  width: number;
  /**
   * Actual placement applied this frame. Useful when the caller needs
   * to know whether the overlay flipped above the trigger so it can
   * (e.g.) render a different drop-shadow direction.
   */
  placement: OverlayPlacement;
}

interface Options {
  /** Gap between trigger and overlay, both directions. Default 2. */
  offset?: number;
  /**
   * The rendered overlay element. When non-null AND open, the hook
   * measures the overlay's natural height and flips above the
   * trigger if there's not enough room below. Pass `null` (or omit
   * the option entirely) to keep the original below-trigger
   * behaviour.
   *
   * Pass via state (`useState<HTMLElement | null>`), not a ref —
   * the hook needs to re-run when the element mounts so flip can
   * happen on first paint.
   */
  overlayEl?: HTMLElement | null;
  /**
   * Minimum gap between overlay and viewport edge. Default 8.
   */
  viewportMargin?: number;
}

/**
 * Compute viewport-fixed coordinates for an overlay anchored to a
 * trigger element. Recomputes on `open`, window resize, any ancestor
 * scroll, and — when `overlayEl` is supplied — when the overlay
 * mounts / resizes so a flip-above happens on first paint without an
 * extra render cycle.
 *
 * The default signature `(anchorRef, open, offset?)` is preserved
 * for backward compatibility — old call sites that pass a numeric
 * third argument keep working.
 */
export function useFixedOverlayPosition(
  anchorRef: RefObject<HTMLElement | null>,
  open: boolean,
  optionsOrOffset: Options | number = {},
): OverlayPosition {
  const options: Options =
    typeof optionsOrOffset === 'number' ? { offset: optionsOrOffset } : optionsOrOffset;
  const offset = options.offset ?? 2;
  const overlayEl = options.overlayEl ?? null;
  const viewportMargin = options.viewportMargin ?? 8;

  const [position, setPosition] = useState<OverlayPosition>({
    top: 0,
    left: 0,
    width: 0,
    placement: 'bottom',
  });

  useLayoutEffect(() => {
    if (!open || !anchorRef.current) return;

    const update = () => {
      const anchor = anchorRef.current?.getBoundingClientRect();
      if (!anchor) return;
      const overlayHeight = overlayEl?.offsetHeight ?? 0;
      const viewportHeight = window.innerHeight;

      // Decide placement only when we have a measured overlay height.
      // Without it (caller didn't pass overlayEl, or the overlay
      // hasn't mounted yet) we keep the original below-trigger
      // behaviour. As soon as the overlay mounts, this effect re-runs
      // (overlayEl is in deps) and we can flip if needed.
      const spaceBelow = viewportHeight - anchor.bottom - viewportMargin;
      const spaceAbove = anchor.top - viewportMargin;
      const flip =
        overlayHeight > 0 && overlayHeight > spaceBelow && spaceAbove > spaceBelow;

      const top = flip
        ? Math.max(viewportMargin, anchor.top - overlayHeight - offset)
        : anchor.bottom + offset;
      setPosition({
        top,
        left: anchor.left,
        width: anchor.width,
        placement: flip ? 'top' : 'bottom',
      });
    };

    update();
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);

    // Re-measure when overlay size changes (caller's filter trims the
    // option list, theme changes line-height, etc).
    let resizeObserver: ResizeObserver | undefined;
    if (overlayEl && typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(() => update());
      resizeObserver.observe(overlayEl);
    }

    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
      resizeObserver?.disconnect();
    };
  }, [anchorRef, offset, open, overlayEl, viewportMargin]);

  return position;
}
