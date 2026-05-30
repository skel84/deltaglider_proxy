import { useColors } from '../ThemeContext';
import { SORT_LABELS, type TopBucketsSortKey } from './topBucketsSort';

/**
 * Inline native-select dropdown that lives in the Top buckets panel
 * header. Plain HTML select rather than AntD's Select to dodge the
 * portal/stacking-context dance — this lives inside a Panel header
 * action slot and the popup needs to escape cleanly. Native select
 * pop-up is rendered by the browser chrome, not the DOM, so it
 * never gets clipped or covered by sibling panels.
 */
export default function TopBucketsSortSelect({
  value,
  onChange,
  colors,
}: {
  value: TopBucketsSortKey;
  onChange: (v: TopBucketsSortKey) => void;
  colors: ReturnType<typeof useColors>;
}) {
  return (
    <select
      value={value}
      onChange={e => onChange(e.target.value as TopBucketsSortKey)}
      title="Sort top buckets"
      aria-label="Sort top buckets"
      style={{
        fontSize: 11,
        fontFamily: 'var(--font-ui)',
        fontWeight: 600,
        color: colors.TEXT_SECONDARY,
        background: 'transparent',
        border: `1px solid ${colors.BORDER}`,
        borderRadius: 4,
        padding: '2px 6px',
        cursor: 'pointer',
      }}
    >
      {(Object.keys(SORT_LABELS) as TopBucketsSortKey[]).map(k => (
        <option key={k} value={k}>
          Sort: {SORT_LABELS[k]}
        </option>
      ))}
    </select>
  );
}
