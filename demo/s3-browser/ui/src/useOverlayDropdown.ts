import { useCallback, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { useEscapeKey, useOnClickOutside } from './useDocumentEvent';
import { useFixedOverlayPosition } from './useFixedOverlayPosition';

/**
 * Shared fixed-overlay lifecycle for `SimpleAutoComplete` — the app's
 * hand-rolled free-text-with-suggestions input. (Plain selects use AntD
 * <Select> directly; the old SimpleSelect fork was removed once we confirmed
 * AntD 6's Select popup works fine here — it never injected the body
 * scroll-lock that motivated the fork.) Owns the trigger ref, the overlay
 * element handle (as state
 * so `useFixedOverlayPosition` can flip-above on first paint), anchored
 * positioning, click-outside close, and optional escape-to-close.
 *
 * Both consumers keep their own distinct surfaces (trigger button +
 * search vs. free-text input + grouped options) — this hook only unifies
 * the measurement/open/close plumbing they previously duplicated.
 */

interface Options {
  /** Whether the overlay is currently shown. Drives positioning + listeners. */
  visible: boolean;
  /** Called when a click outside (and, if enabled, Escape) should dismiss the overlay. */
  onClose: () => void;
  /**
   * Flip above the trigger when there's no room below (measures the
   * overlay via the returned `setOverlay` ref). Default `false` keeps
   * the original below-trigger behaviour.
   */
  flipWhenNoRoom?: boolean;
  /** Wire a document-level Escape handler that calls `onClose`. Default `false`. */
  closeOnEscape?: boolean;
}

interface OverlayDropdown<T extends HTMLElement> {
  /** Ref for the anchor/trigger element. */
  triggerRef: RefObject<T>;
  /** Callback ref for the overlay element — feeds click-outside + flip measurement. */
  setOverlay: (el: HTMLDivElement | null) => void;
  /** Anchored coordinates from `useFixedOverlayPosition`. */
  pos: ReturnType<typeof useFixedOverlayPosition>;
}

export function useOverlayDropdown<T extends HTMLElement = HTMLDivElement>({
  visible,
  onClose,
  flipWhenNoRoom = false,
  closeOnEscape = false,
}: Options): OverlayDropdown<T> {
  // Initialised null like the call sites' original `useRef<T>(null)`, so the
  // returned ref types as `RefObject<T>` and slots straight onto a JSX `ref`.
  const triggerRef = useRef<T>(null) as RefObject<T>;
  const overlayRef = useRef<HTMLDivElement | null>(null);
  // Track the overlay element as state so `useFixedOverlayPosition`
  // re-runs when the dropdown mounts and can flip above the trigger
  // when there's no room below. The callback ref also feeds
  // `overlayRef` for `useOnClickOutside`.
  const [overlayEl, setOverlayEl] = useState<HTMLDivElement | null>(null);
  const setOverlay = useCallback((el: HTMLDivElement | null) => {
    overlayRef.current = el;
    setOverlayEl(el);
  }, []);

  const pos = useFixedOverlayPosition(
    triggerRef,
    visible,
    flipWhenNoRoom ? { overlayEl } : {},
  );

  useOnClickOutside([triggerRef, overlayRef], onClose, visible);
  useEscapeKey(onClose, visible && closeOnEscape);

  return { triggerRef, setOverlay, pos };
}
