import { Button, Tag, Typography } from 'antd';
import { ClockCircleOutlined, PlusOutlined } from '@ant-design/icons';
import type { LifecycleConfig } from '../adminApi';
import { useColors } from '../ThemeContext';
import { actionKind, actionLabel } from './lifecyclePayload';
import { EmptyState } from './StatePlaceholders';

const { Text } = Typography;

/** Apply-dialog summary card describing the pending lifecycle plan. */
export function LifecycleApplySummary({ lifecycle }: { lifecycle: LifecycleConfig }) {
  const colors = useColors();
  return (
    <div
      style={{
        border: `1px solid ${colors.BORDER}`,
        borderRadius: 8,
        padding: 12,
        background: 'var(--input-bg)',
      }}
    >
      <Text strong>Lifecycle plan</Text>
      <Text type="secondary" style={{ display: 'block', fontSize: 12, marginTop: 4 }}>
        Scheduler {lifecycle.enabled ? 'enabled' : 'disabled'} · tick {lifecycle.tick_interval} · {lifecycle.rules.length} rule{lifecycle.rules.length === 1 ? '' : 's'}
      </Text>
      <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
        {lifecycle.rules.length === 0 ? (
          <Text type="secondary" style={{ fontSize: 12 }}>No rules configured.</Text>
        ) : lifecycle.rules.map((rule) => (
          <div key={rule.name} style={{ fontSize: 12, lineHeight: 1.6 }}>
            <Text code>{rule.name}</Text>{' '}
            <Tag color={rule.enabled ? 'warning' : 'default'}>
              {rule.enabled ? `${actionLabel(rule.action)} enabled` : 'disabled'}
            </Tag>
            <div>
              <Text strong>Scope:</Text> {rule.bucket}/{rule.prefix || '*'} · older than {rule.expire_after}
            </div>
            {actionKind(rule.action) === 'transition' && typeof rule.action === 'object' && (
              <div>
                <Text strong>Destination:</Text> {rule.action.destination.bucket}/{rule.action.destination.prefix || '*'}
                {rule.action.delete_source_after_success ? ' · deletes source after verified copy' : ' · keeps source'}
              </div>
            )}
            {(rule.include_globs.length > 0 || rule.exclude_globs.length > 0) && (
              <div>
                Include: {rule.include_globs.length ? rule.include_globs.join(', ') : 'all'} · Exclude: {rule.exclude_globs.length ? rule.exclude_globs.join(', ') : 'none'}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

/** Empty-state shown by RuleListEditor when no lifecycle rules exist yet. */
export function EmptyLifecycleState({ onAdd }: { onAdd: () => void }) {
  return (
    <EmptyState
      icon={<ClockCircleOutlined />}
      title="No lifecycle rules"
      hint="Add a disabled draft rule, preview it, then explicitly enable deletion."
      action={
        <Button type="primary" icon={<PlusOutlined />} onClick={onAdd}>
          Add lifecycle rule
        </Button>
      }
    />
  );
}
