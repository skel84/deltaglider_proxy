/**
 * PrefixListEditor — the specific-prefixes editor surfaced inside a
 * {@link BucketCard} when its anonymous-read mode is `prefixes`.
 *
 * Extracted verbatim from BucketsPanel's inline `publicMode === 'prefixes'`
 * block. Every prefix carries a stable synthetic `id` so React keys by
 * identity, not array index; all edits route through the parent's
 * functional `onPrefixesChange` transform so they never read a stale
 * closure (recent bug fix preserved). The trailing-slash normalisation
 * on blur is unchanged.
 */
import { Button, Input } from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import { useColors } from '../ThemeContext';
import { formRow } from './ruleEditorHelpers';
import type { PrefixEntry } from './bucketPolicyPayload';
import { freshId } from './bucketPolicyPayload';

interface Props {
  prefixes: PrefixEntry[];
  /** Apply a functional transform to the prefix list, by id, via the
   *  parent's functional setRows — never a stale closure. */
  onPrefixesChange: (fn: (prev: PrefixEntry[]) => PrefixEntry[]) => void;
  inputRadius: { borderRadius: number };
}

export default function PrefixListEditor({
  prefixes,
  onPrefixesChange,
  inputRadius,
}: Props) {
  const colors = useColors();

  return (
    <div
      style={{
        marginTop: 8,
        paddingLeft: 16,
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
      }}
    >
      {prefixes.map((prefix) => (
        <div
          key={prefix.id}
          style={formRow(4)}
        >
          <Input
            value={prefix.value}
            onChange={(e) => {
              const value = e.target.value;
              onPrefixesChange((prev) =>
                prev.map((p) =>
                  p.id === prefix.id ? { ...p, value } : p
                )
              );
            }}
            onBlur={(e) => {
              const v = e.target.value.trim();
              if (v && !v.endsWith('/')) {
                onPrefixesChange((prev) =>
                  prev.map((p) =>
                    p.id === prefix.id ? { ...p, value: v + '/' } : p
                  )
                );
              }
            }}
            placeholder="e.g. builds/"
            style={{
              flex: 1,
              ...inputRadius,
              fontFamily: 'var(--font-mono)',
              fontSize: 11,
            }}
            size="small"
          />
          <Button
            type="text"
            size="small"
            danger
            onClick={() => {
              onPrefixesChange((prev) =>
                prev.filter((p) => p.id !== prefix.id)
              );
            }}
            style={{ padding: '0 8px', minWidth: 0 }}
          >
            ×
          </Button>
        </div>
      ))}
      <Button
        type="text"
        size="small"
        icon={<PlusOutlined />}
        onClick={() => {
          onPrefixesChange((prev) => [
            ...prev,
            { id: freshId(), value: '' },
          ]);
        }}
        style={{
          padding: '0 8px',
          color: colors.TEXT_MUTED,
          alignSelf: 'flex-start',
          fontSize: 11,
        }}
      >
        Add prefix
      </Button>
    </div>
  );
}
