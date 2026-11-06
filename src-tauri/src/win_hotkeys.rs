#[cfg(windows)]
use std::sync::atomic::Ordering;
#[cfg(windows)]
use std::sync::atomic::{AtomicU32, AtomicU8};

#[cfg(windows)]
use tauri::{AppHandle, Emitter, Manager};

#[cfg(windows)]
static MOD_MASK: AtomicU32 = AtomicU32::new(0);
#[cfg(windows)]
static TRIG_MASK: AtomicU8 = AtomicU8::new(0);
#[cfg(windows)]
static HELD_MASK: AtomicU8 = AtomicU8::new(0);
#[cfg(windows)]
static HOTKEY_THREAD: AtomicU32 = AtomicU32::new(0);
#[cfg(windows)]
const WM_RELOAD_HOTKEY: u32 = windows::Win32::UI::WindowsAndMessaging::WM_APP + 1;

const MOD_ALT_BIT: u32 = 0x1;
const MOD_CONTROL_BIT: u32 = 0x2;
const MOD_SHIFT_BIT: u32 = 0x4;
const MOD_WIN_BIT: u32 = 0x8;

pub fn parse_shortcut(s: &str) -> Option<(u32, u32)> {
    let mut mods = 0u32;
    let mut vk: Option<u32> = None;
    for part in s.split('+').map(str::trim).filter(|p| !p.is_empty()) {
        let lower = part.to_ascii_lowercase();
        match lower.as_str() {
            "ctrl" | "control" => mods |= MOD_CONTROL_BIT,
            "alt" | "option" => mods |= MOD_ALT_BIT,
            "shift" => mods |= MOD_SHIFT_BIT,
            "win" | "super" | "meta" | "cmd" => mods |= MOD_WIN_BIT,
            _ => {
                if vk.is_some() {
                    return None;
                }
                vk = Some(key_code(&lower)?);
            }
        }
    }
    Some((mods, vk?))
}

fn key_code(k: &str) -> Option<u32> {
    let b = k.as_bytes();
    if b.len() == 1 && (b[0].is_ascii_alphanumeric()) {
        return Some(b[0].to_ascii_uppercase() as u32);
    }
    if let Some(n) = k.strip_prefix('f').and_then(|n| n.parse::<u32>().ok()) {
        return (1..=24).contains(&n).then_some(0x70 + n - 1);
    }
    if let Some(n) = k.strip_prefix("num").and_then(|n| n.parse::<u32>().ok()) {
        return (n <= 9).then_some(0x60 + n);
    }
    Some(match k {
        "space" => 0x20,
        "tab" => 0x09,
        "backquote" | "`" => 0xC0,
        "insert" => 0x2D,
        "delete" => 0x2E,
        "home" => 0x24,
        "end" => 0x23,
        "pageup" => 0x21,
        "pagedown" => 0x22,
        "up" => 0x26,
        "down" => 0x28,
        "left" => 0x25,
        "right" => 0x27,
        "pause" => 0x13,
        "scrolllock" => 0x91,
        _ => return None,
    })
}

#[cfg(windows)]
pub fn reload_overlay_hotkey() {
    use windows::Win32::Foundation::{LPARAM, WPARAM};
    use windows::Win32::UI::WindowsAndMessaging::PostThreadMessageW;
    let tid = HOTKEY_THREAD.load(Ordering::SeqCst);
    if tid != 0 {
        unsafe {
            let _ = PostThreadMessageW(tid, WM_RELOAD_HOTKEY, WPARAM(0), LPARAM(0));
        }
    }
}

#[cfg(not(windows))]
pub fn reload_overlay_hotkey() {}

