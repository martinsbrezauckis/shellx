//! In-memory Safe Folder preview renderer.
//!
//! This module is intentionally lower-level than the desktop/UI lifecycle:
//! it accepts decrypted bytes from the owner-only broker path, renders a
//! preview in memory, and returns bytes to the trusted owner UI. It never
//! writes plaintext or raster previews to disk.

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};

const TEXT_PAGE_WIDTH: u32 = 960;
const TEXT_PAGE_HEIGHT: u32 = 1240;
const TEXT_MARGIN_X: u32 = 36;
const BODY_SCALE: u32 = 2;
const BODY_ADVANCE_X: u32 = 13;
const BODY_LINE_HEIGHT: u32 = 22;
const HEADER_SCALE: u32 = 3;
const HEADER_ADVANCE_X: u32 = 19;

const BG: [u8; 4] = [18, 18, 20, 255];
const PANEL: [u8; 4] = [28, 28, 31, 255];
const FG: [u8; 4] = [238, 238, 232, 255];
const MUTED: [u8; 4] = [176, 176, 168, 255];
const ACCENT: [u8; 4] = [214, 180, 94, 255];

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SafeRenderKind {
    RasterPage,
    MetadataOnly,
    Unsupported,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SafeRenderInput {
    pub display_name: String,
    pub media_type: String,
    pub plaintext: Vec<u8>,
    pub page_index: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SafeRenderedPreview {
    pub kind: SafeRenderKind,
    pub mime: String,
    pub bytes: Vec<u8>,
    pub width: u32,
    pub height: u32,
    pub page_index: usize,
    pub page_count: usize,
    pub summary: String,
    pub secret_exposed: bool,
}

pub fn render_safe_preview(input: SafeRenderInput) -> Result<SafeRenderedPreview> {
    let media = input.media_type.to_ascii_lowercase();
    if is_text_like(&media, &input.display_name) {
        return render_text_png(input);
    }
    if media == "application/pdf" {
        return Ok(metadata_only(
            input,
            "PDF raster preview is not enabled yet",
        ));
    }
    if media.starts_with("image/") {
        return Ok(metadata_only(input, "Image metadata preview only"));
    }
    if is_office_like(&media, &input.display_name) {
        return Ok(metadata_only(
            input,
            "Office raster preview is disabled until the hardened in-memory renderer is integrated",
        ));
    }
    Ok(metadata_only(input, "Binary preview is not supported"))
}

fn render_text_png(input: SafeRenderInput) -> Result<SafeRenderedPreview> {
    let text = String::from_utf8(input.plaintext)
        .context("safe folder text preview is not valid UTF-8")?;
    let lines = wrap_text(&text, body_columns());
    let lines_per_page = body_lines_per_page();
    let page_count = lines.len().max(1).div_ceil(lines_per_page);
    if input.page_index >= page_count {
        bail!("preview page out of range");
    }

    let start = input.page_index * lines_per_page;
    let end = (start + lines_per_page).min(lines.len());
    let mut rgba = vec![0u8; (TEXT_PAGE_WIDTH * TEXT_PAGE_HEIGHT * 4) as usize];
    fill(&mut rgba, BG);
    fill_rect(&mut rgba, 0, 0, TEXT_PAGE_WIDTH, 118, PANEL);
    fill_rect(&mut rgba, 0, 118, TEXT_PAGE_WIDTH, 2, ACCENT);
    draw_text_line(
        &mut rgba,
        TEXT_MARGIN_X,
        34,
        &input.display_name,
        HEADER_SCALE,
        HEADER_ADVANCE_X,
        ACCENT,
    );
    draw_text_line(
        &mut rgba,
        TEXT_MARGIN_X,
        86,
        &format!(
            "Safe preview page {} of {}",
            input.page_index + 1,
            page_count
        ),
        BODY_SCALE,
        BODY_ADVANCE_X,
        MUTED,
    );

    for (idx, line) in lines[start..end].iter().enumerate() {
        draw_text_line(
            &mut rgba,
            TEXT_MARGIN_X,
            150u32.saturating_add(
                u32::try_from(idx)
                    .unwrap_or(u32::MAX)
                    .saturating_mul(BODY_LINE_HEIGHT),
            ),
            line,
            BODY_SCALE,
            BODY_ADVANCE_X,
            FG,
        );
    }

    Ok(SafeRenderedPreview {
        kind: SafeRenderKind::RasterPage,
        mime: "image/png".to_string(),
        bytes: encode_png(TEXT_PAGE_WIDTH, TEXT_PAGE_HEIGHT, &rgba)?,
        width: TEXT_PAGE_WIDTH,
        height: TEXT_PAGE_HEIGHT,
        page_index: input.page_index,
        page_count,
        summary: format!(
            "Text preview page {} of {}",
            input.page_index + 1,
            page_count
        ),
        secret_exposed: false,
    })
}

fn metadata_only(input: SafeRenderInput, summary: &str) -> SafeRenderedPreview {
    SafeRenderedPreview {
        kind: SafeRenderKind::MetadataOnly,
        mime: "application/json".to_string(),
        bytes: Vec::new(),
        width: 0,
        height: 0,
        page_index: input.page_index,
        page_count: 1,
        summary: format!("{summary}; {} bytes", input.plaintext.len()),
        secret_exposed: false,
    }
}

fn is_text_like(media: &str, name: &str) -> bool {
    media.starts_with("text/")
        || media == "application/json"
        || media.ends_with("+json")
        || [
            ".md",
            ".markdown",
            ".txt",
            ".log",
            ".csv",
            ".json",
            ".toml",
            ".yaml",
            ".yml",
            ".rs",
            ".ts",
            ".tsx",
            ".js",
            ".jsx",
            ".py",
            ".go",
            ".java",
            ".cs",
            ".sh",
            ".ps1",
        ]
        .iter()
        .any(|suffix| name.to_ascii_lowercase().ends_with(suffix))
}

fn is_office_like(media: &str, name: &str) -> bool {
    matches!(
        media,
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
            | "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            | "application/vnd.openxmlformats-officedocument.presentationml.presentation"
    ) || [".docx", ".xlsx", ".pptx"]
        .iter()
        .any(|suffix| name.to_ascii_lowercase().ends_with(suffix))
}

fn body_columns() -> usize {
    ((TEXT_PAGE_WIDTH - TEXT_MARGIN_X * 2) / BODY_ADVANCE_X) as usize
}

fn body_lines_per_page() -> usize {
    ((TEXT_PAGE_HEIGHT - 170) / BODY_LINE_HEIGHT) as usize
}

fn fill(buf: &mut [u8], color: [u8; 4]) {
    for px in buf.chunks_exact_mut(4) {
        px.copy_from_slice(&color);
    }
}

fn fill_rect(buf: &mut [u8], x: u32, y: u32, width: u32, height: u32, color: [u8; 4]) {
    for yy in y..(y + height).min(TEXT_PAGE_HEIGHT) {
        for xx in x..(x + width).min(TEXT_PAGE_WIDTH) {
            set_px(buf, xx, yy, color);
        }
    }
}

fn wrap_text(text: &str, width: usize) -> Vec<String> {
    let mut out = Vec::new();
    for raw in text.lines() {
        let mut line = raw.trim_end().to_string();
        if line.is_empty() {
            out.push(String::new());
            continue;
        }
        while line.chars().count() > width {
            let mut split = line
                .char_indices()
                .nth(width)
                .map(|(idx, _)| idx)
                .unwrap_or(line.len());
            if let Some(space_idx) = line[..split].rfind(' ') {
                if space_idx > width / 2 {
                    split = space_idx;
                }
            }
            out.push(line[..split].trim_end().to_string());
            line = line[split..].trim_start().to_string();
        }
        out.push(line);
    }
    if out.is_empty() {
        out.push(String::new());
    }
    out
}

fn encode_png(width: u32, height: u32, rgba: &[u8]) -> Result<Vec<u8>> {
    let mut out = Vec::new();
    let mut encoder = png::Encoder::new(&mut out, width, height);
    encoder.set_color(png::ColorType::Rgba);
    encoder.set_depth(png::BitDepth::Eight);
    let mut writer = encoder.write_header()?;
    writer.write_image_data(rgba)?;
    drop(writer);
    Ok(out)
}

fn draw_text_line(
    buf: &mut [u8],
    x: u32,
    y: u32,
    text: &str,
    scale: u32,
    advance_x: u32,
    color: [u8; 4],
) {
    let mut cx = x;
    for ch in text.chars() {
        if cx + 6 * scale >= TEXT_PAGE_WIDTH {
            break;
        }
        draw_char(buf, cx, y, ch, scale, color);
        cx += advance_x;
    }
}

fn draw_char(buf: &mut [u8], x: u32, y: u32, ch: char, scale: u32, color: [u8; 4]) {
    let rows = glyph(ch);
    for (row, bits) in rows.iter().enumerate() {
        for col in 0..5u32 {
            if bits & (1 << (4 - col)) == 0 {
                continue;
            }
            fill_rect(
                buf,
                x.saturating_add(col.saturating_mul(scale)),
                y.saturating_add(u32::try_from(row).unwrap_or(u32::MAX).saturating_mul(scale)),
                scale,
                scale,
                color,
            );
        }
    }
}

fn set_px(buf: &mut [u8], x: u32, y: u32, color: [u8; 4]) {
    if x >= TEXT_PAGE_WIDTH || y >= TEXT_PAGE_HEIGHT {
        return;
    }
    let idx = ((y * TEXT_PAGE_WIDTH + x) * 4) as usize;
    buf[idx..idx + 4].copy_from_slice(&color);
}

fn glyph(ch: char) -> [u8; 7] {
    match ch.to_ascii_uppercase() {
        'A' => [
            0b01110, 0b10001, 0b10001, 0b11111, 0b10001, 0b10001, 0b10001,
        ],
        'B' => [
            0b11110, 0b10001, 0b10001, 0b11110, 0b10001, 0b10001, 0b11110,
        ],
        'C' => [
            0b01111, 0b10000, 0b10000, 0b10000, 0b10000, 0b10000, 0b01111,
        ],
        'D' => [
            0b11110, 0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b11110,
        ],
        'E' => [
            0b11111, 0b10000, 0b10000, 0b11110, 0b10000, 0b10000, 0b11111,
        ],
        'F' => [
            0b11111, 0b10000, 0b10000, 0b11110, 0b10000, 0b10000, 0b10000,
        ],
        'G' => [
            0b01111, 0b10000, 0b10000, 0b10111, 0b10001, 0b10001, 0b01111,
        ],
        'H' => [
            0b10001, 0b10001, 0b10001, 0b11111, 0b10001, 0b10001, 0b10001,
        ],
        'I' => [
            0b11111, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100, 0b11111,
        ],
        'J' => [
            0b00111, 0b00010, 0b00010, 0b00010, 0b10010, 0b10010, 0b01100,
        ],
        'K' => [
            0b10001, 0b10010, 0b10100, 0b11000, 0b10100, 0b10010, 0b10001,
        ],
        'L' => [
            0b10000, 0b10000, 0b10000, 0b10000, 0b10000, 0b10000, 0b11111,
        ],
        'M' => [
            0b10001, 0b11011, 0b10101, 0b10101, 0b10001, 0b10001, 0b10001,
        ],
        'N' => [
            0b10001, 0b11001, 0b10101, 0b10011, 0b10001, 0b10001, 0b10001,
        ],
        'O' => [
            0b01110, 0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b01110,
        ],
        'P' => [
            0b11110, 0b10001, 0b10001, 0b11110, 0b10000, 0b10000, 0b10000,
        ],
        'Q' => [
            0b01110, 0b10001, 0b10001, 0b10001, 0b10101, 0b10010, 0b01101,
        ],
        'R' => [
            0b11110, 0b10001, 0b10001, 0b11110, 0b10100, 0b10010, 0b10001,
        ],
        'S' => [
            0b01111, 0b10000, 0b10000, 0b01110, 0b00001, 0b00001, 0b11110,
        ],
        'T' => [
            0b11111, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100,
        ],
        'U' => [
            0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b01110,
        ],
        'V' => [
            0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b01010, 0b00100,
        ],
        'W' => [
            0b10001, 0b10001, 0b10001, 0b10101, 0b10101, 0b10101, 0b01010,
        ],
        'X' => [
            0b10001, 0b10001, 0b01010, 0b00100, 0b01010, 0b10001, 0b10001,
        ],
        'Y' => [
            0b10001, 0b10001, 0b01010, 0b00100, 0b00100, 0b00100, 0b00100,
        ],
        'Z' => [
            0b11111, 0b00001, 0b00010, 0b00100, 0b01000, 0b10000, 0b11111,
        ],
        '0' => [
            0b01110, 0b10001, 0b10011, 0b10101, 0b11001, 0b10001, 0b01110,
        ],
        '1' => [
            0b00100, 0b01100, 0b00100, 0b00100, 0b00100, 0b00100, 0b01110,
        ],
        '2' => [
            0b01110, 0b10001, 0b00001, 0b00010, 0b00100, 0b01000, 0b11111,
        ],
        '3' => [
            0b11110, 0b00001, 0b00001, 0b01110, 0b00001, 0b00001, 0b11110,
        ],
        '4' => [
            0b00010, 0b00110, 0b01010, 0b10010, 0b11111, 0b00010, 0b00010,
        ],
        '5' => [
            0b11111, 0b10000, 0b10000, 0b11110, 0b00001, 0b00001, 0b11110,
        ],
        '6' => [
            0b00110, 0b01000, 0b10000, 0b11110, 0b10001, 0b10001, 0b01110,
        ],
        '7' => [
            0b11111, 0b00001, 0b00010, 0b00100, 0b01000, 0b01000, 0b01000,
        ],
        '8' => [
            0b01110, 0b10001, 0b10001, 0b01110, 0b10001, 0b10001, 0b01110,
        ],
        '9' => [
            0b01110, 0b10001, 0b10001, 0b01111, 0b00001, 0b00010, 0b01100,
        ],
        ' ' => [0, 0, 0, 0, 0, 0, 0],
        '.' => [0, 0, 0, 0, 0, 0b01100, 0b01100],
        ',' => [0, 0, 0, 0, 0, 0b01100, 0b01000],
        ':' => [0, 0b01100, 0b01100, 0, 0b01100, 0b01100, 0],
        ';' => [0, 0b01100, 0b01100, 0, 0b01100, 0b01000, 0],
        '-' => [0, 0, 0, 0b11111, 0, 0, 0],
        '_' => [0, 0, 0, 0, 0, 0, 0b11111],
        '/' => [
            0b00001, 0b00010, 0b00010, 0b00100, 0b01000, 0b01000, 0b10000,
        ],
        '\\' => [
            0b10000, 0b01000, 0b01000, 0b00100, 0b00010, 0b00010, 0b00001,
        ],
        '(' => [
            0b00010, 0b00100, 0b01000, 0b01000, 0b01000, 0b00100, 0b00010,
        ],
        ')' => [
            0b01000, 0b00100, 0b00010, 0b00010, 0b00010, 0b00100, 0b01000,
        ],
        '[' => [
            0b01110, 0b01000, 0b01000, 0b01000, 0b01000, 0b01000, 0b01110,
        ],
        ']' => [
            0b01110, 0b00010, 0b00010, 0b00010, 0b00010, 0b00010, 0b01110,
        ],
        '{' => [
            0b00110, 0b00100, 0b00100, 0b01000, 0b00100, 0b00100, 0b00110,
        ],
        '}' => [
            0b01100, 0b00100, 0b00100, 0b00010, 0b00100, 0b00100, 0b01100,
        ],
        '\'' => [0b00100, 0b00100, 0b01000, 0, 0, 0, 0],
        '"' => [0b01010, 0b01010, 0b01010, 0, 0, 0, 0],
        '`' => [0b01000, 0b00100, 0b00010, 0, 0, 0, 0],
        '!' => [0b00100, 0b00100, 0b00100, 0b00100, 0, 0b00100, 0],
        '?' => [0b01110, 0b10001, 0b00001, 0b00010, 0b00100, 0, 0b00100],
        '@' => [
            0b01110, 0b10001, 0b10111, 0b10101, 0b10111, 0b10000, 0b01110,
        ],
        '#' => [
            0b01010, 0b01010, 0b11111, 0b01010, 0b11111, 0b01010, 0b01010,
        ],
        '$' => [
            0b00100, 0b01111, 0b10100, 0b01110, 0b00101, 0b11110, 0b00100,
        ],
        '%' => [
            0b11001, 0b11010, 0b00010, 0b00100, 0b01000, 0b01011, 0b10011,
        ],
        '&' => [
            0b01100, 0b10010, 0b10100, 0b01000, 0b10101, 0b10010, 0b01101,
        ],
        '*' => [0, 0b10101, 0b01110, 0b11111, 0b01110, 0b10101, 0],
        '+' => [0, 0b00100, 0b00100, 0b11111, 0b00100, 0b00100, 0],
        '=' => [0, 0, 0b11111, 0, 0b11111, 0, 0],
        '<' => [
            0b00010, 0b00100, 0b01000, 0b10000, 0b01000, 0b00100, 0b00010,
        ],
        '>' => [
            0b01000, 0b00100, 0b00010, 0b00001, 0b00010, 0b00100, 0b01000,
        ],
        '|' => [
            0b00100, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100,
        ],
        '~' => [0, 0, 0b01000, 0b10101, 0b00010, 0, 0],
        '^' => [0b00100, 0b01010, 0b10001, 0, 0, 0, 0],
        _ => [
            0b11111, 0b10001, 0b00110, 0b00100, 0b01100, 0b10001, 0b11111,
        ],
    }
}
