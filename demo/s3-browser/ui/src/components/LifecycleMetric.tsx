import { Typography } from 'antd';

const { Text } = Typography;

/** Small bordered metric tile shared by the Lifecycle summary grid and preview panel. */
export default function Metric({
  label,
  value,
  tone,
}: {
  label: string;
  value: string | number;
  tone?: 'error' | 'warning';
}) {
  return (
    <div
      style={{
        border: '1px solid var(--border)',
        borderRadius: 10,
        padding: '8px 10px',
        background: 'var(--input-bg)',
        minWidth: 120,
      }}
    >
      <Text type="secondary" style={{ display: 'block', fontSize: 11 }}>{label}</Text>
      <Text strong type={tone === 'error' ? 'danger' : tone}>{value}</Text>
    </div>
  );
}