#[cfg(windows)]
pub fn spawn_hotkey_thread(app: AppHandle) {
    use windows::Win32::Foundation::{LPARAM, LRESULT, WPARAM};
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        RegisterHotKey, UnregisterHotKey, HOT_KEY_MODIFIERS, MOD_ALT, MOD_CONTROL, MOD_NOREPEAT, VK_CONTROL, VK_LCONTROL, VK_LMENU,
        VK_LSHIFT, VK_MENU, VK_RCONTROL, VK_RMENU, VK_RSHIFT, VK_SHIFT,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        CallNextHookEx, DispatchMessageW, GetMessageW, SetWindowsHookExW, TranslateMessage,
        UnhookWindowsHookEx, HC_ACTION, KBDLLHOOKSTRUCT, MSG, WH_KEYBOARD_LL, WM_HOTKEY, WM_KEYDOWN,
        WM_KEYUP, WM_SYSKEYDOWN, WM_SYSKEYUP,
    };

    const ID_OVERLAY: i32 = 1;
    const ID_PANEL: i32 = 2;

    const BIT_CTRL: u32 = 1 << 0;
    const BIT_ALT: u32 = 1 << 1;
    const BIT_SHIFT: u32 = 1 << 2;
    const TRIG_U: u8 = 1 << 0;
    const TRIG_H: u8 = 1 << 1;
    const HELD_U: u8 = 1 << 0;
    const HELD_H: u8 = 1 << 1;

    unsafe fn register_overlay(app: &AppHandle, hwnd: HWND) {
        let (gallery, panel) = app
            .try_state::<crate::AppState>()
            .map(|s| {
                let s = s.settings.read();
                (s.overlay_shortcut.clone(), s.panel_shortcut.clone())
            })
            .unwrap_or_default();
        let mut gallery_ok = false;
        if let Some((m, vk)) = parse_shortcut(&gallery) {
            gallery_ok = RegisterHotKey(hwnd, ID_OVERLAY, HOT_KEY_MODIFIERS(m) | MOD_NOREPEAT, vk).is_ok();
            if !gallery_ok {
                let _ = app.emit(
                    "hotkey-error",
                    format!("{gallery} is already used by another app; falling back to Ctrl+Alt+P"),
                );
            }
        }
        if !gallery_ok {
            let _ = RegisterHotKey(hwnd, ID_OVERLAY, MOD_CONTROL | MOD_ALT | MOD_NOREPEAT, 'P' as u32);
        }
        if let Some((m, vk)) = parse_shortcut(&panel) {
            if RegisterHotKey(hwnd, ID_PANEL, HOT_KEY_MODIFIERS(m) | MOD_NOREPEAT, vk).is_err() {
                let _ = app.emit(
                    "hotkey-error",
                    format!("{panel} is already used by another app; the side panel has no shortcut"),
                );
            }
        }
    }

    std::thread::spawn(move || unsafe {
        HOTKEY_THREAD.store(
            windows::Win32::System::Threading::GetCurrentThreadId(),
            Ordering::SeqCst,
        );

        let hwnd = HWND(std::ptr::null_mut());
        register_overlay(&app, hwnd);
        crate::single_instance::create_ipc_window();

        let mic_keys = app
            .try_state::<crate::AppState>()
            .is_some_and(|s| s.settings.read().mic_hotkeys);
        let hook = if mic_keys {
            SetWindowsHookExW(WH_KEYBOARD_LL, Some(llkbd_proc), None, 0).ok()
        } else {
            None
        };

        let mut msg = MSG::default();
        while GetMessageW(&mut msg, hwnd, 0, 0).as_bool() {
            if msg.message == crate::single_instance::WM_OVERCLIP_IPC {
                match crate::single_instance::Request::from_raw(msg.wParam.0) {
                    crate::single_instance::Request::OpenSetup => crate::open_setup_window(&app),
                    crate::single_instance::Request::ShowGallery => {
                        let _ = crate::show_overlay(&app, false);
                    }
                }
                continue;
            }
            if msg.message == WM_RELOAD_HOTKEY {
                let _ = UnregisterHotKey(hwnd, ID_OVERLAY);
                let _ = UnregisterHotKey(hwnd, ID_PANEL);
                register_overlay(&app, hwnd);
                continue;
            }
            if msg.message == WM_HOTKEY {
                match msg.wParam.0 as i32 {
                    ID_OVERLAY => {
                        let _ = crate::toggle_overlay(&app, false);
                    }
                    ID_PANEL => {
                        let _ = crate::toggle_overlay(&app, true);
                    }
                    _ => {}
                }
            }

            let fired = TRIG_MASK.swap(0, std::sync::atomic::Ordering::AcqRel);
            if fired & TRIG_U != 0 {
                let _ = (|| -> Result<(), String> {
                    let cur = crate::audio::read_microphone_muted()?;
                    let next = !cur;
                    crate::audio::set_microphone_mute(next)?;
                    let _ = app.emit("mic-state", next);
                    Ok(())
                })();
            }
            if fired & TRIG_H != 0 {
                if let Some(st) = app.try_state::<crate::AppState>() {
                    let next = !st.deafened.load(Ordering::SeqCst);
                    st.deafened.store(next, Ordering::SeqCst);
                    let _ = crate::audio::set_deafen(next);
                    let _ = app.emit("deafen-state", next);
                }
            }

            let _ = TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }

        let _ = UnregisterHotKey(hwnd, ID_OVERLAY);
        let _ = UnregisterHotKey(hwnd, ID_PANEL);
        if let Some(h) = hook {
            let _ = UnhookWindowsHookEx(h);
        }
    });

    unsafe extern "system" fn llkbd_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        use windows::Win32::UI::Input::KeyboardAndMouse::{VK_H, VK_O, VK_U};
        use windows::Win32::UI::WindowsAndMessaging::LLKHF_UP;

        if code != HC_ACTION as i32 {
            return CallNextHookEx(None, code, wparam, lparam);
        }

        let kb = &*(lparam.0 as *const KBDLLHOOKSTRUCT);
        let vk = kb.vkCode;
        let is_up = kb.flags.contains(LLKHF_UP);

        if vk == VK_CONTROL.0 as u32 || vk == VK_LCONTROL.0 as u32 || vk == VK_RCONTROL.0 as u32 {
            update_mask(BIT_CTRL, is_up);
        } else if vk == VK_MENU.0 as u32 || vk == VK_LMENU.0 as u32 || vk == VK_RMENU.0 as u32 {
            update_mask(BIT_ALT, is_up);
        } else if vk == VK_SHIFT.0 as u32 || vk == VK_LSHIFT.0 as u32 || vk == VK_RSHIFT.0 as u32 {
            update_mask(BIT_SHIFT, is_up);
        }

        let msg = wparam.0 as u32;
        let is_down_msg = msg == WM_KEYDOWN || msg == WM_SYSKEYDOWN;
        let is_up_msg = msg == WM_KEYUP || msg == WM_SYSKEYUP;

        let mods = MOD_MASK.load(std::sync::atomic::Ordering::Relaxed);
        let has_all = (mods & (BIT_CTRL | BIT_ALT | BIT_SHIFT)) == (BIT_CTRL | BIT_ALT | BIT_SHIFT);

        if has_all && is_down_msg {
            if vk == VK_U.0 as u32 {
                let held = HELD_MASK.load(std::sync::atomic::Ordering::Relaxed);
                if (held & HELD_U) == 0 {
                    HELD_MASK.fetch_or(HELD_U, std::sync::atomic::Ordering::Relaxed);
                    TRIG_MASK.fetch_or(TRIG_U, std::sync::atomic::Ordering::Release);
                }
            } else if vk == VK_H.0 as u32 {
                let held = HELD_MASK.load(std::sync::atomic::Ordering::Relaxed);
                if (held & HELD_H) == 0 {
                    HELD_MASK.fetch_or(HELD_H, std::sync::atomic::Ordering::Relaxed);
                    TRIG_MASK.fetch_or(TRIG_H, std::sync::atomic::Ordering::Release);
                }
            } else if vk == VK_O.0 as u32 {
            }
        }

        if is_up_msg || is_up {
            if vk == VK_U.0 as u32 {
                HELD_MASK.fetch_and(!HELD_U, std::sync::atomic::Ordering::Relaxed);
            } else if vk == VK_H.0 as u32 {
                HELD_MASK.fetch_and(!HELD_H, std::sync::atomic::Ordering::Relaxed);
            }
        }

        CallNextHookEx(None, code, wparam, lparam)
    }

    #[inline]
    fn update_mask(bit: u32, is_up: bool) {
        if is_up {
            MOD_MASK.fetch_and(!bit, std::sync::atomic::Ordering::Relaxed);
        } else {
            MOD_MASK.fetch_or(bit, std::sync::atomic::Ordering::Relaxed);
        }
    }
}