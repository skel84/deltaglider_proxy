import { Alert, Input, InputNumber, Switch, Tag, Typography } from 'antd';
import type {
  LifecycleRuleConfig,
  LifecycleRuleOverview,
} from '../adminApi';
import BucketPrefixInput from './BucketPrefixInput';
import { AdvancedDisclosure, Field } from './ruleEditorFields';
import { fmtUnix, lineList, lines } from './ruleEditorHelpers';
import SimpleSelect from './SimpleSelect';
import { actionKind } from './lifecyclePayload';
import { statusTone } from './lifecycleHelpers';

const { Text } = Typography;

/**
 * Per-rule field editor body for the Lifecycle panel. Passed as the
 * `renderDetail` content to RuleListEditor by the parent LifecyclePanel.
 */
export default function RuleEditor({
  rule,
  runtime,
  buckets,
  inputRadius,
  onChange,
  onRename,
}: {
  rule: LifecycleRuleConfig;
  runtime: LifecycleRuleOverview | null;
  buckets: string[];
  inputRadius: { borderRadius: number };
  onChange: (patch: Partial<LifecycleRuleConfig>) => void;
  onRename: (nextName: string) => void;
}) {
  const transitionAction =
    actionKind(rule.action) === 'transition' && typeof rule.action === 'object'
      ? rule.action
      : null;
  const updateTransition = (
    patch: Partial<Exclude<LifecycleRuleConfig['action'], 'delete' | undefined>>
  ) => {
    const current = transitionAction || {
      type: 'transition' as const,
      destination: { bucket: '', prefix: 'archive/' },
      delete_source_after_success: false,
    };
    onChange({ action: { ...current, ...patch } });
  };

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'flex-start' }}>
        <div>
          <Text strong style={{ fontSize: 16 }}>{rule.name}</Text>
          <Text type="secondary" style={{ display: 'block', fontSize: 12, marginTop: 2 }}>
            Last run: {fmtUnix(runtime?.last_run_at)} · Next due: {fmtUnix(runtime?.next_due_at)}
          </Text>
        </div>
        <Tag color={statusTone(runtime?.last_status || 'idle', rule.enabled)}>
          {rule.enabled ? runtime?.last_status || 'idle' : 'disabled'}
        </Tag>
      </div>

      <Alert
        type="warning"
        showIcon
        message="Lifecycle actions"
        description="Delete removes expired candidates. Archive/move copies through the same DeltaGlider engine path as replication, then optionally deletes the source after the copy verifies."
        style={{ marginTop: 14 }}
      />

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
          <Text type="secondary" style={{ display: 'block', fontSize: 11, marginTop: 4 }}>
            Per-rule delete switch. Global scheduler must also be enabled.
          </Text>
        </Field>
        <Field label="Scope">
          <BucketPrefixInput
            value={{ bucket: rule.bucket, prefix: rule.prefix }}
            onChange={(scope) => onChange({ bucket: scope.bucket, prefix: scope.prefix })}
            buckets={buckets}
            bucketPlaceholder="prod-artifacts"
            prefixPlaceholder="builds/releases/"
          />
        </Field>
        <Field label="Expire after">
          <Input
            value={rule.expire_after}
            onChange={(e) => onChange({ expire_after: e.target.value })}
            placeholder="30d"
            style={{ ...inputRadius, fontFamily: 'var(--font-mono)' }}
          />
          <Text type="secondary" style={{ display: 'block', fontSize: 11, marginTop: 4 }}>
            Humantime duration, e.g. <Text code>30d</Text>, <Text code>12h</Text>, <Text code>90d</Text>.
          </Text>
        </Field>
        <Field label="Action">
          <SimpleSelect
            value={actionKind(rule.action)}
            onChange={(value) => {
              if (value === 'transition') {
                onChange({
                  action: {
                    type: 'transition',
                    destination: { bucket: '', prefix: 'archive/' },
                    delete_source_after_success: false,
                  },
                });
              } else {
                onChange({ action: 'delete' });
              }
            }}
            options={[
              { value: 'delete', label: 'Delete', sublabel: 'Expire source objects' },
              { value: 'transition', label: 'Archive / move', sublabel: 'Copy first, optional source delete' },
            ]}
            style={{ width: '100%', ...inputRadius }}
          />
        </Field>
      </div>

      {transitionAction && (
        <div style={{ marginTop: 14, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 14 }}>
          <Field label="Destination">
            <BucketPrefixInput
              value={{
                bucket: transitionAction.destination?.bucket || '',
                prefix: transitionAction.destination?.prefix || '',
              }}
              onChange={(destination) => updateTransition({ destination })}
              buckets={buckets}
              bucketPlaceholder="archive-artifacts"
              prefixPlaceholder="archive/releases/"
            />
          </Field>
          <Field label="Delete source after copy">
            <Switch
              checked={Boolean(transitionAction.delete_source_after_success)}
              onChange={(checked) => updateTransition({ delete_source_after_success: checked })}
            />
            <Text type="secondary" style={{ display: 'block', fontSize: 11, marginTop: 4 }}>
              Off archives by copying only. On makes it a move, but source delete only happens after verified copy success.
            </Text>
          </Field>
        </div>
      )}

      <AdvancedDisclosure title="Filters and batch size">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 14 }}>
          <Field label="Include globs">
            <Input.TextArea
              value={lines(rule.include_globs)}
              onChange={(e) => onChange({ include_globs: lineList(e.target.value) })}
              rows={3}
              placeholder={'*.zip\nreleases/**'}
              style={{ ...inputRadius, fontFamily: 'var(--font-mono)' }}
            />
            <Text type="secondary" style={{ display: 'block', fontSize: 11, marginTop: 4 }}>
              Empty means include every key under the prefix.
            </Text>
          </Field>
          <Field label="Exclude globs">
            <Input.TextArea
              value={lines(rule.exclude_globs)}
              onChange={(e) => onChange({ exclude_globs: lineList(e.target.value) })}
              rows={3}
              placeholder=".deltaglider/**"
              style={{ ...inputRadius, fontFamily: 'var(--font-mono)' }}
            />
          </Field>
          <Field label="Batch size">
            <InputNumber
              value={rule.batch_size}
              onChange={(batch_size) => onChange({ batch_size: Number(batch_size) || 100 })}
              min={1}
              max={10000}
              style={{ width: '100%', ...inputRadius }}
            />
            <Text type="secondary" style={{ display: 'block', fontSize: 11, marginTop: 4 }}>
              Worker/listing page size. Default: <Text code>100</Text>.
            </Text>
          </Field>
        </div>
      </AdvancedDisclosure>
    </div>
  );
}
