
use base64::Engine;
use std::ffi::OsStr;
use std::os::windows::ffi::OsStrExt;
use std::path::Path;
use windows::core::PCWSTR;
use windows::Win32::Foundation::CloseHandle;
use windows::Win32::Graphics::Gdi::{
    CreateCompatibleDC, DeleteDC, DeleteObject, GetDIBits, GetObjectW, SelectObject, BI_RGB,
    BITMAP, BITMAPINFO, BITMAPINFOHEADER, DIB_RGB_COLORS, HBITMAP,
};
use windows::Win32::Storage::FileSystem::FILE_FLAGS_AND_ATTRIBUTES;
use windows::Win32::System::Environment::ExpandEnvironmentStringsW;
use windows::Win32::System::Threading::{
    OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::UI::Shell::{SHGetFileInfoW, SHFILEINFOW, SHGFI_ICON, SHGFI_LARGEICON};
use windows::Win32::UI::WindowsAndMessaging::{
    DestroyIcon, GetIconInfo, PrivateExtractIconsW, HICON, ICONINFO,
};

pub(crate) fn session_icon_data_url(pid: u32, com_icon: Option<String>) -> Option<String> {
    let com = com_icon.as_deref().map(expand_env_lossy).unwrap_or_default();
    let com = com.trim();
    let com_opt = if com.is_empty() {
        None
    } else {
        Some(com)
    };

    if let Some(ci) = com_opt {
        let stripped = ci.strip_prefix('@').unwrap_or(ci).trim();
        let (path_part, index) = parse_path_and_icon_index(stripped);

        let p = Path::new(path_part.trim());
        if p.is_file() {
            let ext = p
                .extension()
                .and_then(|e| e.to_str())
                .map(|e| e.to_ascii_lowercase());
            if matches!(ext.as_deref(), Some("png") | Some("jpg") | Some("jpeg") | Some("ico")) {
                if let Ok(bytes) = std::fs::read(p) {
                    let mime = match ext.as_deref() {
                        Some("png") => "image/png",
                        Some("ico") => "image/x-icon",
                        _ => "image/jpeg",
                    };
                    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
                    return Some(format!("data:{mime};base64,{b64}"));
                }
            }
        }

        if !path_part.is_empty() {
            if let Some(url) = unsafe { icon_from_private_extract(&path_part, index) } {
                return Some(url);
            }
            if let Some(url) = unsafe { icon_from_shfileinfo_wide_path(&path_part) } {
                return Some(url);
            }
        }
    }

    let exe = process_image_path(pid)?;
    if let Some(url) = unsafe { icon_from_shfileinfo_wide_path(&exe) } {
        return Some(url);
    }
    unsafe { icon_from_private_extract(&exe, 0) }
}

fn expand_env_lossy(input: &str) -> String {
    unsafe {
        let src: Vec<u16> = input.encode_utf16().chain(Some(0)).collect();
        let mut dst = vec![0u16; 32_768];
        let n = ExpandEnvironmentStringsW(PCWSTR(src.as_ptr()), Some(&mut dst));
        if n == 0 {
            return input.to_string();
        }
        let len = (n as usize).saturating_sub(1);
        String::from_utf16_lossy(&dst[..len.min(dst.len())])
    }
}

fn parse_path_and_icon_index(s: &str) -> (String, i32) {
    let s = s.trim();
    if let Some(pos) = s.rfind(',') {
        let tail = s[pos + 1..].trim();
        if let Ok(idx) = tail.parse::<i32>() {
            return (s[..pos].trim().to_string(), idx);
        }
    }
    (s.to_string(), 0)
}

fn process_image_path(pid: u32) -> Option<String> {
    if pid == 0 {
        return None;
    }
    unsafe {
        let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut buf = vec![0u16; 1024];
        let mut sz = buf.len() as u32;
        let ok = QueryFullProcessImageNameW(
            h,
            PROCESS_NAME_WIN32,
            windows::core::PWSTR::from_raw(buf.as_mut_ptr()),
            &mut sz,
        )
        .is_ok();
        let _ = CloseHandle(h);
        if !ok {
            return None;
        }
        let end = (sz as usize).min(buf.len());
        let len = buf[..end]
            .iter()
            .position(|&x| x == 0)
            .unwrap_or(end);
        Some(String::from_utf16_lossy(&buf[..len]).to_string())
    }
}

unsafe fn path_to_buffer_260(path: &str) -> Option<[u16; 260]> {
    let wide: Vec<u16> = OsStr::new(path).encode_wide().chain(Some(0)).collect();
    if wide.len() > 260 {
        return None;
    }
    let mut arr = [0u16; 260];
    arr[..wide.len()].copy_from_slice(&wide);
    Some(arr)
}

unsafe fn icon_from_private_extract(path: &str, index: i32) -> Option<String> {
    let buf = path_to_buffer_260(path)?;
    let mut icon = HICON::default();
    let mut id = 0u32;
    let got = PrivateExtractIconsW(
        &buf,
        index,
        32,
        32,
        Some(std::slice::from_mut(&mut icon)),
        Some(&mut id),
        0,
    );
    if got == 0 || icon.is_invalid() {
        if !icon.is_invalid() {
            let _ = DestroyIcon(icon);
        }
        return None;
    }
    let out = hicon_to_png_data_url(icon);
    let _ = DestroyIcon(icon);
    out
}

unsafe fn icon_from_shfileinfo_wide_path(path: &str) -> Option<String> {
    let mut wide: Vec<u16> = OsStr::new(path).encode_wide().chain(Some(0)).collect();
    let mut sfi = SHFILEINFOW::default();
    let r = SHGetFileInfoW(
        PCWSTR(wide.as_mut_ptr()),
        FILE_FLAGS_AND_ATTRIBUTES(0),
        Some(&mut sfi),
        std::mem::size_of::<SHFILEINFOW>() as u32,
        SHGFI_ICON | SHGFI_LARGEICON,
    );
    if r == 0 || sfi.hIcon.is_invalid() {
        if !sfi.hIcon.is_invalid() {
            let _ = DestroyIcon(sfi.hIcon);
        }
        return None;
    }
    let out = hicon_to_png_data_url(sfi.hIcon);
    let _ = DestroyIcon(sfi.hIcon);
    out
}

unsafe fn hicon_to_png_data_url(hicon: HICON) -> Option<String> {
    let (w, h, rgba) = hicon_to_rgba(hicon)?;
    rgba_to_png_data_url(w, h, &rgba)
}

unsafe fn hicon_to_rgba(hicon: HICON) -> Option<(u32, u32, Vec<u8>)> {
    let mut ii = ICONINFO::default();
    GetIconInfo(hicon, &mut ii).ok()?;

    let hbmp_color = ii.hbmColor;
    if hbmp_color.is_invalid() {
        if !ii.hbmMask.is_invalid() {
            let _ = DeleteObject(ii.hbmMask);
        }
        return None;
    }

    let out = hbitmap_to_rgba_bgr32(hbmp_color);

    let _ = DeleteObject(hbmp_color);
    if !ii.hbmMask.is_invalid() {
        let _ = DeleteObject(ii.hbmMask);
    }

    out
}

unsafe fn hbitmap_to_rgba_bgr32(hbmp: HBITMAP) -> Option<(u32, u32, Vec<u8>)> {
    let mut bmp = BITMAP::default();
    if GetObjectW(
        hbmp,
        std::mem::size_of::<BITMAP>() as i32,
        Some(&mut bmp as *mut _ as *mut _),
    ) == 0
    {
        return None;
    }

    let w = bmp.bmWidth as u32;
    let h = bmp.bmHeight as u32;
    if w == 0 || h == 0 {
        return None;
    }

    let hdc = CreateCompatibleDC(None);
    if hdc.is_invalid() {
        return None;
    }
    let old = SelectObject(hdc, hbmp);

    let mut bmi = BITMAPINFO {
        bmiHeader: BITMAPINFOHEADER {
            biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: bmp.bmWidth,
            biHeight: -bmp.bmHeight,
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB.0,
            ..Default::default()
        },
        ..Default::default()
    };

    let mut buf = vec![0u8; (w * h * 4) as usize];
    let lines = GetDIBits(
        hdc,
        hbmp,
        0,
        h,
        Some(buf.as_mut_ptr().cast()),
        &mut bmi,
        DIB_RGB_COLORS,
    );

    let _ = SelectObject(hdc, old);
    let _ = DeleteDC(hdc);

    if lines == 0 {
        return None;
    }

    for chunk in buf.chunks_exact_mut(4) {
        chunk.swap(0, 2);
    }
    Some((w, h, buf))
}

fn rgba_to_png_data_url(w: u32, h: u32, rgba: &[u8]) -> Option<String> {
    let mut out = Vec::new();
    {
        let mut enc = png::Encoder::new(&mut out, w, h);
        enc.set_color(png::ColorType::Rgba);
        enc.set_depth(png::BitDepth::Eight);
        let mut writer = enc.write_header().ok()?;
        writer.write_image_data(rgba).ok()?;
    }
    let b64 = base64::engine::general_purpose::STANDARD.encode(&out);
    Some(format!("data:image/png;base64,{b64}"))
}
