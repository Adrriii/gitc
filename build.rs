fn main() {
    println!("cargo:rerun-if-changed=icons/gitc.ico");
    #[cfg(windows)]
    if std::env::var("CARGO_CFG_TARGET_OS").is_ok_and(|os| os == "windows") {
        let mut res = winresource::WindowsResource::new();
        res.set_icon("icons/gitc.ico");
        if let Err(e) = res.compile() {
            println!("cargo:warning=no icon embedded: {e}");
        }
    }
}
