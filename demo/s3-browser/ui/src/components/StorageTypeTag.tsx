import { Tag } from 'antd';

type StorageTypeColor = { bg: string; border: string; text: string };

interface Props {
  storageType?: string;
  colors: Record<string, StorageTypeColor>;
  fallback: StorageTypeColor;
}

/**
 * Renders the storage-type compression badge (Original / Delta / Reference).
 * Decoupled from ThemeContext: the caller passes the resolved color map and
 * fallback so this stays a pure presentational component.
 */
export default function StorageTypeTag({ storageType, colors, fallback }: Props) {
  const label = !storageType || storageType === 'passthrough'
    ? 'Original'
    : storageType.charAt(0).toUpperCase() + storageType.slice(1);
  const c = colors[storageType || 'passthrough'] || fallback;
  return (
    <Tag style={{
      background: c.bg,
      border: `1px solid ${c.border}`,
      color: c.text,
      borderRadius: 6,
      fontFamily: 'var(--font-mono)',
      fontSize: 11,
      fontWeight: 500,
    }}>
      {label}
    </Tag>
  );
}
