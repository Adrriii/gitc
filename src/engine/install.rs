use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use super::git::hide_console;

#[cfg(windows)]
const ICO: &[u8] = include_bytes!("../../icons/gitc.ico");

#[cfg(not(windows))]
const PNGS: [(u32, &[u8]); 7] = [
    (16, include_bytes!("../../icons/gitc-16.png")),
    (24, include_bytes!("../../icons/gitc-24.png")),
    (32, include_bytes!("../../icons/gitc-32.png")),
    (48, include_bytes!("../../icons/gitc-48.png")),
    (64, include_bytes!("../../icons/gitc-64.png")),
    (128, include_bytes!("../../icons/gitc-128.png")),
    (256, include_bytes!("../../icons/gitc-256.png")),
];

pub struct InstallReport {
    pub lines: Vec<String>,
    pub target: PathBuf,
}

pub fn install_dir() -> PathBuf {
    if cfg!(windows) {
        let base = env_path("LOCALAPPDATA").unwrap_or_else(|| home().join("AppData").join("Local"));
        return base.join("Programs").join("gitc");
    }
    home().join(".local").join("bin")
}

pub fn installed_binary() -> PathBuf {
    install_dir().join(if cfg!(windows) { "gitc.exe" } else { "gitc" })
}

pub fn running_from_install() -> bool {
    current_exe().is_some_and(|exe| same_path(&exe, &installed_binary()))
}

/// Copies the running binary into place and registers it with the desktop and PATH.
pub fn install() -> InstallReport {
    let dir = install_dir();
    let target = installed_binary();
    let mut lines = vec![format!("{} {}", crate::NAME, crate::VERSION)];
    if let Err(e) = std::fs::create_dir_all(&dir) {
        lines.push(format!("  binary    cannot create {}: {e}", dir.display()));
        return InstallReport { lines, target };
    }

    let Some(exe) = current_exe() else {
        lines.push("  binary    cannot tell where this binary is".into());
        return InstallReport { lines, target };
    };
    if !same_path(&exe, &target) {
        if std::fs::copy(&exe, &target).is_err() {
            lines.push("  binary    already in use, kept the installed copy".into());
            return InstallReport { lines, target };
        }
        make_executable(&target);
    }
    lines.push(format!("  binary    {}", target.display()));

    desktop_entry(&target, &mut lines);

    if path_contains(&dir) {
        lines.push("  path      already on PATH".into());
    } else if cfg!(windows) {
        if add_to_windows_path(&dir) {
            lines.push("  path      added for your user - open a new terminal to pick it up".into());
        }
    } else {
        lines.push(format!("  path      {} is not on PATH - add it to run `gitc` by name:", dir.display()));
        lines.push(format!("              export PATH=\"{}:$PATH\"", dir.display()));
    }
    InstallReport { lines, target }
}

/// Removes everything `install` created, leaving settings and repositories alone.
pub fn uninstall() -> Vec<String> {
    let mut lines = Vec::new();
    let dir = install_dir();
    let target = installed_binary();
    if target.exists() {
        if running_from_install() {
            lines.push(format!("  binary    still running - delete it yourself: {}", target.display()));
        } else if std::fs::remove_file(&target).is_ok() {
            lines.push(format!("  binary    removed {}", target.display()));
        }
    }
    remove_desktop_entry(&mut lines);
    if cfg!(windows) && remove_from_windows_path(&dir) {
        lines.push("  path      removed from your PATH".into());
    }
    lines.push("  settings  kept in your config directory - delete it by hand if you want it gone".into());
    lines
}

#[cfg(windows)]
fn desktop_entry(target: &Path, lines: &mut Vec<String>) {
    let ico = install_dir().join("gitc.ico");
    if std::fs::write(&ico, ICO).is_ok() {
        lines.push(format!("  icon      {}", ico.display()));
    }
    let Some(link) = start_menu_link() else { return };
    let work = target.parent().unwrap_or(target);
    let script = format!(
        "$s=(New-Object -ComObject WScript.Shell).CreateShortcut({}); $s.TargetPath={}; $s.IconLocation={}; \
         $s.Description='A fast, minimal git client'; $s.WorkingDirectory={}; $s.Save()",
        ps_quote(&link),
        ps_quote(target),
        ps_quote(&PathBuf::from(format!("{},0", ico.display()))),
        ps_quote(work),
    );
    if powershell(&script) {
        lines.push("  shortcut  Start Menu".into());
    }
}

