import { useEffect, useState } from 'react';
import { Input, Button, Typography, Segmented, Checkbox } from 'antd';
import { PlusOutlined, DeleteOutlined, FilterOutlined } from '@ant-design/icons';
import { useCardStyles } from './shared-styles';
import { useColors } from '../ThemeContext';
import { listBuckets } from '../s3client';
import { parseResourcePattern } from '../storagePath';
import type { PermissionRow } from './permissionRows';
import ResourcePatternInput from './ResourcePatternInput';
import ConditionPrefixInput from './ConditionPrefixInput';

const { Text } = Typography;

const ACTION_OPTIONS = [
  { label: 'Read (GET/HEAD)', value: 'read' },
  { label: 'Write (PUT)', value: 'write' },
  { label: 'Delete (DELETE)', value: 'delete' },
  { label: 'List (ListObjects)', value: 'list' },
  { label: 'Admin (Bucket ops)', value: 'admin' },
  { label: 'All (*)', value: '*' },
];

/** Extract a simple condition value for UI display */
function getConditionValue(
  conditions: Record<string, Record<string, string | string[]>> | undefined,
  operator: string,
  key: string,
): string {
  if (!conditions) return '';
  const opBlock = conditions[operator];
  if (!opBlock) return '';
  const val = opBlock[key];
  if (Array.isArray(val)) return val.join(', ');
  return val || '';
}

/** Set a condition value, creating operator/key structure as needed */
function setConditionValue(
  conditions: Record<string, Record<string, string | string[]>> | undefined,
  operator: string,
  key: string,
  value: string,
): Record<string, Record<string, string | string[]>> {
  const result = conditions ? { ...conditions } : {};
  if (!value.trim()) {
    // Remove the key
    if (result[operator]) {
      const { [key]: _, ...rest } = result[operator];
      if (Object.keys(rest).length === 0) {
        delete result[operator];
      } else {
        result[operator] = rest;
      }
    }
    return result;
  }
  const parsedValue = value.includes(',')
    ? value.split(',').map(v => v.trim())
    : value.trim();
  result[operator] = { ...(result[operator] || {}), [key]: parsedValue };
  return result;
}

/** Check if a rule has any conditions set */
function hasConditions(conditions?: Record<string, Record<string, string | string[]>>): boolean {
  if (!conditions) return false;
  return Object.values(conditions).some(kv => Object.values(kv).some(v =>
    typeof v === 'string' ? v.trim() !== '' : v.length > 0
  ));
}

function firstConcreteResourceBucket(resources: string): string {
  for (const part of resources.split(',')) {
    const parsed = parseResourcePattern(part);
    if (parsed.bucket && !parsed.bucket.includes('${')) return parsed.bucket;
  }
  return '';
}

interface PermissionEditorProps {
  permissions: PermissionRow[];
  onChange: (perms: PermissionRow[]) => void;
}

