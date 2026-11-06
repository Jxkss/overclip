
use std::path::Path;

const OLD_ID: &str = "com.jutil.app";
const NEW_ID: &str = "com.overclip.app";

pub fn from_jutil() {
    for var in ["APPDATA", "LOCALAPPDATA"] {
        let Ok(base) = std::env::var(var) else { continue };
        let old = Path::new(&base).join(OLD_ID);
        let new = Path::new(&base).join(NEW_ID);
        if old.is_dir() && !new.exists() {
            copy_dir(&old, &new);
        }
    }
}

fn copy_dir(from: &Path, to: &Path) {
    if std::fs::create_dir_all(to).is_err() {
        return;
    }
    let Ok(entries) = std::fs::read_dir(from) else { return };
    for e in entries.flatten() {
        let src = e.path();
        let dst = to.join(e.file_name());
        match e.file_type() {
            Ok(t) if t.is_dir() => copy_dir(&src, &dst),
            Ok(t) if t.is_file() => {
                let _ = std::fs::copy(&src, &dst);
            }
            _ => {}
        }
    }
}
