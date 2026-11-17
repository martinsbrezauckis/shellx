//! Capture the exact Tauri X11 drawable. Never substitute desktop pixels.
use x11rb::connection::Connection;
use x11rb::protocol::xproto::{
    AtomEnum, ConnectionExt, ImageFormat, ImageOrder, MapState, VisualClass, WindowClass,
};
use x11rb::rust_connection::RustConnection;

type CaptureResult<T> = Result<T, Box<dyn std::error::Error + Send + Sync>>;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Rect {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
}

impl Rect {
    fn overlaps(self, other: Self) -> bool {
        i64::from(self.x) < i64::from(other.x) + i64::from(other.width)
            && i64::from(other.x) < i64::from(self.x) + i64::from(self.width)
            && i64::from(self.y) < i64::from(other.y) + i64::from(other.height)
            && i64::from(other.y) < i64::from(self.y) + i64::from(self.height)
    }
}

fn bounds(conn: &RustConnection, window: u32, root: u32) -> CaptureResult<Rect> {
    let geometry = conn.get_geometry(window)?.reply()?;
    let origin = conn.translate_coordinates(window, root, 0, 0)?.reply()?;
    if !origin.same_screen {
        return Err("window is on another X screen".into());
    }
    Ok(Rect {
        x: i32::from(origin.dst_x),
        y: i32::from(origin.dst_y),
        width: u32::from(geometry.width),
        height: u32::from(geometry.height),
    })
}

/// XGetImage has undefined pixels for obscured window regions. Reject an
/// overlapping mapped sibling anywhere in the target's ancestor chain.
fn visible_bounds(conn: &RustConnection, window: u32, root: u32) -> CaptureResult<Rect> {
    let attrs = conn.get_window_attributes(window)?.reply()?;
    if attrs.map_state != MapState::VIEWABLE || attrs.class != WindowClass::INPUT_OUTPUT {
        return Err("native screenshot window is not viewable".into());
    }
    let target = bounds(conn, window, root)?;
    let screen = conn.get_geometry(root)?.reply()?;
    if target.x < 0
        || target.y < 0
        || target.width == 0
        || target.height == 0
        || i64::from(target.x) + i64::from(target.width) > i64::from(screen.width)
        || i64::from(target.y) + i64::from(target.height) > i64::from(screen.height)
    {
        return Err("native screenshot window is outside its X screen".into());
    }
    let mut child = window;
    for _ in 0..32 {
        let tree = conn.query_tree(child)?.reply()?;
        if tree.parent == 0 {
            return Err("native screenshot window lost its X parent".into());
        }
        let siblings = conn.query_tree(tree.parent)?.reply()?;
        let position = siblings
            .children
            .iter()
            .position(|id| *id == child)
            .ok_or("native screenshot window moved during inspection")?;
        for sibling in &siblings.children[position + 1..] {
            let attrs = conn.get_window_attributes(*sibling)?.reply()?;
            if attrs.map_state != MapState::VIEWABLE || attrs.class != WindowClass::INPUT_OUTPUT {
                continue;
            }
            let mut rect = bounds(conn, *sibling, root)?;
            let border = u32::from(conn.get_geometry(*sibling)?.reply()?.border_width);
            rect.x -= border as i32;
            rect.y -= border as i32;
            rect.width += border * 2;
            rect.height += border * 2;
            if target.overlaps(rect) {
                return Err("native screenshot window is obscured by another window".into());
            }
        }
        if tree.parent == root {
            return Ok(target);
        }
        child = tree.parent;
    }
    Err("native screenshot window ancestor depth exceeded".into())
}

fn capture(window: u32) -> CaptureResult<xcap::image::RgbaImage> {
    let (conn, _) = x11rb::connect(None)?;
    let geometry = conn.get_geometry(window)?.reply()?;
    let pid_atom = conn.intern_atom(true, b"_NET_WM_PID")?.reply()?.atom;
    let pid = conn
        .get_property(false, window, pid_atom, AtomEnum::CARDINAL, 0, 1)?
        .reply()?;
    if pid.value32().and_then(|mut values| values.next()) != Some(std::process::id()) {
        return Err("native screenshot window PID does not match ShellX".into());
    }
    let before = visible_bounds(&conn, window, geometry.root)?;
    if u64::from(before.width) * u64::from(before.height) > 32 * 1024 * 1024 {
        return Err("native screenshot exceeds pixel limit".into());
    }
    let reply = conn
        .get_image(
            ImageFormat::Z_PIXMAP,
            window,
            0,
            0,
            before.width.try_into()?,
            before.height.try_into()?,
            u32::MAX,
        )?
        .reply()?;
    if visible_bounds(&conn, window, geometry.root)? != before {
        return Err("native screenshot window moved during capture".into());
    }
    let setup = conn.setup();
    let format = setup
        .pixmap_formats
        .iter()
        .find(|format| format.depth == reply.depth)
        .ok_or("native screenshot pixel format is missing")?;
    let visual = setup
        .roots
        .iter()
        .flat_map(|screen| &screen.allowed_depths)
        .flat_map(|depth| &depth.visuals)
        .find(|visual| visual.visual_id == reply.visual)
        .ok_or("native screenshot visual is missing")?;
    if visual.class != VisualClass::TRUE_COLOR
        || ![16, 24, 32].contains(&format.bits_per_pixel)
        || ![8, 16, 32].contains(&format.scanline_pad)
    {
        return Err("native screenshot pixel format is unsupported".into());
    }
    let bytes_per_pixel = usize::from(format.bits_per_pixel) / 8;
    let pad = usize::from(format.scanline_pad);
    let stride =
        (before.width as usize * usize::from(format.bits_per_pixel)).div_ceil(pad) * pad / 8;
    if reply.data.len() < stride * before.height as usize {
        return Err("native screenshot pixel data is truncated".into());
    }
    let masks = [visual.red_mask, visual.green_mask, visual.blue_mask];
    for mask in masks {
        let shifted = mask.checked_shr(mask.trailing_zeros()).unwrap_or(0);
        if shifted == 0 || shifted & shifted.wrapping_add(1) != 0 {
            return Err("native screenshot color mask is unsupported".into());
        }
    }
    let mut rgba = Vec::with_capacity(before.width as usize * before.height as usize * 4);
    for y in 0..before.height as usize {
        for x in 0..before.width as usize {
            let offset = y * stride + x * bytes_per_pixel;
            let bytes = &reply.data[offset..offset + bytes_per_pixel];
            let mut pixel = 0_u32;
            if setup.image_byte_order == ImageOrder::LSB_FIRST {
                for (index, byte) in bytes.iter().enumerate() {
                    pixel |= u32::from(*byte) << (index * 8);
                }
            } else {
                for byte in bytes {
                    pixel = (pixel << 8) | u32::from(*byte);
                }
            }
            for mask in masks {
                let shift = mask.trailing_zeros();
                let value = (pixel & mask) >> shift;
                rgba.push((u64::from(value) * 255 / u64::from(mask >> shift)) as u8);
            }
            rgba.push(255);
        }
    }
    xcap::image::RgbaImage::from_raw(before.width, before.height, rgba)
        .ok_or_else(|| "native screenshot pixel dimensions do not match".into())
}

pub(super) fn capture_x11_window(window: u32) -> Result<xcap::image::RgbaImage, String> {
    capture(window).map_err(|error| format!("exact native X11 capture failed: {error}"))
}
