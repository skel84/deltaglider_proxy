import type { ReactNode } from 'react';
import { Typography } from 'antd';
import { useColors } from '../ThemeContext';

const { Text } = Typography;

/**
 * Shared React primitives for the storage sub-panels (Lifecycle / Replication /
 * Buckets). Pure helpers (lineList / lines / fmtUnix / formRow) live in the
 * sibling `ruleEditorHelpers.ts`.
 */

/** Labelled field wrapper: 11px uppercase secondary label above its children. */
export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label style={{ display: 'block' }}>
      <Text type="secondary" style={{ display: 'block', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 }}>
        {label}
      </Text>
      {children}
    </label>
  );
}

/** Collapsible HTML5 `<details>` block with an uppercase summary header. */
export function AdvancedDisclosure({ title, children }: { title: string; children: ReactNode }) {
  const { BORDER, TEXT_SECONDARY } = useColors();
  return (
    <details
      style={{
        marginTop: 16,
        borderTop: `1px solid ${BORDER}`,
        paddingTop: 12,
      }}
    >
      <summary
        style={{
          cursor: 'pointer',
          color: TEXT_SECONDARY,
          fontSize: 12,
          fontWeight: 700,
          letterSpacing: 0.5,
          textTransform: 'uppercase',
          userSelect: 'none',
        }}
      >
        {title}
      </summary>
      <div style={{ marginTop: 12 }}>
        {children}
      </div>
    </details>
  );
}
