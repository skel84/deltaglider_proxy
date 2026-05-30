import type { ReactNode } from 'react';
import { Button, Typography } from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import { useColors } from '../ThemeContext';
import SectionHeader from './SectionHeader';
import { useCardStyles } from './shared-styles';

const { Text } = Typography;

/**
 * Generic master-detail scaffold for the storage rule-array panels (Lifecycle
 * and Replication). It owns the two-column layout, the selectable rule list,
 * the "Add rule" button, and the empty-vs-detail card switch. The per-rule
 * field set and list-row body stay panel-specific via render props.
 *
 * Selection lives in the parent (it has to, since `selectedName` is derived
 * from the section-editor's loaded rules and kept in sync there); this
 * component is a pure presentation shell over `rules` + `selectedName`.
 *
 * Stable React keys: each rule row is keyed by `getName(rule)`, matching the
 * pre-refactor `key={rule.name}` on both panels. Rename flows must update
 * `selectedName` in the same render as the rule's name (both panels do, via
 * their `onRename`), so the key transition stays clean.
 */
interface RuleListEditorProps<TRule> {
  rules: TRule[];
  selectedName: string | null;
  getName: (rule: TRule) => string;
  onSelect: (name: string) => void;
  onAdd: () => void;
  /** Section icon + the "N configured rule(s)" subtitle text. */
  icon: ReactNode;
  loading: boolean;
  /** Compact body for a list row (status tag + scope lines). */
  renderListItem: (rule: TRule) => ReactNode;
  /** Detail editor for the selected rule (fields + action buttons + runtime). */
  renderDetail: (rule: TRule) => ReactNode;
  /** Shown in the detail card when no rule is selected. */
  emptyState: ReactNode;
  /** Master-list column width (panels differ slightly). */
  listColumn?: string;
}

export default function RuleListEditor<TRule>({
  rules,
  selectedName,
  getName,
  onSelect,
  onAdd,
  icon,
  loading,
  renderListItem,
  renderDetail,
  emptyState,
  listColumn = '320px',
}: RuleListEditorProps<TRule>) {
  const colors = useColors();
  const { cardStyle } = useCardStyles();
  const selectedRule = rules.find((r) => getName(r) === selectedName) || rules[0] || null;
  const selectedKey = selectedRule ? getName(selectedRule) : null;

  return (
    <div style={{ display: 'grid', gridTemplateColumns: `${listColumn} minmax(0, 1fr)`, gap: 16 }}>
      <div style={cardStyle}>
        <SectionHeader
          icon={icon}
          title="Rules"
          description={loading ? 'Loading...' : `${rules.length} configured rule${rules.length === 1 ? '' : 's'}.`}
        />
        <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
          {rules.map((rule) => {
            const name = getName(rule);
            const active = selectedKey === name;
            return (
              <button
                key={name}
                onClick={() => onSelect(name)}
                style={{
                  textAlign: 'left',
                  border: `1px solid ${active ? colors.ACCENT_BLUE : colors.BORDER}`,
                  borderRadius: 10,
                  padding: 12,
                  background: active ? `${colors.ACCENT_BLUE}12` : colors.BG_ELEVATED,
                  cursor: 'pointer',
                }}
              >
                {renderListItem(rule)}
              </button>
            );
          })}
          <Button icon={<PlusOutlined />} type="dashed" onClick={onAdd} block>
            Add rule
          </Button>
        </div>
      </div>

      <div style={cardStyle}>
        {!selectedRule ? emptyState : renderDetail(selectedRule)}
      </div>
    </div>
  );
}

/** Shared list-row title line: bold rule name + a right-aligned status node. */
export function RuleRowTitle({ name, status }: { name: string; status: ReactNode }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
      <Text strong style={{ fontSize: 13 }}>{name}</Text>
      {status}
    </div>
  );
}

/** Shared list-row secondary line (11px secondary text, small top margin). */
export function RuleRowLine({ marginTop = 4, children }: { marginTop?: number; children: ReactNode }) {
  return (
    <Text type="secondary" style={{ display: 'block', fontSize: 11, marginTop }}>
      {children}
    </Text>
  );
}
