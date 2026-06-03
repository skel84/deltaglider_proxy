/**
 * RowListEditor<T> — the shared add / remove / update-by-id scaffolding for the
 * admin UI's many row-list editors (endpoints, headers, prefixes, …).
 *
 * The recurring "admin-editor bug class" lives almost entirely in list
 * plumbing: keying React by array index, mutating the wrong row after a
 * reorder, or reading a stale closure. This component centralises the correct
 * discipline so panels stop re-deriving it:
 *
 *   - every item is keyed by its own stable `id` (NEVER the array index);
 *   - update / remove address rows BY id (`items.map(r => r.id === id ? … : r)`);
 *   - `onChange` receives the next array — the consumer folds it into its single
 *     source of truth (a `useSectionEditor` value or a functional setState), so
 *     there is never a parallel mirror here.
 *
 * The consumer owns row RENDERING (`renderRow`) and the id/shape of `T` (which
 * must carry a string `id`). This component owns only the list scaffolding: the
 * keyed map, the `update`/`remove` helpers handed to each row, and the add
 * button driven by the `newItem()` factory.
 */
import type { ReactNode } from 'react';
import { Button } from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import { useColors } from '../ThemeContext';

/** Anything editable by this component must carry a stable string id. */
interface HasId {
  id: string;
}

interface Props<T extends HasId> {
  items: T[];
  /** Receives the next array. The consumer commits it to its source of truth. */
  onChange: (next: T[]) => void;
  /**
   * Render ONE row. `update(patch)` merges a partial into this row (by id);
   * `remove()` drops it (by id). Both route through `onChange`, never a stale
   * closure. The consumer must key any inner controls it needs — the outer
   * `key={item.id}` is handled here.
   */
  renderRow: (item: T, update: (patch: Partial<T>) => void, remove: () => void) => ReactNode;
  /** Factory for a fresh row (must mint a stable `id`). */
  newItem: () => T;
  /** Label for the add button. */
  addLabel: string;
  /** Optional hint shown when the list is empty. */
  emptyHint?: ReactNode;
  /** Wrapper style for the rows container. */
  style?: React.CSSProperties;
  /** Gap (px) between rows; default 8. */
  gap?: number;
  /** Add-button size; default 'small'. */
  addButtonSize?: 'small' | 'middle' | 'large';
  /** Add-button type; default 'default'. */
  addButtonType?: 'default' | 'text' | 'dashed';
  /** Optional style override for the add button. */
  addButtonStyle?: React.CSSProperties;
}

export default function RowListEditor<T extends HasId>({
  items,
  onChange,
  renderRow,
  newItem,
  addLabel,
  emptyHint,
  style,
  gap = 8,
  addButtonSize = 'small',
  addButtonType = 'default',
  addButtonStyle,
}: Props<T>) {
  const colors = useColors();

  const update = (id: string, patch: Partial<T>) =>
    onChange(items.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  const remove = (id: string) => onChange(items.filter((r) => r.id !== id));
  const add = () => onChange([...items, newItem()]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap, ...style }}>
      {items.length === 0 && emptyHint != null && emptyHint}
      {items.map((item) => (
        <div key={item.id}>
          {renderRow(
            item,
            (patch) => update(item.id, patch),
            () => remove(item.id),
          )}
        </div>
      ))}
      <Button
        type={addButtonType}
        size={addButtonSize}
        icon={<PlusOutlined />}
        onClick={add}
        style={{
          alignSelf: 'flex-start',
          ...(addButtonType === 'text' ? { color: colors.TEXT_MUTED } : {}),
          ...addButtonStyle,
        }}
      >
        {addLabel}
      </Button>
    </div>
  );
}
