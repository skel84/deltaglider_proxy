/**
 * HeroSavingsPanel — the dashboard "money shot".
 *
 * Replaces the old 4-card KPI strip (Total storage · Space saved ·
 * Savings % · Est. monthly savings) with one composition that
 * communicates the staggering before-after of delta compression in
 * under two seconds:
 *
 *   - **Hero number**: the savings percent at billboard size with a
 *     count-up animation on first visit per session.
 *   - **Ratio caption**: "15× smaller" underneath, plain English.
 *   - **Scale-accurate bar**: a single 100%-wide rectangle showing
 *     kept-vs-saved as actual area, not just numbers. The kept slice
 *     is solid theme accent; the saved slice is muted with a soft
 *     dot pattern so it reads as *absence*, not another colour.
 *   - **Cost line**: dollars-per-month, configurable by a small cog
 *     popover (same `useFixedOverlayPosition` overlay we use for
 *     SimpleSelect / HoverHint).
 *   - **Before-after bytes**: "1.4 TB ↓ 96 GB on disk", plain text.
 *   - **Cache-age line**: when each bucket was last scanned, so the
 *     user knows the picture isn't stale-invisible.
 *
 * Three independent reads in one composition (gut · wallet · proof);
 * scale-invariant from GB to PB; animation is the message — viewers
 * watch the bar literally contract.
 *
 * Animation policy
 *   - Once per session (gated by `sessionStorage`); subsequent tab
 *     opens render the final state instantly.
 *   - Honors `prefers-reduced-motion: reduce` → static final values.
 *   - When a live SSE scan is streaming we suppress the count-up and
 *     let values track the live frames. The hero only animates the
 *     first paint of a *settled* state.
 *
 * Bundle cost: ~5 KB initial (`m` + `LazyMotion`), ~30 KB lazy-loaded
 * via `domAnimation` features when the Analytics tab mounts. No
 * chart library is added — the bar is two divs with percent widths.
 */

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  LazyMotion,
  domAnimation,
  m,
  useMotionValue,
  useTransform,
  animate,
} from 'motion/react';
import { SettingOutlined, ClockCircleOutlined } from '@ant-design/icons';
import { useColors } from '../ThemeContext';
import { formatBytes, clamp, dotPattern } from '../utils';
import { useFixedOverlayPosition } from '../useFixedOverlayPosition';

/** Cost rate presets — moved here from AnalyticsSection (sole caller now). */
const COST_PRESETS = [
  { label: 'AWS S3', rate: 0.023 },
  { label: 'AWS S3 IA', rate: 0.0125 },
  { label: 'Hetzner', rate: 0.00524 },
  { label: 'Backblaze', rate: 0.006 },
  { label: 'Cloudflare R2', rate: 0 },
] as const;

const SESSION_GATE_KEY = 'dgp-hero-animated';
const ANIMATION_MS = 1400;
const EASE = [0.16, 1, 0.3, 1] as const; // expo-ish, mimics Stripe/Linear

interface Props {
  totalOriginal: number;
  totalStored: number;
  savingsPercent: number;
  monthlySavings: number;
  costRate: number;
  onChangeCostRate: (rate: number) => void;
  /** ISO-ish age label, already formatted by ageLabel() upstream. */
  cacheAgeNewest: string | null;
  cacheAgeOldest: string | null;
  /** Total buckets not yet scanned — surfaces a tiny amber footnote. */
  unscannedCount: number;
  /** When a scan is streaming, suppress count-up so values track live frames. */
  liveScanning: boolean;
}

export default function HeroSavingsPanel(props: Props) {
  return (
    <LazyMotion features={domAnimation} strict>
      <HeroInner {...props} />
    </LazyMotion>
  );
}