#[cfg(not(windows))]
fn desktop_entry(target: &Path, lines: &mut Vec<String>) {
    let share = data_home();
    let icons = share.join("icons").join("hicolor");
    for (size, png) in PNGS {
        let dir = icons.join(format!("{size}x{size}")).join("apps");
        if std::fs::create_dir_all(&dir).is_ok() {
            let _ = std::fs::write(dir.join("gitc.png"), png);
        }
    }
    lines.push(format!("  icons     {}", icons.display()));

    let apps = share.join("applications");
    let desktop = [
        "[Desktop Entry]",
        "Type=Application",
        "Name=gitc",
        "GenericName=Git Client",
        "Comment=A fast, minimal git client",
        &format!("Exec={} %f", target.display()),
        "Icon=gitc",
        "Terminal=false",
        "Categories=Development;RevisionControl;",
        "Keywords=git;vcs;version control;",
        "StartupNotify=true",
        "StartupWMClass=gitc",
        "",
    ]
    .join("\n");
    if std::fs::create_dir_all(&apps).is_ok() && std::fs::write(apps.join("gitc.desktop"), desktop).is_ok() {
        lines.push(format!("  desktop   {}", apps.join("gitc.desktop").display()));
    }
    quiet(Command::new("update-desktop-database").arg(&apps));
    quiet(Command::new("gtk-update-icon-cache").arg("-f").arg("-t").arg(&icons));
}

#[cfg(windows)]
fn remove_desktop_entry(lines: &mut Vec<String>) {
    let _ = std::fs::remove_file(install_dir().join("gitc.ico"));
    if let Some(link) = start_menu_link() {
        if std::fs::remove_file(link).is_ok() {
            lines.push("  shortcut  removed".into());
        }
    }
}

#[cfg(not(windows))]
fn remove_desktop_entry(lines: &mut Vec<String>) {
    let share = data_home();
    if std::fs::remove_file(share.join("applications").join("gitc.desktop")).is_ok() {
        lines.push("  desktop   removed".into());
    }
    for (size, _) in PNGS {
        let _ = std::fs::remove_file(share.join("icons/hicolor").join(format!("{size}x{size}")).join("apps/gitc.png"));
    }
    lines.push("  icons     removed".into());
}

#[cfg(windows)]
fn start_menu_link() -> Option<PathBuf> {
    Some(env_path("APPDATA")?.join("Microsoft").join("Windows").join("Start Menu").join("Programs").join("gitc.lnk"))
}

#[cfg(not(windows))]
fn data_home() -> PathBuf {
    env_path("XDG_DATA_HOME").unwrap_or_else(|| home().join(".local").join("share"))
}

fn add_to_windows_path(dir: &Path) -> bool {
    powershell(&format!(
        "$d={}; $p=[Environment]::GetEnvironmentVariable('PATH','User'); \
         if ($p -split ';' -notcontains $d) {{ [Environment]::SetEnvironmentVariable('PATH', ($p.TrimEnd(';') + ';' + $d), 'User') }}",
        ps_quote(dir)
    ))
}

fn remove_from_windows_path(dir: &Path) -> bool {
    powershell(&format!(
        "$d={}; $p=[Environment]::GetEnvironmentVariable('PATH','User'); \
         $kept=($p -split ';' | Where-Object {{ $_ -and $_ -ne $d }}) -join ';'; \
         [Environment]::SetEnvironmentVariable('PATH', $kept, 'User')",
        ps_quote(dir)
    ))
}

pub(crate) fn powershell(script: &str) -> bool {
    let mut cmd = Command::new("powershell");
    cmd.args(["-NoProfile", "-NonInteractive", "-Command", script]);
    quiet(&mut cmd)
}

fn quiet(cmd: &mut Command) -> bool {
    cmd.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    hide_console(cmd);
    cmd.status().is_ok_and(|s| s.success())
}

fn ps_quote(path: &Path) -> String {
    format!("'{}'", path.display().to_string().replace('\'', "''"))
}

fn path_contains(dir: &Path) -> bool {
    let Some(raw) = std::env::var_os("PATH") else { return false };
    std::env::split_paths(&raw).any(|entry| same_path(&entry, dir))
}

fn same_path(a: &Path, b: &Path) -> bool {
    let a = a.to_string_lossy();
    let b = b.to_string_lossy();
    if cfg!(windows) { a.trim().eq_ignore_ascii_case(b.trim()) } else { a.trim() == b.trim() }
}

fn current_exe() -> Option<PathBuf> {
    std::env::current_exe().ok()
}

fn make_executable(path: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755));
    }
    #[cfg(not(unix))]
    let _ = path;
}

fn home() -> PathBuf {
    env_path("HOME").or_else(|| env_path("USERPROFILE")).unwrap_or_else(|| PathBuf::from("."))
}

fn env_path(name: &str) -> Option<PathBuf> {
    std::env::var_os(name).filter(|v| !v.is_empty()).map(PathBuf::from)
}
