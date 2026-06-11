/**
 * Post-encryption-change proposal: offer the one-off "re-encrypt existing
 * objects" maintenance job for the buckets on the changed backend.
 *
 * Shown by BackendsPanel right after a successful encryption apply
 * (enable / rotate / disable). The job itself is uniform — "rewrite every
 * object whose at-rest state doesn't match the new config" — so the same
 * modal serves all three transitions; only the copy changes.
 *
 * Also reusable as the manual "[Later]" path from the Buckets page
 * (single-bucket preset).
 */
import { useEffect, useState } from 'react';
import { Alert, Button, Checkbox, Modal, Typography, message } from 'antd';
import { useQueryClient } from '@tanstack/react-query';
import { SyncOutlined } from '@ant-design/icons';
import { startReencrypt } from '../adminApi';
import { qk } from '../queries/keys';
import { useColors } from '../ThemeContext';

const { Text } = Typography;

export type ReencryptTransition = 'encrypt' | 'rotate' | 'decrypt';

interface Props {
  open: boolean;
  transition: ReencryptTransition;
  /** Buckets eligible for the job (the changed backend's buckets). */
  buckets: string[];
  /** Context line, e.g. the backend name. */
  backendName: string;
  onClose: () => void;
}

const TITLES: Record<ReencryptTransition, string> = {
  encrypt: 'Encrypt existing objects?',
  rotate: 'Re-encrypt existing objects with the new key?',
  decrypt: 'Decrypt existing objects?',
};

const EXPLAIN: Record<ReencryptTransition, string> = {
  encrypt:
    'Encryption applies to NEW writes only. Objects already stored on this backend are still plaintext on disk until rewritten.',
  rotate:
    'The new key applies to NEW writes only. Existing objects remain encrypted under the previous key until rewritten.',
  decrypt:
    'Disabling encryption affects NEW writes only. Existing objects remain encrypted on disk until rewritten (readable only while the legacy key shim is configured).',
};

export default function ReencryptProposalModal({
  open,
  transition,
  buckets,
  backendName,
  onClose,
}: Props) {
  const colors = useColors();
  const qc = useQueryClient();
  const [selected, setSelected] = useState<string[]>(buckets);
  const [starting, setStarting] = useState(false);
  const [messageApi, msgCtx] = message.useMessage();

  useEffect(() => {
    if (open) setSelected(buckets);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, buckets.join('|')]);

  const handleStart = async () => {
    if (selected.length === 0) return;
    setStarting(true);
    try {
      const res = await startReencrypt(selected);
      if (res.started.length > 0) {
        messageApi.success(
          `Started for ${res.started.map((s) => s.bucket).join(', ')} — track progress on the Buckets page`
        );
      }
      for (const e of res.errors) {
        messageApi.error(`${e.bucket}: ${e.error}`);
      }
      qc.invalidateQueries({ queryKey: qk.maintenance.list() });
      if (res.errors.length === 0) onClose();
    } catch (e) {
      messageApi.error(e instanceof Error ? e.message : 'Failed to start');
    } finally {
      setStarting(false);
    }
  };

  return (
    <Modal
      open={open}
      onCancel={onClose}
      title={
        <span>
          <SyncOutlined style={{ marginRight: 8, color: colors.ACCENT_BLUE }} />
          {TITLES[transition]}
        </span>
      }
      footer={[
        <Button key="later" onClick={onClose}>
          Later
        </Button>,
        <Button
          key="start"
          type="primary"
          loading={starting}
          disabled={selected.length === 0}
          onClick={handleStart}
        >
          Start now ({selected.length} bucket{selected.length === 1 ? '' : 's'})
        </Button>,
      ]}
    >
      {msgCtx}
      <Text type="secondary" style={{ fontSize: 13, display: 'block', marginBottom: 12 }}>
        {EXPLAIN[transition]} A one-off background job can rewrite them now so everything on{' '}
        <Text code>{backendName}</Text> matches the new setting. Already-matching objects are
        skipped, and the job resumes automatically if the proxy restarts.
      </Text>
      <Alert
        type="warning"
        showIcon
        style={{ marginBottom: 12, borderRadius: 8 }}
        message="While a bucket is being processed"
        description={
          <span style={{ fontSize: 12 }}>
            Reads keep working; <strong>uploads and deletes get a temporary 503</strong> (S3
            clients retry automatically). Rewritten objects get a new Last-Modified timestamp —
            sync tools may re-download them.
          </span>
        }
      />
      {buckets.length === 0 ? (
        <Text type="secondary">No buckets currently store data on this backend.</Text>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {buckets.map((b) => (
            <Checkbox
              key={b}
              checked={selected.includes(b)}
              onChange={(e) =>
                setSelected((cur) =>
                  e.target.checked ? [...cur, b] : cur.filter((x) => x !== b)
                )
              }
            >
              <Text code style={{ fontSize: 13 }}>
                {b}
              </Text>
            </Checkbox>
          ))}
        </div>
      )}
    </Modal>
  );
}