function HeroInner({
  totalOriginal,
  totalStored,
  savingsPercent,
  monthlySavings,
  costRate,
  onChangeCostRate,
  cacheAgeNewest,
  cacheAgeOldest,
  unscannedCount,
  liveScanning,
}: Props) {
  const colors = useColors();

  // ─── Motion values + animation gate ───────────────────────────────
  //
  // Three values animate together: the percent number, the dollar
  // figure, and the saved-bar width. They share one duration + easing
  // so the orchestration reads as one event, not three things racing.
  const percentMV = useMotionValue(0);
  const dollarMV = useMotionValue(0);
  const savedWidthMV = useMotionValue(0); // 0..100

  /** Final-paint values formatted to strings via useTransform. */
  const percentDisplay = useTransform(
    percentMV,
    v => v.toFixed(1).replace(/\.0$/, ''),
  );
  const dollarDisplay = useTransform(
    dollarMV,
    v => v < 10 ? v.toFixed(2) : v.toFixed(2),
  );

  const targetPercent = clamp(savingsPercent, 0, 100);
  const targetSavedWidth = clamp(savingsPercent, 0, 100);
  const targetDollars = Math.max(0, monthlySavings);

  // Skip the count-up sequence when:
  //   - we've already animated this session
  //   - the user prefers reduced motion
  //   - a live scan is streaming (values must track frames, not interpolate)
  useEffect(() => {
    const prefersReduced =
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const alreadyPlayed =
      typeof sessionStorage !== 'undefined' &&
      sessionStorage.getItem(SESSION_GATE_KEY) === '1';
    const skipAnim = prefersReduced || alreadyPlayed || liveScanning;

    if (skipAnim) {
      percentMV.set(targetPercent);
      dollarMV.set(targetDollars);
      savedWidthMV.set(targetSavedWidth);
      return;
    }

    // Start each value from zero so the bar literally GROWS from
    // nothing into the final dwarf-the-kept proportions.
    percentMV.set(0);
    dollarMV.set(0);
    savedWidthMV.set(0);

    const ctrl1 = animate(percentMV, targetPercent, {
      duration: ANIMATION_MS / 1000,
      ease: EASE,
    });
    const ctrl2 = animate(dollarMV, targetDollars, {
      duration: ANIMATION_MS / 1000,
      ease: EASE,
    });
    const ctrl3 = animate(savedWidthMV, targetSavedWidth, {
      duration: ANIMATION_MS / 1000,
      ease: EASE,
    });

    const gateTimer = window.setTimeout(() => {
      if (typeof sessionStorage !== 'undefined') {
        sessionStorage.setItem(SESSION_GATE_KEY, '1');
      }
    }, ANIMATION_MS + 200);

    return () => {
      ctrl1.stop();
      ctrl2.stop();
      ctrl3.stop();
      window.clearTimeout(gateTimer);
    };
    // We deliberately depend on the *targets*, not the motion values.
    // The animation re-runs when underlying totals change (e.g. cost
    // preset switch updates dollars only, not the bar). The motion
    // values are stable refs from useMotionValue — touching them in the
    // body doesn't (and shouldn't) re-trigger this effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetPercent, targetDollars, targetSavedWidth, liveScanning]);

  // ─── Derived display values ──────────────────────────────────────
  const compressionRatio =
    totalStored > 0 ? totalOriginal / totalStored : 0;
  const ratioLabel =
    compressionRatio >= 1.05
      ? `${compressionRatio.toFixed(1).replace(/\.0$/, '')}× smaller`
      : null;
  const hasData = totalOriginal > 0;

  // ─── Cost popover ────────────────────────────────────────────────
  const [showCostConfig, setShowCostConfig] = useState(false);
  const cogRef = useRef<HTMLButtonElement>(null);
  const [popoverEl, setPopoverEl] = useState<HTMLDivElement | null>(null);
  const pos = useFixedOverlayPosition(cogRef, showCostConfig, {
    overlayEl: popoverEl,
    offset: 6,
  });
  const POPOVER_WIDTH = 220;
  const popoverLeft = cogRef.current
    ? Math.max(8, cogRef.current.getBoundingClientRect().right - POPOVER_WIDTH)
    : pos.left;

  useEffect(() => {
    if (!showCostConfig) return;
    const handlePointerDown = (e: PointerEvent) => {
      const target = e.target as Node | null;
      if (!target) return;
      if (cogRef.current?.contains(target)) return;
      if (popoverEl?.contains(target)) return;
      setShowCostConfig(false);
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setShowCostConfig(false);
    };
    document.addEventListener('pointerdown', handlePointerDown, true);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown, true);
      document.removeEventListener('keydown', handleKey);
    };
  }, [showCostConfig, popoverEl]);

  return (
    <div
      style={{
        display: 'grid',
        // Two-column layout above the bar: hero number | caption.
        // Stacks on narrow viewports via the dashboard density rules
        // — at small widths the panel goes single-column.
        gridTemplateColumns: 'minmax(280px, 1fr) 1.4fr',
        gap: 'clamp(16px, 2vw, 36px)',
        alignItems: 'center',
        height: '100%',
        position: 'relative',
        // Allow the haze pseudo-element to bleed without the panel
        // body clipping it sideways.
        overflow: 'hidden',
      }}
    >
      {/* Soft radial haze behind the hero number (Vercel/Linear pattern).
          Pure CSS, no images — swaps colour cleanly between themes. */}
      <div
        aria-hidden
        style={{
          position: 'absolute',
          inset: 0,
          pointerEvents: 'none',
          background: `radial-gradient(60% 60% at 18% 50%, ${colors.ACCENT_BLUE}1f 0%, transparent 70%)`,
          animation: 'dgHeroHazePulse 6s ease-in-out infinite',
        }}
      />

      {/* ── Hero number column ───────────────────────────────────
          All three lines (eyebrow · big number · ratio caption) share
          the same flex-start left edge of an inner flex column. The
          inner column shrinks to the natural width of its widest
          child (the big number) so the eyebrow + ratio caption sit
          flush under the digits' bounding box — no visual drift from
          the giant number's negative letter-spacing because all three
          measure from the same x=0 origin of the same wrapper.
      */}
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 6,
          position: 'relative',
          zIndex: 1,
          alignItems: 'flex-start',
        }}
      >
        <div
          style={{
            display: 'inline-flex',
            flexDirection: 'column',
            gap: 6,
            // Center the eyebrow + ratio caption under the giant
            // number rather than pinning them to its textbox origin.
            // The wrapper itself shrinks to the digits' natural
            // width, so center-aligning the children visually
            // centers each label under the % glyphs.
            alignItems: 'center',
          }}
        >
          <div
            style={{
              fontSize: 10.5,
              fontWeight: 700,
              letterSpacing: '0.12em',
              textTransform: 'uppercase',
              color: colors.TEXT_MUTED,
              fontFamily: 'var(--font-ui)',
              alignSelf: 'center',
            }}
          >
            Storage saved
          </div>
          <div
            aria-live="polite"
            aria-label={`${targetPercent.toFixed(1)} percent storage saved`}
            style={{
              display: 'flex',
              alignItems: 'baseline',
              gap: 4,
              color: colors.TEXT_PRIMARY,
              fontFamily: 'var(--font-ui)',
              fontWeight: 800,
              fontSize: 'clamp(64px, 11vw, 132px)',
              lineHeight: 1,
              letterSpacing: '-0.04em',
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            <m.span>{percentDisplay}</m.span>
            <span
              style={{
                fontSize: '0.42em',
                fontWeight: 700,
                color: colors.ACCENT_GREEN,
                marginLeft: 4,
              }}
            >
              %
            </span>
          </div>
          {ratioLabel && (
            <div
              style={{
                fontSize: 14,
                fontWeight: 600,
                color: colors.ACCENT_GREEN,
                fontFamily: 'var(--font-ui)',
                letterSpacing: '-0.01em',
                alignSelf: 'center',
              }}
            >
              {ratioLabel}
            </div>
          )}
        </div>
      </div>

      {/* ── Caption column: bytes + dollars + cost preset ──────── */}
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 14,
          fontFamily: 'var(--font-ui)',
          color: colors.TEXT_PRIMARY,
          zIndex: 1,
        }}
      >
        {/* Before/after bytes line — the proof. */}
        <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
          <span
            style={{
              fontSize: 'clamp(18px, 1.6vw, 26px)',
              fontWeight: 600,
              color: colors.TEXT_PRIMARY,
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            {hasData ? formatBytes(totalOriginal) : '—'}
          </span>
          <span style={{ color: colors.TEXT_MUTED, fontSize: 18, fontWeight: 400 }}>→</span>
          <span
            style={{
              fontSize: 'clamp(18px, 1.6vw, 26px)',
              fontWeight: 600,
              color: colors.ACCENT_GREEN,
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            {hasData ? formatBytes(totalStored) : '—'}
          </span>
          <span
            style={{
              fontSize: 12,
              color: colors.TEXT_MUTED,
              fontWeight: 500,
              marginLeft: 2,
            }}
          >
            on disk
          </span>
        </div>

        {/* Dollar line + cost preset cog. */}
        <div
          style={{
            display: 'flex',
            alignItems: 'baseline',
            gap: 8,
            flexWrap: 'wrap',
            position: 'relative',
          }}
        >
          <span
            style={{
              fontSize: 'clamp(20px, 1.8vw, 30px)',
              fontWeight: 700,
              color: colors.TEXT_PRIMARY,
              fontVariantNumeric: 'tabular-nums',
              letterSpacing: '-0.02em',
            }}
          >
            $
            <m.span>{dollarDisplay}</m.span>
          </span>
          <span style={{ fontSize: 13, color: colors.TEXT_MUTED, fontWeight: 500 }}>
            saved / month
          </span>
          <span style={{ fontSize: 11, color: colors.TEXT_FAINT, marginLeft: 4 }}>
            at ${costRate}/GB
          </span>
          <button
            ref={cogRef}
            onClick={() => setShowCostConfig(v => !v)}
            aria-label="Pick cost rate"
            aria-expanded={showCostConfig}
            aria-haspopup="listbox"
            title="Pick cost rate preset"
            style={{
              background: 'transparent',
              border: 'none',
              cursor: 'pointer',
              color: colors.TEXT_MUTED,
              padding: 4,
              marginLeft: 2,
              display: 'inline-flex',
              alignItems: 'center',
              borderRadius: 4,
              transition: 'color 0.12s',
            }}
            onMouseEnter={e => (e.currentTarget.style.color = colors.TEXT_PRIMARY)}
            onMouseLeave={e => (e.currentTarget.style.color = colors.TEXT_MUTED)}
          >
            <SettingOutlined />
          </button>
        </div>
        {showCostConfig &&
          createPortal(
            // Mounted on document.body so the popover escapes the
            // hero panel's stacking context. Earlier the popover was
            // a sibling of motion.div nodes that establish transform-
            // based containing blocks; even with zIndex 99999 the bar
            // textures painted on top of the menu. Portaling solves
            // that absolutely and is the same pattern AntD uses for
            // popovers — just done by hand.
            <div
              ref={setPopoverEl}
              role="listbox"
              aria-label="Cost per GB/month"
              style={{
                position: 'fixed',
                top: pos.top,
                left: popoverLeft,
                width: POPOVER_WIDTH,
                zIndex: 99999,
                padding: 10,
                background: colors.BG_ELEVATED,
                border: `1px solid ${colors.BORDER}`,
                borderRadius: 8,
                boxShadow: '0 12px 32px rgba(0,0,0,0.45)',
                // The portal mounts this on document.body, OUTSIDE
                // the panel's font inheritance chain, so without an
                // explicit font-family we fall through to the browser
                // serif default. Apply the same UI font + tabular
                // nums the rest of the dashboard uses.
                fontFamily: 'var(--font-ui)',
                fontVariantNumeric: 'tabular-nums',
                color: colors.TEXT_PRIMARY,
              }}
            >
              <div
                style={{
                  fontSize: 10,
                  fontWeight: 700,
                  color: colors.TEXT_MUTED,
                  textTransform: 'uppercase',
                  letterSpacing: '0.06em',
                  marginBottom: 6,
                }}
              >
                Cost per GB/month
              </div>
              {COST_PRESETS.map(p => (
                <div
                  key={p.label}
                  role="option"
                  tabIndex={0}
                  aria-selected={costRate === p.rate}
                  onClick={() => {
                    onChangeCostRate(p.rate);
                    setShowCostConfig(false);
                  }}
                  onKeyDown={e => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      onChangeCostRate(p.rate);
                      setShowCostConfig(false);
                    }
                  }}
                  style={{
                    padding: '6px 8px',
                    cursor: 'pointer',
                    borderRadius: 4,
                    fontSize: 12,
                    color: costRate === p.rate ? colors.ACCENT_BLUE : colors.TEXT_PRIMARY,
                    background: costRate === p.rate ? `${colors.ACCENT_BLUE}18` : 'transparent',
                  }}
                >
                  {p.label} — ${p.rate}/GB
                </div>
              ))}
            </div>,
            document.body,
          )}
      </div>

      {/* ── Compression bar (full width, spans both columns) ──── */}
      <div
        style={{
          gridColumn: '1 / -1',
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
          zIndex: 1,
        }}
        role="img"
        aria-label={
          hasData
            ? `Compression ratio: ${formatBytes(totalStored)} stored from ${formatBytes(totalOriginal)} original, saving ${targetPercent.toFixed(1)} percent`
            : 'No scan data yet'
        }
      >
        <div
          style={{
            position: 'relative',
            width: '100%',
            height: 30,
            background: colors.BG_CARD,
            border: `1px solid ${colors.BORDER}`,
            borderRadius: 8,
            overflow: 'hidden',
            display: 'flex',
            boxShadow: 'inset 0 1px 3px rgba(0,0,0,0.3)',
          }}
        >
          {/* Kept slice. Solid theme accent — the part that survives. */}
          <m.div
            style={{
              width: useTransform(savedWidthMV, v => `${100 - v}%`),
              background: `linear-gradient(180deg, ${colors.ACCENT_BLUE} 0%, ${colors.ACCENT_BLUE_LIGHT} 100%)`,
              boxShadow: `inset 0 1px 0 rgba(255,255,255,0.2), 0 0 12px ${colors.ACCENT_BLUE}55`,
              transition: 'background 0.15s',
            }}
            title={hasData ? `Kept on disk: ${formatBytes(totalStored)}` : ''}
          />
          {/* Saved slice. Muted background + dot pattern so it reads
              as "absence" / negative space, not another category. */}
          <m.div
            style={{
              width: useTransform(savedWidthMV, v => `${v}%`),
              backgroundImage: dotPattern(colors.TEXT_FAINT),
              backgroundColor: 'transparent',
              borderLeft: hasData ? `1px solid ${colors.BORDER}` : 'none',
              animation: 'dgBarGrain 12s linear infinite',
            }}
            title={hasData ? `Saved: ${formatBytes(totalOriginal - totalStored)}` : ''}
          />
        </div>
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            fontSize: 11,
            color: colors.TEXT_MUTED,
            fontFamily: 'var(--font-ui)',
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          <span>
            <span style={{ color: colors.ACCENT_BLUE_LIGHT, fontWeight: 700 }}>●</span>{' '}
            Kept {hasData ? formatBytes(totalStored) : ''}
          </span>
          <span>
            Saved {hasData ? formatBytes(totalOriginal - totalStored) : ''}{' '}
            <span style={{ color: colors.TEXT_FAINT, fontWeight: 700 }}>○</span>
          </span>
        </div>
      </div>

      {/* ── Cache-age line ─────────────────────────────────────── */}
      <div
        style={{
          gridColumn: '1 / -1',
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          fontSize: 11,
          color: colors.TEXT_MUTED,
          fontFamily: 'var(--font-ui)',
          zIndex: 1,
          marginTop: -4,
        }}
      >
        <ClockCircleOutlined style={{ fontSize: 10 }} />
        {cacheAgeNewest ? (
          <>
            <span>Newest scan {cacheAgeNewest}</span>
            {cacheAgeOldest && cacheAgeOldest !== cacheAgeNewest && (
              <span> · Oldest {cacheAgeOldest}</span>
            )}
          </>
        ) : (
          <span>No scans yet</span>
        )}
        {unscannedCount > 0 && (
          <span style={{ color: colors.ACCENT_AMBER }}>
            · {unscannedCount} bucket{unscannedCount === 1 ? '' : 's'} excluded
          </span>
        )}
      </div>
    </div>
  );
}
