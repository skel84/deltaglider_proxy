/**
 * MigrateBucketModal — move an existing bucket's objects to a different
 * backend, then re-route it there. This is the honest version of changing a
 * bucket's backend: it copies the data first (re-routing alone orphans it).
 *
 * Self-contained imperative action (not part of the policy-draft editor):
 * picks a target backend, optional source cleanup, confirms, and calls the
 * `migrateBucket` admin endpoint. On success it invalidates the backend
 * origin/list caches so counts and chips refresh.
 */
import { useState } from 'react';
import { Modal, Select, Checkbox, Typography, Alert, message } from 'antd';
import { useQueryClient } from '@tanstack/react-query';
import { migrateBucket } from '../adminApi';
import type { BackendInfo } from '../adminApi';
import { qk } from '../queries/keys';

const { Text } = Typography;

interface Props {
  open: boolean;
  bucket: string;
  /** The bucket's current backend (so we can exclude it from the target list). */
  currentBackend: string | null;
  backends: BackendInfo[];
  onClose: () => void;
  onMigrated?: () => void;
}

export default function MigrateBucketModal({
  open,
  bucket,
  currentBackend,
  backends,
  onClose,
  onMigrated,
}: Props) {
  const qc = useQueryClient();
  const [target, setTarget] = useState<string | undefined>(undefined);
  const [deleteSource, setDeleteSource] = useState(false);
  const [migrating, setMigrating] = useState(false);
  const [messageApi, contextHolder] = message.useMessage();

  const targets = backends.filter((b) => b.name !== currentBackend);

  const reset = () => {
    setTarget(undefined);
    setDeleteSource(false);
  };

  const handleMigrate = async () => {
    if (!target) return;
    setMigrating(true);
    try {
      const result = await migrateBucket(bucket, target, deleteSource);
      messageApi.success(
        `Migrated ${bucket} to ${target}: ${result.objects_copied} object(s) copied` +
          (result.source_deleted ? ', source deleted' : ''),
      );
      qc.invalidateQueries({ queryKey: qk.backends.origins() });
      qc.invalidateQueries({ queryKey: qk.backends.list() });
      reset();
      onClose();
      onMigrated?.();
    } catch (e) {
      messageApi.error(e instanceof Error ? e.message : 'Migration failed');
    } finally {
      setMigrating(false);
    }
  };

  return (
    <>
      {contextHolder}
      <Modal
        title={`Migrate “${bucket}” to another backend`}
        open={open}
        okText="Migrate"
        onOk={handleMigrate}
        confirmLoading={migrating}
        okButtonProps={{ disabled: !target }}
        onCancel={() => {
          if (migrating) return;
          reset();
          onClose();
        }}
        destroyOnHidden
      >
        <Text type="secondary" style={{ display: 'block', marginBottom: 12 }}>
          Copies every object to the target backend, verifies, then re-routes the
          bucket. The bucket stays readable throughout. {currentBackend ? (
            <>Currently on <Text code>{currentBackend}</Text>.</>
          ) : null}
        </Text>
        <Select
          value={target}
          onChange={(v) => setTarget(v || undefined)}
          placeholder="Target backend"
          style={{ width: '100%' }}
          options={targets.map((b) => ({ value: b.name, label: b.name, sublabel: b.backend_type }))}
          optionRender={(opt) => (
            <div>
              <div>{opt.data.label}</div>
              {opt.data.sublabel && (
                <div style={{ fontSize: 11, opacity: 0.65 }}>{opt.data.sublabel}</div>
              )}
            </div>
          )}
          showSearch
          optionFilterProp="label"
        />
        <Checkbox
          checked={deleteSource}
          onChange={(e) => setDeleteSource(e.target.checked)}
          style={{ marginTop: 12 }}
        >
          Delete the source copy after a verified migration
        </Checkbox>
        {deleteSource && (
          <Alert
            type="warning"
            showIcon
            style={{ marginTop: 8 }}
            message="Source objects on the current backend will be deleted once the copy is verified. Leave unchecked to keep them as a backup."
          />
        )}
      </Modal>
    </>
  );
}
