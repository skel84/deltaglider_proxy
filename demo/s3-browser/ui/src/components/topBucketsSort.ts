/** Top-buckets sort key. Stable string union — also the value
 * persisted to localStorage so we can deserialize on mount. */
export type TopBucketsSortKey = 'original' | 'savings' | 'ratio' | 'objects' | 'recent';

export const SORT_LABELS: Record<TopBucketsSortKey, string> = {
  original: 'original size',
  savings: 'bytes saved',
  ratio: 'savings ratio',
  objects: 'object count',
  recent: 'most recent scan',
};
