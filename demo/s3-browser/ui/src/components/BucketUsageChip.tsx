import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ReloadOutlined } from '@ant-design/icons';
import { getBucketUsage, refreshBucketUsage } from '../adminApi';
import { qk } from '../queries/keys';
import { useColors } from '../ThemeContext';
import { formatBytes } from '../utils';
import { timeAgo } from '../utils';

/**
 * O(1) bucket-size pill in the TopBar — the Ceph-style running counter
 * (`src/bucket_usage.rs`): `<size> · <N> objects`, maintained inline on every
 * PUT/DELETE so it's instant even on huge buckets. The ⟳ button forces an
 * authoritative full scan (the only O(n) path). Auto-hides without an admin
 * session (the endpoint 403s → null). `last_scan_at` shows when a scan last
 * reconciled the running total.
 */
export default function BucketUsageChip({
  bucket,
  canAdmin,
}: {
  bucket: string;
  canAdmin: boolean;
}) {
  const c = useColors();
  const qc = useQueryClient();

  const { data } = useQuery({
    queryKey: qk.bucketUsage(bucket),
    queryFn: () => getBucketUsage(bucket),
    enabled: canAdmin && !!bucket,
    staleTime: 15_000,
  });

  const refresh = useMutation({
    mutationFn: () => refreshBucketUsage(bucket),
    onSuccess: (row) => {
      if (row) qc.setQueryData(qk.bucketUsage(bucket), row);
    },
  });

  // No session, no data, or a "disabled" payload (open-mode dev) → render nothing.
  if (!canAdmin || !data || data.object_count == null) return null;

  const scannedTitle =
    data.last_scan_at != null
      ? `Last full scan ${timeAgo(new Date(data.last_scan_at * 1000))}`
      : 'Never scanned — running total maintained on every write/delete; ⟳ to reconcile';

  return (
    <span
      title={scannedTitle}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '2px 8px',
        borderRadius: 6,
        border: `1px solid ${c.BORDER}`,
        background: c.BG_ELEVATED,
        fontSize: 12,
        color: c.TEXT_SECONDARY,
        whiteSpace: 'nowrap',
        cursor: 'default',
      }}
    >
      <strong style={{ color: c.TEXT_PRIMARY, fontVariantNumeric: 'tabular-nums' }}>
        {formatBytes(data.logical_bytes)}
      </strong>
      <span style={{ color: c.TEXT_MUTED }}>·</span>
      <span style={{ fontVariantNumeric: 'tabular-nums' }}>
        {data.object_count.toLocaleString()} objects
      </span>
      <ReloadOutlined
        spin={refresh.isPending}
        onClick={() => !refresh.isPending && refresh.mutate()}
        title="Refresh (full scan)"
        style={{
          cursor: refresh.isPending ? 'default' : 'pointer',
          color: c.ACCENT_BLUE,
          fontSize: 11,
        }}
      />
    </span>
  );
}
