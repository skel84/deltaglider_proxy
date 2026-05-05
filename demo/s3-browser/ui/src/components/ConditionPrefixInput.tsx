import { DeleteOutlined, PlusOutlined } from '@ant-design/icons';
import { useEffect, useMemo, useState } from 'react';
import { Button } from 'antd';
import { listCommonPrefixes } from '../s3client';
import { normalizePrefix } from '../storagePath';
import { useColors } from '../ThemeContext';
import SimpleAutoComplete, { type AutoCompleteEntry, type AutoCompleteGroup } from './SimpleAutoComplete';

function normalizePrefixPattern(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed === '.*' || trimmed === '*') return trimmed;

  if (trimmed.endsWith('*')) {
    const base = trimmed.slice(0, -1);
    return `${normalizePrefix(base)}*`;
  }

  return normalizePrefix(trimmed);
}

function normalizeList(value: string): string {
  return value
    .split(',')
    .map((part) => normalizePrefixPattern(part))
    .filter(Boolean)
    .join(', ');
}

interface ConditionPrefixInputProps {
  value: string;
  onChange: (value: string) => void;
  bucket?: string;
  style?: React.CSSProperties;
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

function uniqueEntries(entries: AutoCompleteEntry[]): AutoCompleteEntry[] {
  const seen = new Set<string>();
  const out: AutoCompleteEntry[] = [];
  for (const e of entries) {
    if (seen.has(e.value)) continue;
    seen.add(e.value);
    out.push(e);
  }
  return out;
}

function prefixQueryFromPattern(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed === '*' || trimmed === '.*') return '';
  return normalizePrefix(trimmed.replace(/\*$/, ''));
}

function splitRows(value: string): string[] {
  const rows = value.split(',').map((part) => part.trim());
  return rows.length > 0 ? rows : [''];
}

function serializeRows(rows: string[]): string {
  if (rows.every((row) => !row.trim())) return rows.length > 1 ? rows.map(() => '').join(', ') : '';
  return rows.map((row) => row.trim()).join(', ');
}

