/**
 * System — ONE page for the platform/runtime knobs that used to be five
 * separate Advanced screens plus Backup: Listener & TLS, Caches, runtime
 * Limits (read-only env vars), Logging, Config DB sync, and Backup.
 *
 * Each card keeps its OWN section editor (independent dirty key + apply
 * dialog — the sidebar dot lights when any of them is dirty). The dirty
 * bars render INLINE inside their card so several can be visible at once
 * without overlapping.
 */
import {
  CachesPanel,
  ConfigDbSyncPanel,
  LimitsPanel,
  ListenerTlsPanel,
  LoggingPanel,
} from './advancedPanels';
import RecoveryPanel from './RecoveryPanel';

interface Props {
  onSessionExpired?: () => void;
  onExportBackup: () => void;
  onImportBackup: () => void;
}

export default function SystemPanel({ onSessionExpired, onExportBackup, onImportBackup }: Props) {
  return (
    <div>
      <ListenerTlsPanel onSessionExpired={onSessionExpired} />
      <CachesPanel onSessionExpired={onSessionExpired} />
      <LimitsPanel onSessionExpired={onSessionExpired} />
      <LoggingPanel onSessionExpired={onSessionExpired} />
      <ConfigDbSyncPanel onSessionExpired={onSessionExpired} />
      <RecoveryPanel onExportBackup={onExportBackup} onImportBackup={onImportBackup} />
    </div>
  );
}
