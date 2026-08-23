fn main() {
    for path in [
        "icons/icon.ico",
        "icons/icon.png",
        "icons/32x32.png",
        "icons/128x128.png",
        "icons/128x128@2x.png",
        "../app-icon.png",
    ] {
        println!("cargo:rerun-if-changed={path}");
    }
    tauri_build::build()
}
