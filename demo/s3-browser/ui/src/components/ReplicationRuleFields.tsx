import { Alert, Input, InputNumber, Radio, Switch, Tag, Typography } from 'antd';
import type { ReplicationRuleConfig, ReplicationRuleOverview } from '../adminApi';
import BucketPrefixInput from './BucketPrefixInput';
import { AdvancedDisclosure, Field } from './ruleEditorFields';
import { fmtUnix, lineList, lines } from './ruleEditorHelpers';
import { formatBytes } from '../utils';
import { statusTone } from './replicationStatus';

const { Text } = Typography;

/**
 * Per-rule field editor body (name / enabled / source / destination + advanced
 * behaviour). Extracted verbatim from ReplicationPanel; the parent renders it
 * inside RuleListEditor's `renderDetail` and owns all state/handlers.
 */
export default function ReplicationRuleFields({
  rule,
  runtime,
  buckets,
  inputRadius,
  onChange,
  onRename,
}: {
  rule: ReplicationRuleConfig;
  runtime: ReplicationRuleOverview | null;
  buckets: string[];
  inputRadius: { borderRadius: number };
  onChange: (patch: Partial<ReplicationRuleConfig>) => void;
  onRename: (nextName: string) => void;
}) {
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'flex-start' }}>
        <div>
          <Text strong style={{ fontSize: 16 }}>{rule.name}</Text>
          <Text type="secondary" style={{ display: 'block', fontSize: 12, marginTop: 2 }}>
            Last run: {fmtUnix(runtime?.last_run_at)} · Lifetime copied: {formatBytes(runtime?.bytes_copied_lifetime || 0)}
          </Text>
        </div>
        <Tag color={statusTone(runtime?.last_status || 'idle', runtime?.paused || false, rule.enabled)}>
          {runtime?.paused ? 'paused' : rule.enabled ? runtime?.last_status || 'idle' : 'disabled'}
        </Tag>
      </div>

      <div style={{ marginTop: 16, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 14 }}>
        <Field label="Rule name">
          <Input
            value={rule.name}
            onChange={(e) => onRename(e.target.value.replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 64))}
            style={{ ...inputRadius, fontFamily: 'var(--font-mono)' }}
          />
        </Field>
        <Field label="Enabled">
          <Switch checked={rule.enabled} onChange={(enabled) => onChange({ enabled })} />
        </Field>
        <Field label="Source">
          <BucketPrefixInput
            value={rule.source}
            onChange={(source) => onChange({ source })}
            buckets={buckets}
            bucketPlaceholder="prod-artifacts"
            prefixPlaceholder="builds/releases/"
          />
        </Field>
        <Field label="Destination">
          <BucketPrefixInput
            value={rule.destination}
            onChange={(destination) => onChange({ destination })}
            buckets={buckets}
            bucketPlaceholder="backup-artifacts"
            prefixPlaceholder="mirror/releases/"
          />
        </Field>
      </div>

      <AdvancedDisclosure title="Advanced rule behavior">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 14 }}>
          <Field label="Interval">
            <Input
              value={rule.interval}
              onChange={(e) => onChange({ interval: e.target.value })}
              style={{ ...inputRadius, fontFamily: 'var(--font-mono)' }}
            />
          </Field>
          <Field label="Batch size">
            <InputNumber
              value={rule.batch_size}
              onChange={(batch_size) => onChange({ batch_size: batch_size || 100 })}
              min={1}
              max={10000}
              style={{ width: '100%', ...inputRadius }}
            />
          </Field>
          <Field label="Conflict policy">
            <Radio.Group
              value={rule.conflict}
              onChange={(e) => onChange({ conflict: e.target.value })}
              style={{ display: 'flex', flexDirection: 'column', gap: 6 }}
            >
              <Radio value="newer-wins">Newer wins — safest default</Radio>
              <Radio value="source-wins">Source wins — overwrite destination</Radio>
              <Radio value="skip-if-dest-exists">Skip existing destination objects</Radio>
            </Radio.Group>
          </Field>
          <Field label="Delete replication">
            <Switch
              checked={rule.replicate_deletes}
              onChange={(replicate_deletes) => onChange({ replicate_deletes })}
            />
            <Alert
              type="warning"
              showIcon
              message="Deletes are destructive"
              description="When enabled, destination objects previously written by this rule are deleted if the corresponding source key disappears. Manually-created destination objects are preserved."
              style={{ marginTop: 8 }}
            />
          </Field>
          <Field label="Include globs">
            <Input.TextArea
              value={lines(rule.include_globs)}
              onChange={(e) => onChange({ include_globs: lineList(e.target.value) })}
              rows={3}
              placeholder={'*.zip\nreleases/**'}
              style={{ ...inputRadius, fontFamily: 'var(--font-mono)' }}
            />
          </Field>
          <Field label="Exclude globs">
            <Input.TextArea
              value={lines(rule.exclude_globs)}
              onChange={(e) => onChange({ exclude_globs: lineList(e.target.value) })}
              rows={3}
              placeholder=".dg/*"
              style={{ ...inputRadius, fontFamily: 'var(--font-mono)' }}
            />
          </Field>
        </div>
      </AdvancedDisclosure>

      <Text type="secondary" style={{ display: 'block', marginTop: 12, fontSize: 11 }}>
        Replication rules target bucket names. Bucket policies decide backend routing and encryption.
      </Text>
    </div>
  );
}
