import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Button, Input, message, Select, Space, Switch, Table, Tag, Typography } from 'antd';
import {
  DatabaseOutlined,
  ReloadOutlined,
  SearchOutlined,
  SyncOutlined,
} from '@ant-design/icons';
import type { ColumnsType, TablePaginationConfig } from 'antd/es/table';
import type { SorterResult } from 'antd/es/table/interface';
import { useColors } from '../ThemeContext';
import {
  fetchEventOutbox,
  requeueEventOutbox,
  requeueEventOutboxMany,
  type EventOutboxRecord,
  type EventOutboxStatus,
} from '../adminApi';

const { Text } = Typography;
const DEFAULT_PAGE_SIZE = 50;
const PAGE_SIZE_OPTIONS = [25, 50, 100, 250];

interface Props {
  onSessionExpired?: () => void;
}

type StatusFilter = EventOutboxStatus | 'all';
type SortOrder = 'asc' | 'desc';

function fmtUnix(ts: number | null | undefined): string {
  if (!ts) return '—';
  return new Date(ts * 1000).toLocaleString(undefined, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function statusColour(status: string): string {
  if (status === 'delivered') return 'success';
  if (status === 'failed') return 'error';
  if (status === 'in_progress') return 'processing';
  return 'warning';
}

export default function EventOutboxPanel({ onSessionExpired }: Props) {
  const colors = useColors();
  const [rows, setRows] = useState<EventOutboxRecord[]>([]);
  const [counts, setCounts] = useState({ pending: 0, in_progress: 0, delivered: 0, failed: 0 });
  const [total, setTotal] = useState(0);
  const [deliveryEnabled, setDeliveryEnabled] = useState(false);
  const [deliveryActive, setDeliveryActive] = useState(false);
  const [filter, setFilter] = useState('');
  const [status, setStatus] = useState<StatusFilter>('all');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [sort, setSort] = useState('occurred_at');
  const [order, setOrder] = useState<SortOrder>('desc');
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [loading, setLoading] = useState(true);
  const [requeueing, setRequeueing] = useState<number | 'bulk' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setLoading(true);
      const res = await fetchEventOutbox(pageSize, status, (page - 1) * pageSize, sort, order);
      setRows(res.rows);
      setCounts(res.counts);
      setTotal(res.total);
      setDeliveryEnabled(res.delivery_enabled);
      setDeliveryActive(res.delivery_active);
      setError(null);
    } catch (e) {
      if (e instanceof Error && e.message.includes('401')) {
        onSessionExpired?.();
        return;
      }
      setError(e instanceof Error ? e.message : 'Failed to load event outbox');
    } finally {
      setLoading(false);
    }
  }, [onSessionExpired, order, page, pageSize, sort, status]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!autoRefresh) return;
    const id = setInterval(() => void refresh(), 3000);
    return () => clearInterval(id);
  }, [autoRefresh, refresh]);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((row) =>
      `${row.kind} ${row.bucket} ${row.key} ${row.source} ${row.status} ${row.last_error || ''}`
        .toLowerCase()
        .includes(q),
    );
  }, [filter, rows]);

  const visibleFailedIds = useMemo(
    () => filtered.filter((row) => row.status === 'failed').map((row) => row.id),
    [filtered],
  );

  const onTableChange = (
    pagination: TablePaginationConfig,
    _filters: Record<string, unknown>,
    sorter: SorterResult<EventOutboxRecord> | SorterResult<EventOutboxRecord>[],
  ) => {
    setPage(pagination.current || 1);
    setPageSize(pagination.pageSize || DEFAULT_PAGE_SIZE);

    const activeSorter = Array.isArray(sorter) ? sorter[0] : sorter;
    if (activeSorter?.field && activeSorter.order) {
      setSort(String(activeSorter.field));
      setOrder(activeSorter.order === 'ascend' ? 'asc' : 'desc');
    } else {
      setSort('occurred_at');
      setOrder('desc');
    }
  };

  const columns: ColumnsType<EventOutboxRecord> = [
    {
      title: 'ID',
      dataIndex: 'id',
      key: 'id',
      width: 86,
      sorter: true,
      sortOrder: sort === 'id' ? (order === 'asc' ? 'ascend' : 'descend') : null,
      render: (id: number) => <Text code>#{id}</Text>,
    },
    {
      title: 'Status',
      dataIndex: 'status',
      key: 'status',
      width: 128,
      sorter: true,
      sortOrder: sort === 'status' ? (order === 'asc' ? 'ascend' : 'descend') : null,
      render: (value: EventOutboxStatus) => <Tag color={statusColour(value)}>{value}</Tag>,
    },
    {
      title: 'Kind',
      dataIndex: 'kind',
      key: 'kind',
      width: 190,
      sorter: true,
      sortOrder: sort === 'kind' ? (order === 'asc' ? 'ascend' : 'descend') : null,
      render: (_: string, row) => (
        <div title={`${row.kind} · ${row.source}`} style={{ minWidth: 0 }}>
          <Text style={{ display: 'block', fontSize: 12 }}>{row.kind}</Text>
          <Text type="secondary" style={{ display: 'block', fontSize: 11 }}>{row.source}</Text>
        </div>
      ),
    },
    {
      title: 'Object',
      dataIndex: 'key',
      key: 'key',
      width: 360,
      sorter: true,
      sortOrder: sort === 'key' ? (order === 'asc' ? 'ascend' : 'descend') : null,
      render: (_: string, row) => (
        <div title={`${row.bucket}/${row.key}`} style={{ minWidth: 0 }}>
          <Text code style={{ display: 'block', maxWidth: 330, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {row.bucket}
          </Text>
          <Text style={{ display: 'block', maxWidth: 330, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {row.key || '—'}
          </Text>
        </div>
      ),
    },
    {
      title: 'Occurred',
      dataIndex: 'occurred_at',
      key: 'occurred_at',
      width: 190,
      sorter: true,
      defaultSortOrder: 'descend',
      sortOrder: sort === 'occurred_at' ? (order === 'asc' ? 'ascend' : 'descend') : null,
      render: (value: number) => <span title={fmtUnix(value)}>{fmtUnix(value)}</span>,
    },
    {
      title: 'Created',
      dataIndex: 'created_at',
      key: 'created_at',
      width: 190,
      sorter: true,
      sortOrder: sort === 'created_at' ? (order === 'asc' ? 'ascend' : 'descend') : null,
      render: (value: number) => <span title={fmtUnix(value)}>{fmtUnix(value)}</span>,
    },
    {
      title: 'Attempts',
      dataIndex: 'attempts',
      key: 'attempts',
      width: 110,
      sorter: true,
      sortOrder: sort === 'attempts' ? (order === 'asc' ? 'ascend' : 'descend') : null,
      render: (value: number) => <Text>{value}</Text>,
    },
    {
      title: 'Next Try',
      dataIndex: 'next_attempt_at',
      key: 'next_attempt_at',
      width: 190,
      sorter: true,
      sortOrder: sort === 'next_attempt_at' ? (order === 'asc' ? 'ascend' : 'descend') : null,
      render: (value: number | null) => <span title={fmtUnix(value)}>{fmtUnix(value)}</span>,
    },
    {
      title: 'Error / Payload',
      key: 'last_error',
      width: 360,
      render: (_: unknown, row) => {
        const text = row.last_error || JSON.stringify(row.payload);
        return (
          <Text
            type={row.last_error ? 'danger' : 'secondary'}
            title={text}
            style={{ display: 'block', maxWidth: 330, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
          >
            {text}
          </Text>
        );
      },
    },
    {
      title: 'Action',
      key: 'action',
      width: 122,
      fixed: 'right',
      render: (_: unknown, row) => (
        <Button
          size="small"
          icon={<SyncOutlined />}
          disabled={row.status !== 'failed'}
          loading={requeueing === row.id}
          onClick={() => void requeueOne(row.id)}
        >
          Requeue
        </Button>
      ),
    },
  ];

  const requeueOne = async (id: number) => {
    try {
      setRequeueing(id);
      const res = await requeueEventOutbox(id);
      message.success(`Requeued ${res.requeued} event`);
      await refresh();
    } catch (e) {
      if (e instanceof Error && e.message.includes('401')) {
        onSessionExpired?.();
        return;
      }
      message.error(e instanceof Error ? e.message : 'Failed to requeue event');
    } finally {
      setRequeueing(null);
    }
  };

  const requeueVisibleFailed = async () => {
    if (visibleFailedIds.length === 0) return;
    try {
      setRequeueing('bulk');
      const res = await requeueEventOutboxMany(visibleFailedIds);
      message.success(`Requeued ${res.requeued} failed event${res.requeued === 1 ? '' : 's'}`);
      await refresh();
    } catch (e) {
      if (e instanceof Error && e.message.includes('401')) {
        onSessionExpired?.();
        return;
      }
      message.error(e instanceof Error ? e.message : 'Failed to requeue failed events');
    } finally {
      setRequeueing(null);
    }
  };

  return (
    <div style={{ maxWidth: 1180, margin: '0 auto', padding: 'clamp(12px, 2vw, 18px)', display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
          padding: '10px 12px',
          border: `1px solid ${colors.BORDER}`,
          borderRadius: 10,
          background: colors.BG_CARD,
        }}
      >
        <Space size={10}>
          <DatabaseOutlined style={{ color: colors.ACCENT_BLUE }} />
          <Text strong>Object change events</Text>
          <Tag
            color={deliveryActive ? 'success' : deliveryEnabled ? 'warning' : 'default'}
            title="Delivery runs in the background. Pending rows stay queued; failed rows can be requeued."
          >
            delivery {deliveryActive ? 'active' : deliveryEnabled ? 'waiting' : 'off'}
          </Tag>
        </Space>
        <Text type="secondary" style={{ fontSize: 12 }} title="Rows are stored in the encrypted config DB. Delivered rows are pruned by retention/count limits; pending and failed rows are kept because they are real queue state.">
          Durable queue for S3 object changes
        </Text>
      </div>

      {error && <Alert type="error" showIcon message="Fetch failed" description={error} />}

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <Input
          placeholder="Filter current page..."
          prefix={<SearchOutlined style={{ color: colors.TEXT_MUTED }} />}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          style={{ width: 300 }}
          allowClear
        />
        <Select
          value={status}
          onChange={(value) => {
            setStatus(value);
            setPage(1);
          }}
          style={{ width: 170 }}
          options={[
            { value: 'all', label: 'All statuses' },
            { value: 'pending', label: `Pending (${counts.pending})` },
            { value: 'in_progress', label: `In progress (${counts.in_progress})` },
            { value: 'failed', label: `Failed (${counts.failed})` },
            { value: 'delivered', label: `Delivered (${counts.delivered})` },
          ]}
        />
        <Button icon={<ReloadOutlined />} onClick={() => void refresh()} loading={loading && !autoRefresh}>
          Refresh
        </Button>
        <Button
          icon={<SyncOutlined />}
          onClick={() => void requeueVisibleFailed()}
          disabled={visibleFailedIds.length === 0}
          loading={requeueing === 'bulk'}
        >
          Requeue failed shown ({visibleFailedIds.length})
        </Button>
        <Space size={6}>
          <Switch size="small" checked={autoRefresh} onChange={setAutoRefresh} />
          <Text style={{ fontSize: 12, color: colors.TEXT_MUTED }}>Auto-refresh (3s)</Text>
        </Space>
        <Text type="secondary" style={{ fontSize: 12 }}>
          {filtered.length} shown on this page · {total} total
        </Text>
      </div>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <CountPill label="Pending" value={counts.pending} colour="warning" />
        <CountPill label="In progress" value={counts.in_progress} colour="processing" />
        <CountPill label="Failed" value={counts.failed} colour="error" />
        <CountPill label="Delivered" value={counts.delivered} colour="success" />
      </div>

      <div style={{ border: `1px solid ${colors.BORDER}`, borderRadius: 8, overflow: 'hidden', background: colors.BG_CARD }}>
        <Table<EventOutboxRecord>
          columns={columns}
          dataSource={filtered}
          rowKey="id"
          loading={loading}
          size="small"
          tableLayout="fixed"
          showSorterTooltip={false}
          scroll={{ x: 1900 }}
          onChange={onTableChange}
          locale={{ emptyText: loading ? 'Loading...' : 'No outbox rows match this view.' }}
          pagination={{
            current: page,
            pageSize,
            total,
            showSizeChanger: true,
            pageSizeOptions: PAGE_SIZE_OPTIONS.map(String),
            size: 'small',
            showTotal: (value, range) => `${range[0]}-${range[1]} of ${value}`,
          }}
        />
      </div>
    </div>
  );
}

function CountPill({ label, value, colour }: { label: string; value: number; colour: string }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, border: '1px solid var(--border)', borderRadius: 999, padding: '5px 9px', background: 'var(--card-bg)' }}>
      <Text type="secondary" style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.4 }}>{label}</Text>
      <Tag color={colour} style={{ marginInlineEnd: 0 }}>{value}</Tag>
    </span>
  );
}