export default function ConditionPrefixInput({ value, onChange, bucket = '', style }: ConditionPrefixInputProps) {
  const colors = useColors();
  const [prefixOptions, setPrefixOptions] = useState<string[]>([]);
  const [focusedIndex, setFocusedIndex] = useState<number | null>(null);
  const rows = useMemo(() => splitRows(value), [value]);
  const activeValue = focusedIndex === null ? '' : rows[focusedIndex] || '';
  const prefixQuery = useMemo(() => prefixQueryFromPattern(activeValue), [activeValue]);
  const templateSuggestions = useMemo(
    () => ['home/${username}/*', 'keys/${access_key_id}/*', '.*'] as string[],
    [],
  );

  const optionGroups = useMemo((): AutoCompleteGroup[] => {
    const listed: AutoCompleteEntry[] = uniqueEntries(
      prefixOptions.map((prefix) => ({
        value: `${prefix}*`,
        source: 'listed' as const,
      })),
    );
    const groups: AutoCompleteGroup[] = [];
    if (listed.length > 0) {
      groups.push({
        label: bucket ? `Listed prefixes in “${bucket}”` : 'Listed prefixes',
        entries: listed,
      });
    }
    groups.push({
      label: 'Variable patterns',
      subtitle: 'Dimmed text is a placeholder filled in per user. These suggestions are not pulled from the folder list above.',
      entries: templateSuggestions.map((v) => ({
        value: v,
        source: 'template' as const,
        realPrefix: '',
      })),
    });
    return groups;
  }, [bucket, prefixOptions, templateSuggestions]);

  const chipSuggestions = useMemo(
    () => unique([...prefixOptions.slice(0, 4).map((prefix) => `${prefix}*`), ...templateSuggestions]).slice(0, 6),
    [prefixOptions, templateSuggestions],
  );
  const inputStyle: React.CSSProperties = {
    ...style,
    width: '100%',
    fontFamily: 'var(--font-mono)',
    fontSize: 12,
  };
  const chipStyle: React.CSSProperties = {
    minHeight: 24,
    height: 'auto',
    padding: '2px 8px',
    border: `1px solid ${colors.BORDER}`,
    borderRadius: 6,
    background: colors.BG_ELEVATED,
    color: colors.ACCENT_BLUE,
    fontFamily: 'var(--font-mono)',
    fontSize: 11,
    cursor: 'pointer',
    whiteSpace: 'normal',
    textAlign: 'left',
    lineHeight: 1.35,
  };

  useEffect(() => {
    let cancelled = false;
    const cleanBucket = bucket.trim();
    if (!cleanBucket) {
      setPrefixOptions([]);
      return;
    }

    const timer = window.setTimeout(() => {
      listCommonPrefixes(cleanBucket, prefixQuery)
        .then((prefixes) => {
          if (!cancelled) setPrefixOptions(prefixes);
        })
        .catch(() => {
          if (!cancelled) setPrefixOptions([]);
        });
    }, 200);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [bucket, prefixQuery]);

  const updateRow = (index: number, nextValue: string) => {
    const nextRows = [...rows];
    nextRows[index] = nextValue.replace(/\r?\n/g, ' ');
    onChange(serializeRows(nextRows));
  };

  const addRow = () => {
    onChange(serializeRows([...rows, '']));
  };

  const deleteRow = (index: number) => {
    const nextRows = rows.filter((_, rowIndex) => rowIndex !== index);
    onChange(serializeRows(nextRows.length > 0 ? nextRows : ['']));
    setFocusedIndex((current) => {
      if (current === null) return null;
      if (current === index) return null;
      return current > index ? current - 1 : current;
    });
  };

  const applySuggestion = (pattern: string) => {
    if (focusedIndex === null) return;
    updateRow(focusedIndex, pattern);
  };

  return (
    <div style={{ width: '100%' }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: style?.marginTop }}>
        {rows.map((row, index) => (
          <div key={index} style={{ display: 'flex', gap: 6, alignItems: 'center', width: '100%' }}>
            <div style={{ flex: 1, minWidth: 0 }} onFocusCapture={() => setFocusedIndex(index)}>
              <SimpleAutoComplete
                value={row}
                filterText={row}
                autoComplete={`dgp-prefix-${bucket || 'nobucket'}-${index}`}
                onChange={(v) => updateRow(index, v)}
                onBlur={() => {
                  setFocusedIndex(null);
                  onChange(normalizeList(value));
                }}
                optionGroups={optionGroups}
                placeholder="uploads/*"
                style={{ ...inputStyle, marginTop: 0 }}
              />
            </div>
            {rows.length > 1 && (
              <Button
                type="text"
                danger
                size="small"
                icon={<DeleteOutlined />}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => deleteRow(index)}
                style={{ flex: '0 0 auto' }}
              />
            )}
          </div>
        ))}
      </div>
      <Button
        type="dashed"
        size="small"
        icon={<PlusOutlined />}
        onMouseDown={(e) => e.preventDefault()}
        onClick={addRow}
        block
        style={{ marginTop: 6, borderRadius: 8 }}
      >
        Add prefix
      </Button>
      {focusedIndex !== null && (
        <div style={{ marginTop: 8, display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
          {chipSuggestions.map((pattern) => (
            <Button
              key={pattern}
              type="text"
              size="small"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => applySuggestion(pattern)}
              style={chipStyle}
            >
              {pattern}
            </Button>
          ))}
        </div>
      )}
      <div style={{ fontSize: 11, color: colors.TEXT_MUTED, marginTop: 6, lineHeight: 1.45 }}>
        {bucket ? `Browsing prefixes in ${bucket}.` : 'Choose a concrete resource bucket for live suggestions.'}
      </div>
    </div>
  );
}
