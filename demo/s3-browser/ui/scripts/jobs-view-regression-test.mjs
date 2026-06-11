import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(new URL('../src/jobsView.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ES2020, target: ts.ScriptTarget.ES2020 },
  fileName: 'jobsView.ts',
});
const moduleUrl = `data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`;
const {
  parseJobId,
  isActiveJobStatus,
  jobStatusTone,
  jobStatusLabel,
  kindLabel,
  triggerLabel,
  availableActions,
  progressLabel,
  busyJobForBucket,
  mergeDraftRules,
} = await import(moduleUrl);

const row = (over = {}) => ({
  id: 'replication:r1',
  kind: 'replication',
  name: 'r1',
  scope: { bucket: 'src' },
  trigger: 'continuous',
  enabled: true,
  paused: false,
  status: 'idle',
  status_raw: 'idle',
  progress: { processed: 0, bytes: 0, failed: 0, skipped: 0 },
  detail: {},
  ...over,
});

// ── parseJobId ──────────────────────────────────────────────────────────────
assert.deepEqual(parseJobId('replication:nightly'), { subsystem: 'replication', key: 'nightly' });
assert.deepEqual(parseJobId('maintenance:42'), { subsystem: 'maintenance', key: '42' });
assert.equal(parseJobId('nocolon'), null);
assert.equal(parseJobId('x:'), null);
assert.equal(parseJobId(':x'), null);

// ── status helpers ──────────────────────────────────────────────────────────
for (const s of ['queued', 'running', 'cancelling']) assert.equal(isActiveJobStatus(s), true, s);
for (const s of ['idle', 'succeeded', 'failed', 'cancelled']) assert.equal(isActiveJobStatus(s), false, s);

assert.equal(jobStatusTone(row({ status: 'running' })), 'processing');
assert.equal(jobStatusTone(row({ status: 'failed' })), 'error');
assert.equal(jobStatusTone(row({ status: 'succeeded' })), 'success');
assert.equal(jobStatusTone(row({ paused: true, status: 'succeeded' })), 'warning', 'paused wins');
assert.equal(jobStatusTone(row({ enabled: false, status: 'failed' })), 'default', 'disabled wins');
assert.equal(jobStatusLabel(row({ paused: true, status: 'idle' })), 'paused');
assert.equal(jobStatusLabel(row({ enabled: false })), 'disabled');

assert.equal(kindLabel('reencrypt'), 'Re-encrypt');
assert.equal(kindLabel('migrate'), 'Migrate');
assert.equal(triggerLabel('oneoff'), 'one-off');

// ── availableActions matrix ─────────────────────────────────────────────────
assert.deepEqual(availableActions(row()), ['pause', 'run-now']);
assert.deepEqual(availableActions(row({ paused: true })), ['resume'], 'paused blocks run-now');
assert.deepEqual(availableActions(row({ status: 'running' })), ['pause'], 'mid-run blocks run-now');
assert.deepEqual(availableActions(row({ enabled: false })), ['pause'], 'disabled blocks run-now');
assert.deepEqual(
  availableActions(row({ kind: 'lifecycle' })),
  ['pause', 'preview', 'run-now']
);
assert.deepEqual(
  availableActions(row({ kind: 'reencrypt', trigger: 'oneoff', status: 'running' })),
  ['cancel']
);
assert.deepEqual(
  availableActions(row({ kind: 'migrate', trigger: 'oneoff', status: 'cancelling' })),
  [],
  'cancelling cannot be re-cancelled'
);
assert.deepEqual(
  availableActions(row({ kind: 'migrate', trigger: 'oneoff', status: 'succeeded' })),
  []
);

// ── progressLabel ───────────────────────────────────────────────────────────
assert.equal(
  progressLabel(row({ trigger: 'oneoff', status: 'queued' })),
  'waiting to start…'
);
assert.equal(
  progressLabel(
    row({ trigger: 'oneoff', status: 'running', phase: 'objects', progress: { processed: 40, skipped: 10, total: 100, bytes: 0, failed: 0 } })
  ),
  '50 / 100 objects'
);
assert.equal(
  progressLabel(row({ trigger: 'oneoff', status: 'running', phase: 'counting' })),
  'counting objects…'
);
assert.equal(progressLabel(row({ lifetime: { objects: 7, bytes: 1 } })), '7 objects lifetime');
assert.equal(progressLabel(row()), '—');

// ── busyJobForBucket ────────────────────────────────────────────────────────
const jobs = [
  row({ id: 'maintenance:1', kind: 'reencrypt', trigger: 'oneoff', status: 'running', scope: { bucket: 'PIPPO' } }),
  row({ id: 'maintenance:2', kind: 'migrate', trigger: 'oneoff', status: 'succeeded', scope: { bucket: 'done' } }),
  row({ id: 'replication:r', status: 'running', scope: { bucket: 'pippo' } }),
];
assert.equal(busyJobForBucket(jobs, 'pippo')?.id, 'maintenance:1', 'case-insensitive, one-offs only');
assert.equal(busyJobForBucket(jobs, 'done'), null, 'terminal one-offs are not busy');

// ── mergeDraftRules ─────────────────────────────────────────────────────────
const server = [
  row({ id: 'replication:keep', name: 'keep' }),
  row({ id: 'replication:gone', name: 'gone' }),
  row({ id: 'lifecycle:lc', kind: 'lifecycle', name: 'lc', trigger: 'scheduled' }),
  row({ id: 'maintenance:9', kind: 'reencrypt', trigger: 'oneoff', name: 'b' }),
];
const merged = mergeDraftRules(server, [{ name: 'keep' }, { name: 'fresh' }], [{ name: 'lc' }]);
const byId = Object.fromEntries(merged.map((d) => [d.row.id, d]));
assert.equal(byId['replication:keep'].pendingDelete, false);
assert.equal(byId['replication:gone'].pendingDelete, true, 'editor-removed rule flagged');
assert.equal(byId['replication:fresh'].draft, true, 'editor-only rule is a draft');
assert.equal(byId['replication:fresh'].row.status, 'idle');
assert.equal(byId['lifecycle:lc'].pendingDelete, false);
assert.equal(byId['maintenance:9'].draft, false, 'one-offs pass through');
assert.equal(byId['maintenance:9'].pendingDelete, false);

console.log('jobs view regression checks passed');
