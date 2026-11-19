const COMMANDS: [&str; 3] = ["squash", "drop", "reword"];
const REDATE: &str = "exec git commit --amend --no-edit --date=now";

/// Applies the spec's command (first line) to the todo lines whose hash matches one of
/// the spec's hashes. An unreadable or unknown spec leaves the todo untouched.
pub fn rewrite_todo(spec_path: &str, todo_path: &str) {
    let Ok(spec) = std::fs::read_to_string(spec_path) else {
        return;
    };
    let Ok(todo) = std::fs::read_to_string(todo_path) else {
        return;
    };
    let Some(out) = rewritten(&spec, &todo) else {
        return;
    };
    if let Err(e) = std::fs::write(todo_path, out) {
        eprintln!("gitc: cannot write the rebase todo: {e}");
    }
}

/// Puts the prepared message where git expects the edited one.
pub fn write_message(message_path: &str, target_path: &str) {
    let Ok(message) = std::fs::read(message_path) else {
        return;
    };
    if let Err(e) = std::fs::write(target_path, message) {
        eprintln!("gitc: cannot write the rebase message: {e}");
    }
}

fn rewritten(spec: &str, todo: &str) -> Option<String> {
    let mut lines = spec.lines().map(str::trim).filter(|l| !l.is_empty());
    let command = lines.next()?;
    if !COMMANDS.contains(&command) {
        return None;
    }
    let wanted: Vec<&str> = lines.collect();

    let mut out: Vec<String> = Vec::new();
    let mut last = None;
    for line in todo.split('\n') {
        let trimmed = line.trim();
        let hash = trimmed.split(' ').nth(1).unwrap_or("");
        let hit = !trimmed.starts_with('#')
            && !hash.is_empty()
            && wanted.iter().any(|w| w.starts_with(hash) || hash.starts_with(w));
        if !hit {
            out.push(line.to_string());
            continue;
        }
        let rest = trimmed.split_once(' ').map(|(_, r)| r).unwrap_or("");
        out.push(format!("{command} {rest}"));
        last = Some(out.len() - 1);
    }
    if let (Some(at), "squash") = (last, command) {
        out.insert(at + 1, REDATE.to_string());
    }
    Some(out.join("\n"))
}

#[cfg(test)]
mod tests {
    use super::*;

    const TODO: [&str; 6] = [
        "pick aaaaaaa first",
        "pick bbbbbbb second",
        "pick ccccccc third",
        "",
        "# Rebase 000000..ccccccc onto 000000 (3 commands)",
        "# p, pick <commit> = use commit",
    ];

    fn run(command: &str, hashes: &[&str]) -> Vec<String> {
        let spec = std::iter::once(command).chain(hashes.iter().copied()).collect::<Vec<_>>().join("\n");
        let todo = TODO.join("\n");
        rewritten(&spec, &todo).unwrap_or(todo).split('\n').map(String::from).collect()
    }

    #[test]
    fn squash() {
        let marked: Vec<String> =
            run("squash", &["aaaaaaa", "bbbbbbb"]).into_iter().filter(|l| !l.starts_with("exec")).collect();
        assert_eq!(marked[..3], ["squash aaaaaaa first", "squash bbbbbbb second", "pick ccccccc third"]);
        assert_eq!(run("squash", &["aaaaaaa"])[..3], ["squash aaaaaaa first", REDATE, "pick bbbbbbb second"]);
    }

    #[test]
    fn drop_and_reword() {
        assert_eq!(run("drop", &["bbbbbbb"])[..3], ["pick aaaaaaa first", "drop bbbbbbb second", "pick ccccccc third"]);
        assert!(run("reword", &["bbbbbbb"]).iter().all(|l| !l.starts_with("exec")));
        assert!(run("drop", &["bbbbbbb"]).iter().all(|l| !l.starts_with("exec")));
        assert_eq!(run("drop", &["bbbbbbb"])[3..], TODO[3..]);
        assert_eq!(
            run("drop", &["bbbbbbbffffffffffffffffffffffffffffffffff"])[..3],
            ["pick aaaaaaa first", "drop bbbbbbb second", "pick ccccccc third"]
        );
    }

    #[test]
    fn untouched() {
        assert_eq!(run("edit", &["bbbbbbb"]), TODO);
        assert_eq!(run("", &[]), TODO);
        assert_eq!(run("drop", &["9999999"]), TODO);
    }
}
