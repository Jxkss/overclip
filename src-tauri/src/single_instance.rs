
#[cfg(windows)]
use windows::core::w;
#[cfg(windows)]
use windows::Win32::Foundation::{GetLastError, ERROR_ALREADY_EXISTS, HWND, LPARAM, LRESULT, WPARAM};

#[cfg(windows)]
pub const WM_OVERCLIP_IPC: u32 = windows::Win32::UI::WindowsAndMessaging::WM_APP + 2;

#[derive(Clone, Copy)]
pub enum Request {
    ShowGallery = 0,
    OpenSetup = 1,
}

impl Request {
    pub fn from_raw(v: usize) -> Self {
        if v == Request::OpenSetup as usize {
            Request::OpenSetup
        } else {
            Request::ShowGallery
        }
    }
}

#[cfg(windows)]
pub fn acquire() -> bool {
    use windows::Win32::System::Threading::CreateMutexW;
    unsafe {
        let created = CreateMutexW(None, true, w!("Local\\Overclip.SingleInstance"));
        !(created.is_ok() && GetLastError() == ERROR_ALREADY_EXISTS)
    }
}

#[cfg(not(windows))]
pub fn acquire() -> bool {
    true
}

#[cfg(windows)]
pub fn notify_running(req: Request) {
    use windows::Win32::UI::WindowsAndMessaging::{FindWindowExW, PostMessageW, HWND_MESSAGE};
    unsafe {
        if let Ok(hwnd) = FindWindowExW(HWND_MESSAGE, None, w!("OverclipIpcWindow"), None) {
            let _ = PostMessageW(hwnd, WM_OVERCLIP_IPC, WPARAM(req as usize), LPARAM(0));
        }
    }
}

#[cfg(not(windows))]
pub fn notify_running(_req: Request) {}

#[cfg(windows)]
unsafe extern "system" fn ipc_wndproc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    windows::Win32::UI::WindowsAndMessaging::DefWindowProcW(hwnd, msg, wparam, lparam)
}

#[cfg(windows)]
pub fn create_ipc_window() {
    use windows::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, RegisterClassW, HWND_MESSAGE, WINDOW_EX_STYLE, WINDOW_STYLE, WNDCLASSW,
    };
    unsafe {
        let class = WNDCLASSW {
            lpfnWndProc: Some(ipc_wndproc),
            lpszClassName: w!("OverclipIpcWindow"),
            ..Default::default()
        };
        RegisterClassW(&class);
        let _ = CreateWindowExW(
            WINDOW_EX_STYLE(0),
            w!("OverclipIpcWindow"),
            w!("Overclip IPC"),
            WINDOW_STYLE(0),
            0,
            0,
            0,
            0,
            HWND_MESSAGE,
            None,
            None,
            None,
        );
    }
}
