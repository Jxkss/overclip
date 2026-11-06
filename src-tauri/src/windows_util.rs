use std::process::Command;

#[cfg(windows)]
pub fn reveal_in_file_manager(path: &str) -> Result<(), String> {
    let path = path.replace('/', "\\");
    Command::new("explorer")
        .arg("/select,")
        .arg(path.replace('"', ""))
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(not(windows))]
pub fn reveal_in_file_manager(path: &str) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .args(["-R", path])
            .spawn()
            .map_err(|e| e.to_string())?;
        return Ok(());
    }
    #[cfg(not(target_os = "macos"))]
    {
        use std::path::Path;
        let p = Path::new(path);
        if let Some(parent) = p.parent() {
            open::that(parent).map_err(|e| e.to_string())?;
        }
        Ok(())
    }
}

fn double_null_list(paths: &[std::path::PathBuf]) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;
    let mut out = Vec::new();
    for p in paths {
        out.extend(p.as_os_str().encode_wide());
        out.push(0);
    }
    out.push(0);
    out
}

#[cfg(windows)]
pub fn move_to_recycle_bin(paths: &[std::path::PathBuf]) -> Result<(), String> {
    use windows::core::PCWSTR;
    use windows::Win32::UI::Shell::{
        SHFileOperationW, FOF_ALLOWUNDO, FOF_NOCONFIRMATION, FOF_NOERRORUI, FOF_SILENT,
        FOF_WANTNUKEWARNING, FO_DELETE, SHFILEOPSTRUCTW,
    };
    if paths.is_empty() {
        return Ok(());
    }
    let from = double_null_list(paths);
    let mut op = SHFILEOPSTRUCTW {
        wFunc: FO_DELETE,
        pFrom: PCWSTR(from.as_ptr()),
        fFlags: (FOF_ALLOWUNDO | FOF_NOCONFIRMATION | FOF_SILENT | FOF_NOERRORUI | FOF_WANTNUKEWARNING).0
            as u16,
        ..Default::default()
    };
    let r = unsafe { SHFileOperationW(&mut op) };
    if r != 0 {
        return Err(format!("Couldn't move to Recycle Bin (is the file open somewhere?) [0x{r:x}]"));
    }
    if op.fAnyOperationsAborted.as_bool() {
        return Err("Delete was cancelled".into());
    }
    Ok(())
}

#[cfg(windows)]
pub fn copy_files_to_clipboard(owner: isize, paths: &[std::path::PathBuf]) -> Result<(), String> {
    use windows::core::w;
    use windows::Win32::Foundation::{GlobalFree, HANDLE, HWND, TRUE};
    use windows::Win32::System::DataExchange::{
        CloseClipboard, EmptyClipboard, OpenClipboard, RegisterClipboardFormatW, SetClipboardData,
    };
    use windows::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE, GMEM_ZEROINIT};
    use windows::Win32::System::Ole::CF_HDROP;
    use windows::Win32::UI::Shell::DROPFILES;

    if paths.is_empty() {
        return Ok(());
    }
    let list = double_null_list(paths);
    let header = std::mem::size_of::<DROPFILES>();
    unsafe {
        let hdrop = GlobalAlloc(GMEM_MOVEABLE | GMEM_ZEROINIT, header + list.len() * 2).map_err(|e| e.to_string())?;
        let p = GlobalLock(hdrop) as *mut u8;
        if p.is_null() {
            let _ = GlobalFree(hdrop);
            return Err("GlobalLock failed".into());
        }
        let df = p as *mut DROPFILES;
        (*df).pFiles = header as u32;
        (*df).fWide = TRUE;
        std::ptr::copy_nonoverlapping(list.as_ptr() as *const u8, p.add(header), list.len() * 2);
        let _ = GlobalUnlock(hdrop);

        let heffect = GlobalAlloc(GMEM_MOVEABLE, 4).map_err(|e| e.to_string())?;
        let pe = GlobalLock(heffect) as *mut u32;
        if !pe.is_null() {
            *pe = 1;
            let _ = GlobalUnlock(heffect);
        }

        let mut opened = false;
        for _ in 0..10 {
            if OpenClipboard(HWND(owner as *mut _)).is_ok() {
                opened = true;
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(30));
        }
        if !opened {
            let _ = GlobalFree(hdrop);
            let _ = GlobalFree(heffect);
            return Err("Clipboard is busy, try again".into());
        }
        let _ = EmptyClipboard();
        let res = SetClipboardData(CF_HDROP.0 as u32, HANDLE(hdrop.0));
        if res.is_err() {
            let _ = GlobalFree(hdrop);
        }
        let fmt = RegisterClipboardFormatW(w!("Preferred DropEffect"));
        if fmt == 0 || SetClipboardData(fmt, HANDLE(heffect.0)).is_err() {
            let _ = GlobalFree(heffect);
        }
        let _ = CloseClipboard();
        res.map(|_| ()).map_err(|e| e.to_string())
    }
}

