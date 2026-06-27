// SPDX-License-Identifier: GPL-3.0-only

//! Quota'd temp spool space for streaming delta codec ops.
//!
//! The streaming GET path reconstructs a delta to a temp file, then streams that
//! file to the client; the streaming PUT path tees the upload to a passthrough
//! spool. Both can be multi-GB. Without a budget, N concurrent large ops would
//! exhaust `/tmp` (ENOSPC) — the adversarial review flagged this (blocker 7).
//!
//! `SpoolDir` gates spool allocation on a BYTE budget: acquiring space for N
//! bytes takes a weighted permit from a semaphore; the returned `Spool` holds a
//! `NamedTempFile` in the configured directory and releases the permit on drop.
//! When the budget is exhausted, acquirers wait (back-pressure) rather than
//! failing the underlying storage with ENOSPC.
//!
//! Configured via `DGP_SPOOL_DIR` (default = system temp dir) and
//! `DGP_SPOOL_MAX_BYTES` (default 16 GiB).

use std::path::{Path, PathBuf};
use std::sync::Arc;
use tempfile::NamedTempFile;
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

/// A weighted-semaphore-gated pool of temp spool bytes.
#[derive(Clone)]
pub struct SpoolDir {
    dir: PathBuf,
    budget: Arc<Semaphore>,
    max_bytes: u64,
}

/// A reserved spool file. Holds `reserved` bytes of budget until dropped.
pub struct Spool {
    file: NamedTempFile,
    _permit: OwnedSemaphorePermit,
}

impl SpoolDir {
    /// Build from env: `DGP_SPOOL_DIR` (default system temp) + `DGP_SPOOL_MAX_BYTES`
    /// (default 16 GiB). The directory is created if missing.
    pub fn from_env() -> std::io::Result<Self> {
        let dir = std::env::var("DGP_SPOOL_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|_| std::env::temp_dir());
        let max_bytes: u64 =
            crate::config::env_parse_with_default("DGP_SPOOL_MAX_BYTES", 16 * 1024 * 1024 * 1024);
        Self::new(dir, max_bytes)
    }

    pub fn new(dir: PathBuf, max_bytes: u64) -> std::io::Result<Self> {
        std::fs::create_dir_all(&dir)?;
        // Semaphore permits are usize; we account in MiB to stay well under the
        // permit cap (Semaphore::MAX_PERMITS) for terabyte-scale budgets.
        let max_mib = mib_ceil(max_bytes).max(1);
        Ok(Self {
            dir,
            budget: Arc::new(Semaphore::new(max_mib)),
            max_bytes,
        })
    }

    pub fn max_bytes(&self) -> u64 {
        self.max_bytes
    }

    /// Reserve `bytes` of spool budget and create a temp file for it. Awaits if
    /// the budget is currently exhausted (back-pressure). A single request larger
    /// than the whole budget is clamped to the full budget (it runs alone).
    pub async fn acquire(&self, bytes: u64) -> std::io::Result<Spool> {
        let max_mib = mib_ceil(self.max_bytes).max(1) as u32;
        let want_mib = (mib_ceil(bytes).max(1) as u32).min(max_mib);
        let permit = self
            .budget
            .clone()
            .acquire_many_owned(want_mib)
            .await
            .map_err(|_| std::io::Error::other("spool budget semaphore closed"))?;
        let file = NamedTempFile::new_in(&self.dir)?;
        Ok(Spool {
            file,
            _permit: permit,
        })
    }
}

impl Spool {
    pub fn path(&self) -> &Path {
        self.file.path()
    }

    /// Reopen the spool file for reading (e.g. to stream it to a client after
    /// the codec wrote it). The original `NamedTempFile` keeps the file alive
    /// until `Spool` drops.
    pub fn reopen_read(&self) -> std::io::Result<std::fs::File> {
        std::fs::File::open(self.file.path())
    }

    /// A fresh writable handle to the spool file.
    pub fn write_handle(&self) -> std::io::Result<std::fs::File> {
        std::fs::OpenOptions::new()
            .write(true)
            .truncate(true)
            .open(self.file.path())
    }
}

/// Bytes → MiB, rounded up. Budget accounting unit (keeps semaphore permits small).
fn mib_ceil(bytes: u64) -> usize {
    const MIB: u64 = 1024 * 1024;
    bytes.div_ceil(MIB) as usize
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn mib_ceil_rounds_up() {
        assert_eq!(mib_ceil(0), 0);
        assert_eq!(mib_ceil(1), 1);
        assert_eq!(mib_ceil(1024 * 1024), 1);
        assert_eq!(mib_ceil(1024 * 1024 + 1), 2);
    }

    #[tokio::test]
    async fn acquire_creates_a_writable_file_in_dir() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = SpoolDir::new(tmp.path().to_path_buf(), 64 * 1024 * 1024).unwrap();
        let spool = pool.acquire(4 * 1024 * 1024).await.unwrap();
        assert!(spool.path().starts_with(tmp.path()));
        let mut w = spool.write_handle().unwrap();
        w.write_all(b"hello").unwrap();
        w.flush().unwrap();
        let back = std::fs::read(spool.path()).unwrap();
        assert_eq!(&back, b"hello");
    }

    #[tokio::test]
    async fn budget_blocks_until_released() {
        // Budget = 4 MiB. Two 4 MiB reservations can't coexist; the second
        // must wait until the first drops.
        let tmp = tempfile::tempdir().unwrap();
        let pool = SpoolDir::new(tmp.path().to_path_buf(), 4 * 1024 * 1024).unwrap();
        let first = pool.acquire(4 * 1024 * 1024).await.unwrap();

        let pool2 = pool.clone();
        let waiter = tokio::spawn(async move { pool2.acquire(4 * 1024 * 1024).await.map(|_| ()) });

        // The waiter can't complete while `first` holds the whole budget.
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        assert!(
            !waiter.is_finished(),
            "second acquire should block on budget"
        );

        drop(first); // release budget
                     // Now it proceeds.
        tokio::time::timeout(std::time::Duration::from_secs(2), waiter)
            .await
            .expect("waiter should finish once budget freed")
            .unwrap()
            .unwrap();
    }

    #[tokio::test]
    async fn oversized_request_clamps_to_full_budget() {
        // A request larger than the whole budget runs alone (clamped), not deadlocks.
        let tmp = tempfile::tempdir().unwrap();
        let pool = SpoolDir::new(tmp.path().to_path_buf(), 4 * 1024 * 1024).unwrap();
        let spool = pool.acquire(64 * 1024 * 1024).await.unwrap(); // > budget
        assert!(spool.path().exists());
    }
}
