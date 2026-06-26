/**
 * Unified jobs queries. The list polls fast (2s) while anything is live
 * — a running one-off or a running rule — and goes quiet otherwise.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  getJobFailures,
  getJobRuns,
  getJobs,
  runJobAction,
  verifyReplicationParity,
} from '../adminApi';
import type { ParityOutcome } from '../adminApi';
import { isActiveJobStatus } from '../jobsView';
import { qk } from './keys';

const POLL_MS = 2000;

export function useJobs(opts?: { enabled?: boolean }) {
  return useQuery({
    queryKey: qk.jobs.list(),
    queryFn: getJobs,
    enabled: opts?.enabled ?? true,
    refetchInterval: (query) => {
      const jobs = query.state.data?.jobs ?? [];
      return jobs.some((j) => isActiveJobStatus(j.status)) ? POLL_MS : false;
    },
  });
}

export function useJobRuns(id: string | null) {
  return useQuery({
    queryKey: qk.jobs.runs(id ?? ''),
    queryFn: () => getJobRuns(id as string),
    enabled: !!id,
  });
}

export function useJobFailures(id: string | null) {
  return useQuery({
    queryKey: qk.jobs.failures(id ?? ''),
    queryFn: () => getJobFailures(id as string),
    enabled: !!id,
  });
}

/**
 * On-demand parity verification for a replication rule. A mutation, NOT a
 * query: it never runs on mount, never polls — the user clicks "Run
 * verification" and we surface isPending / data / error.
 */
export function useVerifyParity() {
  return useMutation<ParityOutcome, Error, string>({
    mutationFn: (ruleName: string) => verifyReplicationParity(ruleName),
  });
}

/**
 * Run a replication rule now — the ONLY executable per-finding fix in the
 * Verify tab (re-uses the shared run-now action; everything else is guidance).
 * Invalidates the jobs list so the row's status reflects the run.
 */
export function useRunReplicationNow() {
  const qc = useQueryClient();
  return useMutation<unknown, Error, string>({
    mutationFn: (ruleName: string) =>
      runJobAction(`replication:${ruleName}`, 'run-now'),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.jobs.list() });
    },
  });
}
