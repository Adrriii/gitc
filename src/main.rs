#![cfg_attr(not(test), windows_subsystem = "windows")]

mod engine;
mod ui;

use engine::{crashes, install, instance, update};

pub const NAME: &str = "gitc";
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

fn main() {
    crashes::install_panic_hook();
    let args: Vec<String> = std::env::args().skip(1).collect();

    let mut portable = false;
    let mut after_update = false;
    let mut wanted: Option<String> = None;
    let mut i = 0;
    while let Some(arg) = args.get(i) {
        i += 1;
        match arg.as_str() {
            "--version" | "-v" => exit_with(&[format!("{NAME} {VERSION}")], 0),
            "--install" => exit_with(&install::install().lines, 0),
            "--uninstall" => {
                let mut lines = vec![format!("uninstalling {NAME}")];
                lines.extend(install::uninstall());
                exit_with(&lines, 0)
            }
            "--rebase-todo" | "--rebase-message" => {
                let (Some(ours), Some(theirs)) = (args.get(i), args.get(i + 1)) else {
                    exit_with(&[format!("usage: {NAME} {arg} <file> <target>")], 1)
                };
                if arg == "--rebase-todo" {
                    engine::rebase_helper::rewrite_todo(ours, theirs);
                } else {
                    engine::rebase_helper::write_message(ours, theirs);
                }
                std::process::exit(0);
            }
            "--stdio" => {
                engine::remote::serve_stdio();
                std::process::exit(0);
            }
            "--portable" => portable = true,
            "--after-update" => after_update = true,
            flag if flag.starts_with("--port=") => match flag.strip_prefix("--port=").unwrap_or("").parse::<u16>() {
                Ok(port) if port > 0 => instance::set_port(port),
                _ => exit_with(&[format!("not a port: {flag}")], 1),
            },
            flag if flag.starts_with('-') => {}
            path if wanted.is_none() => wanted = Some(path.to_string()),
            _ => {}
        }
    }

    let open = wanted.map(|path| repository(&path));

    if !portable && !after_update && !cfg!(debug_assertions) && !install::running_from_install() {
        let report = install::install();
        let started = std::process::Command::new(&report.target)
            .args(open.iter())
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn();
        match started {
            Ok(_) => exit_with(&report.lines, 0),
            Err(e) => eprintln!("gitc: could not start the installed copy, running this one: {e}"),
        }
    }

    if !after_update && instance::hand_off(open.as_deref()) {
        let said = open
            .as_deref()
            .map_or("gitc is already running".to_string(), |p| format!("opened {p} in the running gitc"));
        exit_with(&[said], 0);
    }
    instance::claim();
    update::cleanup_previous();
    ui::legacy::adopt();

    ui::run(open);

    instance::release();
    engine::paths::clean_temp_dir();
}

/// An absolute path to the repository given on the command line, or exit with an error.
fn repository(path: &str) -> String {
    let resolved =
        std::path::absolute(path).map(|p| p.to_string_lossy().into_owned()).unwrap_or_else(|_| path.to_string());
    if engine::git::git_or_none(&resolved, &["rev-parse", "--git-dir"]).is_none() {
        exit_with(&[format!("{resolved} is not a git repository")], 1);
    }
    resolved
}

fn exit_with(lines: &[String], code: i32) -> ! {
    attach_console();
    for line in lines {
        if code == 0 {
            println!("{line}");
        } else {
            eprintln!("{line}");
        }
    }
    std::process::exit(code)
}

fn attach_console() {
    #[cfg(windows)]
    unsafe {
        windows_sys::Win32::System::Console::AttachConsole(windows_sys::Win32::System::Console::ATTACH_PARENT_PROCESS);
    }
}