export default function PermissionEditor({ permissions, onChange }: PermissionEditorProps) {
  const { inputRadius } = useCardStyles();
  const colors = useColors();
  const [bucketNames, setBucketNames] = useState<string[]>([]);
  /** Rows where the optional-filters pane was explicitly opened without data yet (adding first condition). */
  const [expandedConditions, setExpandedConditions] = useState<Set<number>>(() => new Set());

  useEffect(() => {
    let cancelled = false;
    listBuckets()
      .then((buckets) => {
        if (!cancelled) setBucketNames(buckets.map((bucket) => bucket.name).filter(Boolean));
      })
      .catch(() => {
        if (!cancelled) setBucketNames([]);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    setExpandedConditions((prev) => {
      const next = new Set<number>();
      for (const idx of prev) {
        if (idx >= 0 && idx < permissions.length) next.add(idx);
      }
      return next;
    });
  }, [permissions.length]);

  const toggleConditions = (index: number) => {
    if (hasConditions(permissions[index]?.conditions)) {
      return;
    }
    setExpandedConditions((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  };

  const condLabelStyle: React.CSSProperties = {
    fontSize: 10,
    fontWeight: 600,
    letterSpacing: 0.5,
    textTransform: 'uppercase',
    color: colors.TEXT_MUTED,
    fontFamily: 'var(--font-ui)',
  };
  const monoTextStyle: React.CSSProperties = {
    fontFamily: 'var(--font-mono)',
    color: colors.TEXT_PRIMARY,
  };

  return (
    <>
      <details style={{ marginBottom: 12, border: `1px solid ${colors.BORDER}`, borderRadius: 8, padding: '8px 10px', background: colors.BG_BASE }}>
        <summary
          title="Open permission examples and variable help"
          style={{
            cursor: 'pointer',
            color: colors.TEXT_SECONDARY,
            fontSize: 12,
            fontWeight: 600,
            userSelect: 'none',
            minHeight: 28,
            lineHeight: '28px',
          }}
        >
          Examples and variables
        </summary>
        <div style={{ marginTop: 6, color: colors.TEXT_MUTED, fontSize: 12, lineHeight: 1.6 }}>
          Resources match objects: <span style={monoTextStyle}>bucket/*</span>, <span style={monoTextStyle}>bucket/releases/*</span>, or <span style={monoTextStyle}>*</span>. Prefix conditions filter LIST requests only, so pair <span style={monoTextStyle}>bucket/releases/*</span> with <span style={monoTextStyle}>releases/*</span> when users should only list that prefix.
          <div style={{ marginTop: 6 }}>
            Variables: <span style={monoTextStyle}>{'${username}'}</span> and <span style={monoTextStyle}>{'${access_key_id}'}</span> expand per authenticated user.
          </div>
        </div>
      </details>
      {permissions.map((row, i) => {
        const isDeny = row.effect === 'Deny';
        const hasCond = hasConditions(row.conditions);
        const conditionsVisible = expandedConditions.has(i) || hasCond;
        const prefixVal = getConditionValue(row.conditions, 'StringLike', 's3:prefix');
        const ipVal = getConditionValue(row.conditions, 'IpAddress', 'aws:SourceIp');

        return (
          <div key={i} style={{
            border: `1px solid ${isDeny ? `${colors.ACCENT_RED}40` : colors.BORDER}`,
            borderLeft: isDeny ? `3px solid ${colors.ACCENT_RED}` : `1px solid ${colors.BORDER}`,
            borderRadius: 8,
            padding: 14,
            marginBottom: 10,
            background: isDeny ? `${colors.ACCENT_RED}08` : colors.BG_BASE,
          }}>
            {/* Header: Allow/Deny + Conditions toggle + Remove */}
            <div style={{ marginBottom: 10, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span title="Deny rules override Allow rules">
                  <Segmented
                    size="small"
                    value={row.effect || 'Allow'}
                    onChange={v => {
                      const updated = [...permissions];
                      updated[i] = { ...updated[i], effect: v as string };
                      onChange(updated);
                    }}
                    options={[
                      { label: 'Allow', value: 'Allow' },
                      { label: <span style={{ color: isDeny ? colors.ACCENT_RED : undefined, fontWeight: isDeny ? 600 : undefined }}>Deny</span>, value: 'Deny' },
                    ]}
                  />
                </span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <Button
                  type={conditionsVisible ? 'default' : 'text'}
                  size="small"
                  icon={<FilterOutlined />}
                  title={
                    hasCond
                      ? 'Conditions are expanded while prefix or IP filters are set — clear those fields below to collapse.'
                      : 'Show optional conditions: prefix restriction and IP filtering'
                  }
                  disabled={hasCond}
                  onClick={() => toggleConditions(i)}
                  style={{
                    opacity: conditionsVisible ? 1 : 0.75,
                    color: hasCond ? colors.ACCENT_PURPLE : undefined,
                    borderColor: conditionsVisible ? `${colors.ACCENT_PURPLE}66` : undefined,
                  }}
                >
                  Conditions
                </Button>
                <Button type="text" danger size="small" icon={<DeleteOutlined />} onClick={() => onChange(permissions.filter((_, j) => j !== i))}>
                  Remove
                </Button>
              </div>
            </div>

            {/* Actions */}
            <div style={{ marginBottom: 12 }}>
              <Text type="secondary" style={{ fontSize: 12, fontWeight: 500 }}>Actions</Text>
              <Checkbox.Group
                value={row.actions}
                onChange={v => {
                  const updated = [...permissions];
                  updated[i] = { ...updated[i], actions: v as string[] };
                  onChange(updated);
                }}
                style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 10px', marginTop: 6 }}
              >
                {ACTION_OPTIONS.map(opt => (
                  <Checkbox key={opt.value} value={opt.value} style={{ fontSize: 12 }}>{opt.label}</Checkbox>
                ))}
              </Checkbox.Group>
            </div>

            {/* Resources */}
            <div style={{ marginBottom: conditionsVisible ? 12 : 4 }}>
              <Text type="secondary" style={{ fontSize: 12, fontWeight: 500 }}>Resources</Text>
              <ResourcePatternInput
                value={row.resources}
                onChange={value => {
                  const updated = [...permissions];
                  updated[i] = { ...updated[i], resources: value };
                  onChange(updated);
                }}
                buckets={bucketNames}
                style={{ ...inputRadius, marginTop: 4 }}
              />
            </div>

            {/* Conditions — collapsible only when empty; persisted rules with data stay open */}
            {conditionsVisible && (
              <div style={{
                borderTop: `1px solid ${colors.BORDER}`,
                paddingTop: 12,
                marginTop: 6,
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
                  <FilterOutlined style={{ fontSize: 11, color: colors.ACCENT_PURPLE }} />
                  <Text style={{ fontSize: 12, fontWeight: 500, color: colors.ACCENT_PURPLE }}>Optional filters</Text>
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {/* s3:prefix condition */}
                  <div>
                    <div style={condLabelStyle}>
                      List prefix
                      <span style={{ fontWeight: 400, textTransform: 'none', marginLeft: 6, opacity: 0.6 }}>
                        s3:prefix StringLike
                      </span>
                    </div>
                    <ConditionPrefixInput
                      value={prefixVal}
                      bucket={firstConcreteResourceBucket(row.resources)}
                      onChange={value => {
                        const updated = [...permissions];
                        updated[i] = {
                          ...updated[i],
                          conditions: setConditionValue(row.conditions, 'StringLike', 's3:prefix', value),
                        };
                        onChange(updated);
                      }}
                      style={{ ...inputRadius, width: '100%', fontFamily: 'var(--font-mono)', fontSize: 12 }}
                    />
                  </div>

                  {/* aws:SourceIp condition */}
                  <div>
                    <div style={condLabelStyle}>
                      IP restriction
                      <span style={{ fontWeight: 400, textTransform: 'none', marginLeft: 6, opacity: 0.6 }}>
                        IpAddress on aws:SourceIp
                      </span>
                    </div>
                    <Input
                      value={ipVal}
                      onChange={e => {
                        const updated = [...permissions];
                        updated[i] = {
                          ...updated[i],
                          conditions: setConditionValue(row.conditions, 'IpAddress', 'aws:SourceIp', e.target.value),
                        };
                        onChange(updated);
                      }}
                      placeholder="e.g. 192.168.0.0/16, 10.0.0.0/8"
                      style={{ ...inputRadius, fontFamily: 'var(--font-mono)', fontSize: 12 }}
                    />
                    <div style={{ fontSize: 10, color: colors.TEXT_MUTED, marginTop: 4 }}>
                      CIDR notation. Only requests from matching IPs will trigger this rule.
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>
        );
      })}

      <Button type="dashed" icon={<PlusOutlined />} onClick={() => onChange([...permissions, { effect: 'Allow', actions: [], resources: '' }])} block style={{ borderRadius: 8, marginBottom: 16 }}>
        Add Permission Rule
      </Button>
    </>
  );
}