#[cfg(windows)]
pub fn foreground_monitor_rect() -> Option<(i32, i32, i32, i32)> {
    use windows::Win32::Graphics::Gdi::{GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTOPRIMARY};
    use windows::Win32::UI::WindowsAndMessaging::GetForegroundWindow;
    unsafe {
        let monitor = MonitorFromWindow(GetForegroundWindow(), MONITOR_DEFAULTTOPRIMARY);
        let mut info = MONITORINFO {
            cbSize: std::mem::size_of::<MONITORINFO>() as u32,
            ..Default::default()
        };
        if !GetMonitorInfoW(monitor, &mut info).as_bool() {
            return None;
        }
        let r = info.rcMonitor;
        Some((r.left, r.top, r.right - r.left, r.bottom - r.top))
    }
}

#[cfg(not(windows))]
pub fn foreground_monitor_rect() -> Option<(i32, i32, i32, i32)> {
    None
}

#[cfg(windows)]
pub fn send_chord(mods: u32, vk: u32) -> Result<(), String> {
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        MapVirtualKeyW, SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYBD_EVENT_FLAGS, KEYEVENTF_EXTENDEDKEY,
        KEYEVENTF_KEYUP, MAPVK_VK_TO_VSC, VIRTUAL_KEY,
    };
    const VK_LWIN: u32 = 0x5B;
    const VK_SHIFT: u32 = 0x10;
    const VK_CONTROL: u32 = 0x11;
    const VK_MENU: u32 = 0x12;
    let extended = |k: u32| matches!(k, 0x21..=0x2E | 0x5B | 0x5C);
    let key = |k: u32, up: bool| {
        let mut flags = KEYBD_EVENT_FLAGS(0);
        if up {
            flags |= KEYEVENTF_KEYUP;
        }
        if extended(k) {
            flags |= KEYEVENTF_EXTENDEDKEY;
        }
        INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: VIRTUAL_KEY(k as u16),
                    wScan: unsafe { MapVirtualKeyW(k, MAPVK_VK_TO_VSC) } as u16,
                    dwFlags: flags,
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        }
    };
    let mut held = Vec::new();
    for (bit, k) in [(2, VK_CONTROL), (1, VK_MENU), (4, VK_SHIFT), (8, VK_LWIN)] {
        if mods & bit != 0 {
            held.push(k);
        }
    }
    let mut down: Vec<INPUT> = held.iter().map(|&k| key(k, false)).collect();
    down.push(key(vk, false));
    let mut up = vec![key(vk, true)];
    up.extend(held.iter().rev().map(|&k| key(k, true)));
    unsafe {
        let size = std::mem::size_of::<INPUT>() as i32;
        if SendInput(&down, size) as usize != down.len() {
            return Err("Windows blocked the key press".into());
        }
        std::thread::sleep(std::time::Duration::from_millis(60));
        SendInput(&up, size);
    }
    Ok(())
}

#[cfg(windows)]
pub fn process_running(names: &[&str]) -> bool {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
    };
    unsafe {
        let Ok(snap) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) else { return false };
        let mut entry = PROCESSENTRY32W {
            dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
            ..Default::default()
        };
        let mut found = false;
        let mut ok = Process32FirstW(snap, &mut entry).is_ok();
        while ok {
            let len = entry.szExeFile.iter().position(|&c| c == 0).unwrap_or(entry.szExeFile.len());
            let exe = String::from_utf16_lossy(&entry.szExeFile[..len]);
            if names.iter().any(|n| n.eq_ignore_ascii_case(&exe)) {
                found = true;
                break;
            }
            ok = Process32NextW(snap, &mut entry).is_ok();
        }
        let _ = CloseHandle(snap);
        found
    }
}
