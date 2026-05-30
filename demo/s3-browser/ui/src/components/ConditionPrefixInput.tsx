import { DeleteOutlined, PlusOutlined } from '@ant-design/icons';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from 'antd';
import { listCommonPrefixes } from '../s3client';
import { normalizePrefix } from '../storagePath';
import {
  freshRowId,
  normalizePrefixPattern,
  parseRows,
  serializeRows,
  type PrefixRow,
} from '../conditionPrefixRows';
import { useColors } from '../ThemeContext';
import SimpleAutoComplete, { type AutoCompleteEntry, type AutoCompleteGroup } from './SimpleAutoComplete';

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

export default function ConditionPrefixInput({ value, onChange, bucket = '', style }: ConditionPrefixInputProps) {
  const colors = useColors();
  const [prefixOptions, setPrefixOptions] = useState<string[]>([]);
  const [focusedId, setFocusedId] = useState<string | null>(null);

  // Local editing state is the single source of truth WHILE editing. The
  // `value` prop only seeds it, and only when the prop changes from something
  // this component did NOT just emit (external/programmatic updates).
  const [rows, setRows] = useState<PrefixRow[]>(() => parseRows(value));
  // Mirror of `rows` read synchronously by `emit` so a burst of edits within
  // one tick always builds on the freshest rows, never a stale render snapshot.
  const rowsRef = useRef<PrefixRow[]>(rows);
  rowsRef.current = rows;
  // The last comma string we emitted upward — used to distinguish our own
  // echoes (ignore) from genuine external prop changes (re-seed local rows).
  const lastEmitted = useRef<string>(serializeRows(rows));

  useEffect(() => {
    // Ignore the prop change if it's the value we just emitted (echo).
    if (value === lastEmitted.current) return;
    // Genuine external change: re-seed local rows from the new prop.
    lastEmitted.current = value;
    const seeded = parseRows(value);
    rowsRef.current = seeded;
    setRows(seeded);
  }, [value]);

  // Apply a row mutation against the LATEST committed rows. We read the live
  // rows via the rowsRef (kept in sync by the render below) rather than the
  // closed-over `rows` snapshot — that snapshot staleness is the whole bug
  // class we're killing. The setRows updater stays pure; the ref/onChange
  // side effects run exactly once here, outside React's StrictMode double-render.
  const emit = (mutate: (current: PrefixRow[]) => PrefixRow[]) => {
    const next = mutate(rowsRef.current);
    rowsRef.current = next;
    setRows(next);
    const serialized = serializeRows(next);
    if (serialized !== lastEmitted.current) {
      lastEmitted.current = serialized;
      onChange(serialized);
    }
  };

  const focusedRow = focusedId === null ? null : rows.find((r) => r.id === focusedId) || null;
  const activeValue = focusedRow?.text || '';
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

  const updateRow = (id: string, nextValue: string) => {
    emit((current) =>
      current.map((row) => (row.id === id ? { ...row, text: nextValue.replace(/\r?\n/g, ' ') } : row)),
    );
  };

  const addRow = () => {
    // Keep the new empty row in LOCAL state only (don't emit — an empty row
    // contributes nothing to the persisted string and re-parsing it would be
    // a no-op anyway). It becomes persistable once the user types into it.
    const next = [...rowsRef.current, { id: freshRowId(), text: '' }];
    rowsRef.current = next;
    setRows(next);
  };

  const deleteRow = (id: string) => {
    emit((current) => {
      const remaining = current.filter((row) => row.id !== id);
      return remaining.length > 0 ? remaining : [{ id: freshRowId(), text: '' }];
    });
    setFocusedId((current) => (current === id ? null : current));
  };

  const normalizeRowOnBlur = (id: string) => {
    setFocusedId(null);
    // Normalize ONLY the row that blurred, in local state. No reparse of the
    // comma string, no stale closure over the prop — so other rows can never
    // be affected by one row losing focus.
    emit((current) =>
      current.map((row) =>
        row.id === id ? { ...row, text: normalizePrefixPattern(row.text) } : row,
      ),
    );
  };

  const applySuggestion = (pattern: string) => {
    if (focusedId === null) return;
    updateRow(focusedId, pattern);
  };

  return (
    <div style={{ width: '100%' }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: style?.marginTop }}>
        {rows.map((row) => (
          <div key={row.id} style={{ display: 'flex', gap: 6, alignItems: 'center', width: '100%' }}>
            <div style={{ flex: 1, minWidth: 0 }} onFocusCapture={() => setFocusedId(row.id)}>
              <SimpleAutoComplete
                value={row.text}
                filterText={row.text}
                autoComplete={`dgp-prefix-${bucket || 'nobucket'}-${row.id}`}
                onChange={(v) => updateRow(row.id, v)}
                onBlur={() => normalizeRowOnBlur(row.id)}
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
                onClick={() => deleteRow(row.id)}
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
      {focusedId !== null && (
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
