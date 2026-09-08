import { useColors } from '../ThemeContext';

/**
 * Centered tab header with icon, title, and description.
 * Used at the top of every admin settings tab for consistent wayfinding.
 */

interface Props {
  icon: React.ReactNode;
  title: string;
  description: string;
  /** Save-model badge: tells the operator the page's edit contract. */
  saveModel?: 'immediate' | 'review';
}

export default function TabHeader({ icon, title, description, saveModel }: Props) {
  const colors = useColors();
  const badge =
    saveModel === 'immediate'
      ? { text: 'Saves immediately', tone: colors.ACCENT_BLUE }
      : saveModel === 'review'
        ? { text: 'Review & apply', tone: colors.ACCENT_AMBER }
        : null;

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        // Wrap so the save-model badge drops below the title on a very narrow
        // viewport instead of overflowing.
        flexWrap: 'wrap',
        gap: 10,
        rowGap: 6,
        padding: '12px 20px',
        borderBottom: `1px solid ${colors.BORDER}`,
        marginBottom: 0,
      }}
      role="heading"
      aria-level={2}
    >
      <div
        aria-hidden="true"
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 28,
          height: 28,
          borderRadius: 8,
          background: `${colors.ACCENT_BLUE}12`,
          border: `1px solid ${colors.ACCENT_BLUE}25`,
          fontSize: 14,
          color: colors.ACCENT_BLUE,
          flexShrink: 0,
        }}
      >
        {icon}
      </div>
      <div
        style={{
          minWidth: 0,
          flex: 1,
        }}
      >
        <div
          style={{
            fontSize: 16,
            fontWeight: 700,
            color: colors.TEXT_PRIMARY,
            fontFamily: 'var(--font-ui)',
            letterSpacing: '-0.01em',
            lineHeight: 1.15,
          }}
        >
          {title}
        </div>
        <div
          style={{
            fontSize: 12,
            color: colors.TEXT_MUTED,
            fontFamily: 'var(--font-ui)',
            marginTop: 2,
            maxWidth: 760,
            lineHeight: 1.35,
          }}
        >
          {description}
        </div>
      </div>
      {badge && (
        <span
          title={
            badge.text === 'Saves immediately'
              ? 'Every change on this page takes effect as soon as you make it.'
              : 'Changes are staged; nothing is live until you review the diff and Apply.'
          }
          style={{
            flexShrink: 0,
            fontSize: 10,
            fontWeight: 700,
            letterSpacing: 0.5,
            textTransform: 'uppercase',
            padding: '3px 10px',
            borderRadius: 10,
            background: `${badge.tone}18`,
            color: badge.tone,
            whiteSpace: 'nowrap',
          }}
        >
          {badge.text}
        </span>
      )}
    </div>
  );
}
