import {
  DashboardOutlined,
  ExperimentOutlined,
  FileTextOutlined,
  DownloadOutlined,
  SecurityScanOutlined,
  TeamOutlined,
  SafetyOutlined,
  FolderOutlined,
  DatabaseOutlined,
  CloudServerOutlined,
  CloudOutlined,
  ClockCircleOutlined,
  LockOutlined,
  SettingOutlined,
  ThunderboltOutlined,
  SyncOutlined,
} from '@ant-design/icons';
import type { ReactNode } from 'react';
import type { SectionName } from '../adminApi';

export interface SidebarEntry {
  /** Path sub-segment: `diagnostics/dashboard`, `configuration/admission/...` */
  path: string;
  /** Plain-English label shown in the nav. */
  label: string;
  /** Icon rendered to the left of the label. */
  icon: ReactNode;
  /**
   * Which configuration section this entry's content maps to — used
   * to drive the dirty-state amber dot. Diagnostics entries have no
   * section.
   */
  section?: SectionName;
  /** Child entries rendered below as a sub-nav. */
  children?: SidebarEntry[];
}

/**
 * The four-group IA. Exported so AdminPage/CommandPalette can walk the
 * tree to pick the right header title + derive quick navigation.
 */
export const ADMIN_IA: Array<{ group: string; entries: SidebarEntry[] }> = [
  {
    group: 'Diagnostics',
    entries: [
      {
        path: 'diagnostics/dashboard',
        label: 'Dashboard',
        icon: <DashboardOutlined />,
      },
      {
        path: 'diagnostics/trace',
        label: 'Trace',
        icon: <ExperimentOutlined />,
      },
      {
        // Wave 11: in-memory audit log viewer. Read-only; backs
        // onto the server-side ring buffer in src/audit.rs.
        path: 'diagnostics/audit',
        label: 'Audit log',
        icon: <FileTextOutlined />,
      },
      {
        // v0.9.18: per-deltaspace efficiency report. Backs onto
        // the GET /_/api/admin/diagnostics/delta-efficiency
        // endpoint. Surfaces prefixes whose reference baseline
        // produces too-large deltas (the v0.9.17 1.70.0-pre5
        // incident shape).
        path: 'diagnostics/delta-efficiency',
        label: 'Delta efficiency',
        icon: <ThunderboltOutlined />,
      },
      {
        path: 'diagnostics/event-outbox',
        label: 'Event outbox',
        icon: <DatabaseOutlined />,
      },
    ],
  },
  {
    group: 'Configuration',
    entries: [
      {
        path: 'configuration/admission',
        label: 'Admission',
        icon: <SecurityScanOutlined />,
        section: 'admission',
      },
      {
        path: 'configuration/access',
        label: 'Access',
        icon: <TeamOutlined />,
        section: 'access',
        children: [
          {
            path: 'configuration/access/credentials',
            label: 'Credentials & mode',
            icon: <LockOutlined />,
            section: 'access',
          },
          {
            path: 'configuration/access/users',
            label: 'Users',
            icon: <TeamOutlined />,
            section: 'access',
          },
          {
            path: 'configuration/access/groups',
            label: 'Groups',
            icon: <FolderOutlined />,
            section: 'access',
          },
          {
            path: 'configuration/access/ext-auth',
            label: 'External authentication',
            icon: <SafetyOutlined />,
            section: 'access',
          },
        ],
      },
      {
        path: 'configuration/storage',
        label: 'Storage',
        icon: <CloudServerOutlined />,
        section: 'storage',
        children: [
          {
            path: 'configuration/storage/backends',
            label: 'Backends',
            icon: <DatabaseOutlined />,
            section: 'storage',
          },
          {
            path: 'configuration/storage/buckets',
            label: 'Buckets',
            icon: <CloudOutlined />,
            section: 'storage',
          },
          {
            path: 'configuration/storage/replication',
            label: 'Object replication',
            icon: <SyncOutlined />,
            section: 'storage',
          },
          {
            path: 'configuration/storage/lifecycle',
            label: 'Object lifecycle',
            icon: <ClockCircleOutlined />,
            section: 'storage',
          },
          // Encryption-at-rest config — per-backend as of v0.9. Lives
          // inside the Backends panel (one subsection per backend
          // card); no longer a top-level sidebar entry.
        ],
      },
      {
        path: 'configuration/recovery',
        label: 'Backup',
        icon: <DownloadOutlined />,
      },
      {
        path: 'configuration/advanced',
        label: 'Advanced',
        icon: <SettingOutlined />,
        section: 'advanced',
        children: [
          {
            path: 'configuration/advanced/listener',
            label: 'Listener & TLS',
            icon: <CloudServerOutlined />,
            section: 'advanced',
          },
          {
            path: 'configuration/advanced/caches',
            label: 'Caches',
            icon: <DatabaseOutlined />,
            section: 'advanced',
          },
          {
            path: 'configuration/advanced/limits',
            label: 'Limits',
            icon: <CloudOutlined />,
            section: 'advanced',
          },
          {
            path: 'configuration/advanced/logging',
            label: 'Logging',
            icon: <DatabaseOutlined />,
            section: 'advanced',
          },
          {
            path: 'configuration/advanced/sync',
            label: 'Config DB sync',
            icon: <SyncOutlined />,
            section: 'advanced',
          },
        ],
      },
    ],
  },
];
