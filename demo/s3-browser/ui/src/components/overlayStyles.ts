import type { useColors } from '../ThemeContext';

/**
 * Shared visual constants + base-style builder for the app's
 * custom fixed-position overlays (SimpleSelect / SimpleAutoComplete
 * dropdowns, HoverHint tooltips). All three bypass Ant Design's
 * popup layer (broken in this layout) and render a `position: fixed`
 * div anchored via `getBoundingClientRect`. They previously hand-
 * rolled identical shadow / z-index / radius literals — collapsed
 * here so the look stays consistent and tweaks land in one place.
 */

/** Drop shadow for floating overlays (no blur radius variance — flat soft shadow). */
export const OVERLAY_SHADOW = '0 8px 24px rgba(0,0,0,0.3)';

/** z-index for floating overlays — above every in-page stacking context. */
export const Z_INDEX_OVERLAY = 99999;

/** Border-radius scale used across overlay chrome. */
export const BORDER_RADIUS = { xs: 4, sm: 6, md: 8 } as const;

/** Anchored position produced by `useFixedOverlayPosition`. */
interface OverlayPos {
  top: number;
  left: number;
  width: number;
}

interface OverlayBaseOptions {
  /** Floor for the overlay width (`max(pos.width, minWidth)`). */
  minWidth: number;
  /** Cap on overlay height before it scrolls. */
  maxHeight: number;
  /** When true, spread a column flex layout (used by grouped autocomplete). */
  flexLayout?: boolean;
}

/**
 * Common style for a fixed-position dropdown overlay: anchored
 * coordinates, scrollable body, elevated surface, soft shadow, and
 * the shared z-index. Callers add their own `padding` (and any
 * `gap`/flex tuning) on top.
 */
export function getOverlayBaseStyles(
  colors: ReturnType<typeof useColors>,
  pos: OverlayPos,
  { minWidth, maxHeight, flexLayout = false }: OverlayBaseOptions,
): React.CSSProperties {
  return {
    position: 'fixed',
    top: pos.top,
    left: pos.left,
    width: Math.max(pos.width, minWidth),
    maxHeight,
    overflowY: 'auto',
    background: colors.BG_ELEVATED,
    border: `1px solid ${colors.BORDER}`,
    borderRadius: BORDER_RADIUS.md,
    boxShadow: OVERLAY_SHADOW,
    zIndex: Z_INDEX_OVERLAY,
    ...(flexLayout ? { display: 'flex', flexDirection: 'column' as const } : {}),
  };
}
