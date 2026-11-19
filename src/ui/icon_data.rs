pub fn svg(name: &str) -> Option<&'static str> {
    Some(match name {
        "fetch" => {
            r##"<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.5 12a8.5 8.5 0 1 1-2.5-6" /> <path d="M20.5 3.5V6H18" /></svg>"##
        }
        "pull" => {
            r##"<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v11" /> <path d="M7.5 10.5 12 15l4.5-4.5" /> <path d="M4 20h16" /></svg>"##
        }
        "push" => {
            r##"<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21V10" /> <path d="M7.5 13.5 12 9l4.5 4.5" /> <path d="M4 4h16" /></svg>"##
        }
        "gear" => {
            r##"<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9.9 5.9 L10.4 3.2 L13.6 3.2 L14.1 5.9 L14.8 6.2 L17.1 4.6 L19.4 6.9 L17.8 9.2 L18.1 9.9 L20.8 10.4 L20.8 13.6 L18.1 14.1 L17.8 14.8 L19.4 17.1 L17.1 19.4 L14.8 17.8 L14.1 18.1 L13.6 20.8 L10.4 20.8 L9.9 18.1 L9.2 17.8 L6.9 19.4 L4.6 17.1 L6.2 14.8 L5.9 14.1 L3.2 13.6 L3.2 10.4 L5.9 9.9 L6.2 9.2 L4.6 6.9 L6.9 4.6 L9.2 6.2 Z" /> <circle cx="12" cy="12" r="3" /></svg>"##
        }
        "kebab" => {
            r##"<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="5" r="1.4" /> <circle cx="12" cy="12" r="1.4" /> <circle cx="12" cy="19" r="1.4" /></svg>"##
        }
        "eye" => {
            r##"<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" /> <circle cx="12" cy="12" r="3" /></svg>"##
        }
        "eyeOff" => {
            r##"<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" /> <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" /> <path d="M14.12 14.12a3 3 0 1 1-4.24-4.24" /> <path d="M1 1l22 22" /></svg>"##
        }
        "folder" => {
            r##"<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6.5a1.5 1.5 0 0 1 1.5-1.5h4l2 2.2h8A1.5 1.5 0 0 1 20 8.7v9.8a1.5 1.5 0 0 1-1.5 1.5h-14A1.5 1.5 0 0 1 3 18.5z" /></svg>"##
        }
        "branch" => {
            r##"<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="7" cy="6" r="2.2" /> <circle cx="7" cy="18" r="2.2" /> <circle cx="17" cy="6" r="2.2" /> <path d="M7 8.2v7.6" /> <path d="M17 8.2v1.3a4 4 0 0 1-4 4H9" /></svg>"##
        }
        "stash" => {
            r##"<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9h16v10H4z" /> <path d="M3 5h18v4H3z" /> <path d="M12 11.5v4.5" /> <path d="M10 14l2 2 2-2" /></svg>"##
        }
        "pop" => {
            r##"<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9h16v10H4z" /> <path d="M3 5h18v4H3z" /> <path d="M12 16.5V12" /> <path d="M10 14l2-2 2 2" /></svg>"##
        }
        "close" => {
            r##"<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 6l12 12" /> <path d="M18 6L6 18" /></svg>"##
        }
        "plus" => {
            r##"<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14" /> <path d="M5 12h14" /></svg>"##
        }
        "chevronRight" => {
            r##"<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 5l7 7-7 7" /></svg>"##
        }
        "chevronDown" => {
            r##"<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 9l7 7 7-7" /></svg>"##
        }
        "tag" => {
            r##"<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 11.5V4h7.5L21 14.5 14.5 21 3 11.5z" /> <circle cx="7.5" cy="7.5" r="1.3" /></svg>"##
        }
        "cloud" => {
            r##"<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6.5 19a4 4 0 0 1 .4-8 5.5 5.5 0 0 1 10.5 1.4A3.6 3.6 0 0 1 17.5 19z" /></svg>"##
        }
        "check" => {
            r##"<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 12.5l5 5 10-10" /></svg>"##
        }
        "trash" => {
            r##"<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16" /> <path d="M9 7V4h6v3" /> <path d="M6 7l1 13h10l1-13" /></svg>"##
        }
        "edit" => {
            r##"<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h4L20 8l-4-4L4 16z" /> <path d="M14 6l4 4" /></svg>"##
        }
        "file" => {
            r##"<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3h8l5 5v13H6z" /> <path d="M14 3v5h5" /></svg>"##
        }
        "added" => {
            r##"<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 6v12" /> <path d="M6 12h12" /></svg>"##
        }
        "removed" => {
            r##"<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 12h12" /></svg>"##
        }
        "repo" => {
            r##"<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 4h14v16H8a3 3 0 0 1-3-3z" /> <path d="M5 17a3 3 0 0 1 3-3h11" /></svg>"##
        }
        "search" => {
            r##"<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="6" /> <path d="M15.5 15.5L20 20" /></svg>"##
        }
        "unified" => {
            r##"<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5h16v14H4z" /> <path d="M4 12h16" /></svg>"##
        }
        "inline" => {
            r##"<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16" /> <path d="M4 12h16" /> <path d="M4 17h10" /></svg>"##
        }
        "split" => {
            r##"<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5h16v14H4z" /> <path d="M12 5v14" /></svg>"##
        }
        "pilcrow" => {
            r##"<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 4v16" /> <path d="M17 4v16" /> <path d="M13 4h-2.5a3.5 3.5 0 0 0 0 7H13" /></svg>"##
        }
        "wrap" => {
            r##"<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6h16" /> <path d="M4 12h12a3 3 0 0 1 0 6h-3" /> <path d="M15 15l-2 3 2 3" /></svg>"##
        }
        "arrowUp" => {
            r##"<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20V5" /> <path d="M6 11l6-6 6 6" /></svg>"##
        }
        "arrowDown" => {
            r##"<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v15" /> <path d="M6 13l6 6 6-6" /></svg>"##
        }
        "warning" => {
            r##"<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3.5 22 20H2z" /> <path d="M12 10v4.5" /> <path d="M12 17.4v.2" /></svg>"##
        }
        "monitor" => {
            r##"<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 5h18v11H3z" /> <path d="M9 20h6" /> <path d="M12 16v4" /></svg>"##
        }
        "copy" => {
            r##"<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 9h11v11H9z" /> <path d="M5 15H4V4h11v1" /></svg>"##
        }
        "sparkle" => {
            r##"<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 3.5l1.8 5.2 5.2 1.8-5.2 1.8L10 17.5l-1.8-5.2L3 10.5l5.2-1.8z" /> <path d="M18 15l.8 2.2 2.2.8-2.2.8L18 21l-.8-2.2-2.2-.8 2.2-.8z" /></svg>"##
        }
        "undo" => {
            r##"<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 14L4 9l5-5" /> <path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" /></svg>"##
        }
        "worktree" => {
            r##"<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6.5a1.5 1.5 0 0 1 1.5-1.5h4l2 2.2h8A1.5 1.5 0 0 1 20 8.7v9.8a1.5 1.5 0 0 1-1.5 1.5h-14A1.5 1.5 0 0 1 3 18.5z" /> <path d="M9 17v-6" /> <path d="M9 14a3 3 0 0 0 3-3h3" /></svg>"##
        }
        _ => return None,
    })
}
