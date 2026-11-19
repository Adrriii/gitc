use super::git::{git_bytes, git_or_none};
use super::paths::{config_dir, in_repo, safe_argument};
use super::types::DiffTarget;

/// The largest file previewed, in bytes.
pub const MAX_MEDIA_BYTES: u64 = 64 * 1024 * 1024;

const AVATAR_EXTS: [&str; 6] = ["png", "jpg", "jpeg", "svg", "gif", "webp"];

/// One side ("old" or "new") of a file, for previewing an image or video.
/// `old_path` is the file's name before a rename and only the old side reads it.
pub fn read_media(repo: &str, target: &DiffTarget, path: &str, old_path: &str, side: &str) -> Result<Vec<u8>, String> {
    if side != "old" && side != "new" {
        return Err("no such side".into());
    }
    let old = side == "old";
    let file = if old && !old_path.is_empty() { old_path } else { path };
    let full = in_repo(repo, file).ok_or("not a path in this repository")?;

    let Some(rev) = revision_for(target, old)? else {
        let meta = std::fs::metadata(&full).map_err(|_| "not in the working tree")?;
        if !meta.is_file() {
            return Err("not a file".into());
        }
        if meta.len() > MAX_MEDIA_BYTES {
            return Err("too large to preview".into());
        }
        return std::fs::read(&full).map_err(|e| format!("cannot read {file}: {e}"));
    };

    let spec = format!("{rev}:{}", file.replace('\\', "/"));
    let size = git_or_none(repo, &["cat-file", "-s", &spec]).ok_or("not in that revision")?;
    if size.trim().parse::<u64>().unwrap_or(u64::MAX) > MAX_MEDIA_BYTES {
        return Err("too large to preview".into());
    }
    git_bytes(repo, &["cat-file", "blob", &spec]).ok_or_else(|| "not in that revision".into())
}

/// The user's own picture for an email, from `<config>/avatars/<sanitised email>.<ext>`.
pub fn avatar_override(email: &str) -> Option<Vec<u8>> {
    let lower = email.trim().to_lowercase();
    let safe: String = lower
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || matches!(c, '.' | '@' | '+' | '_' | '-') { c } else { '_' })
        .collect();
    if safe.is_empty() || safe == "." || safe == ".." {
        return None;
    }
    let dir = config_dir().join("avatars");
    AVATAR_EXTS.iter().find_map(|ext| std::fs::read(dir.join(format!("{safe}.{ext}"))).ok())
}

/// The git object name for one side, Some("") for the index, None for the working tree.
fn revision_for(target: &DiffTarget, old: bool) -> Result<Option<String>, String> {
    Ok(match target {
        DiffTarget::Wip { staged: false, .. } => old.then(String::new),
        DiffTarget::Wip { staged: true, .. } => Some(if old { "HEAD".into() } else { String::new() }),
        DiffTarget::Range { from, to } => Some(if old {
            format!("{}^", safe_argument(from, "commit")?)
        } else {
            safe_argument(to, "commit")?.to_string()
        }),
        DiffTarget::Commit { sha } => {
            let sha = safe_argument(sha, "commit")?;
            Some(if old { format!("{sha}^") } else { sha.to_string() })
        }
    })
}
