/**
 * StatePlaceholders — shared loading + empty-state chrome.
 *
 * Before this existed every panel hand-rolled its own centered <Spin> and
 * empty-state block with slightly different padding (40 / 64 / 32 / 48),
 * icon sizes, and type scales. These two primitives own ONLY the chrome
 * (centering, padding, icon size, title/hint type scale) so the look is
 * identical everywhere; callers still supply their own copy / icon / action
 * so each placeholder stays meaningful in context.
 *
 * Type scale is borrowed from SectionHeader / FormField so an empty state
 * reads as subordinate to a real card header: title at 15px/600 (between
 * SectionHeader's 17 and FormField's 13.5), hint at FormField's 12.5 muted.
 */
import { Spin } from 'antd';
import { useColors } from '../ThemeContext';

/**
 * Centered spinner with consistent padding and an optional label below it.
 * Replaces the ad-hoc `<div style={{ textAlign: 'center', padding: N }}><Spin /></div>`
 * blocks (padding ranged 32–64 across panels; we standardise on 40).
 */
export function LoadingState({ label }: { label?: string }) {
  const { TEXT_MUTED } = useColors();
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 12,
        padding: 40,
      }}
    >
      <Spin />
      {label && (
        <div
          style={{
            fontSize: 12.5,
            color: TEXT_MUTED,
            fontFamily: 'var(--font-ui)',
            lineHeight: 1.4,
          }}
        >
          {label}
        </div>
      )}
    </div>
  );
}

