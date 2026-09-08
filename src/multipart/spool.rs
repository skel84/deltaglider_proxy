// SPDX-License-Identifier: GPL-3.0-only
//! Exclusive local ownership. The lock inode is never unlinked; reclamation
//! happens only after acquisition, before admitting any upload.
use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
use std::{
    fs::{self, File, OpenOptions},
    io,
    path::{Path, PathBuf},
};

pub(super) struct Spool {
    pub root: PathBuf,
    _lock: File,
}

impl Spool {
    /// A reserve for filesystem metadata and unrelated pressure, not permission
    /// to share the private spool directory. Disk-backed emptyDir is permitted
    /// under the operator's shared-node pressure/eviction risk contract; neither
    /// sizeLimit nor this check is a hard filesystem quota. ENOSPC retains cleanup
    /// obligations and never reports success.
    pub fn check_write(&self, bytes: u64) -> io::Result<()> {
        use std::os::unix::ffi::OsStrExt;
        let path = std::ffi::CString::new(self.root.as_os_str().as_bytes())?;
        let mut stats = std::mem::MaybeUninit::<libc::statvfs>::uninit();
        // SAFETY: NUL-terminated path and a valid writable statvfs buffer.
        if unsafe { libc::statvfs(path.as_ptr(), stats.as_mut_ptr()) } != 0 {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: successful statvfs initialized the buffer.
        let stats = unsafe { stats.assume_init() };
        // libc uses different statvfs integer widths across Unix targets.
        #[allow(clippy::unnecessary_cast)]
        let quantum = stats.f_frsize as u64;
        if quantum == 0 || quantum > 64 * 1024 {
            return Err(io::Error::other("unsupported spool allocation quantum"));
        }
        #[allow(clippy::unnecessary_cast)]
        let available = (stats.f_bavail as u64).saturating_mul(quantum);
        if available < bytes.saturating_add(512 * 1024 * 1024) {
            return Err(io::Error::other(
                "multipart spool free-space reserve reached",
            ));
        }
        Ok(())
    }

    pub fn check_allocation(path: &Path, bytes: u64) -> io::Result<()> {
        let allocated = fs::metadata(path)?.blocks().saturating_mul(512);
        if allocated > bytes.saturating_add(320 * 1024) {
            return Err(io::Error::other(
                "unsupported spool file allocation overhead",
            ));
        }
        Ok(())
    }

    pub fn open(root: &Path) -> io::Result<Self> {
        // Operator-provisioned private directory; don't follow a final symlink.
        let meta = fs::symlink_metadata(root)?;
        if !meta.is_dir() || meta.file_type().is_symlink() || meta.permissions().mode() & 0o077 != 0
        {
            return Err(io::Error::other("multipart spool must be a real directory"));
        }
        let root = fs::canonicalize(root)?;
        let lock = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW)
            .open(root.join("owner.lock"))?;
        lock.try_lock()
            .map_err(|_| io::Error::other("multipart spool is already owned"))?;
        let data = root.join("data");
        match fs::symlink_metadata(&data) {
            Ok(meta) if meta.is_dir() && !meta.file_type().is_symlink() => {
                fs::remove_dir_all(&data)?
            }
            Ok(_) => return Err(io::Error::other("invalid multipart spool data directory")),
            Err(e) if e.kind() == io::ErrorKind::NotFound => (),
            Err(e) => return Err(e),
        }
        fs::create_dir(&data)?;
        fs::set_permissions(&data, fs::Permissions::from_mode(0o700))?;
        let spool = Self {
            root: data,
            _lock: lock,
        };
        spool.check_write(0)?;
        Ok(spool)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spool_lock_restart_reclaims_only_after_exclusive_acquisition() {
        let dir = crate::multipart::test_spool_dir();
        let owner = Spool::open(dir.path()).unwrap();
        let live = owner.root.join("live");
        fs::write(&live, b"retained").unwrap();
        assert!(Spool::open(dir.path()).is_err());
        assert_eq!(fs::read(&live).unwrap(), b"retained");
        // A different process, not merely another descriptor in this process.
        let status = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "multipart::spool::tests::spool_child_cannot_reclaim_live_files",
            ])
            .env("DGP_TEST_OWNED_SPOOL", dir.path())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .unwrap();
        assert!(status.success());
        assert!(live.exists());
        drop(owner);
        // Other parallel tests spawn codec processes. On Unix a concurrent
        // fork may briefly inherit the open-file-description lock until exec
        // closes the CLOEXEC descriptor. Keep refusing reclamation while that
        // descriptor exists, and bound how long restart may wait for release.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        let restart = loop {
            match Spool::open(dir.path()) {
                Ok(restart) => break restart,
                Err(error) => {
                    assert_eq!(fs::read(&live).unwrap(), b"retained");
                    assert!(std::time::Instant::now() < deadline, "{error}");
                    std::thread::sleep(std::time::Duration::from_millis(10));
                }
            }
        };
        assert!(!live.exists());
        drop(restart);
    }

    #[test]
    fn spool_child_cannot_reclaim_live_files() {
        if let Some(path) = std::env::var_os("DGP_TEST_OWNED_SPOOL") {
            assert!(Spool::open(Path::new(&path)).is_err());
            assert!(Path::new(&path).join("data/live").exists());
        }
    }
}
