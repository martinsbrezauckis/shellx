use super::*;

#[test]
fn full_page_scroll_positions_cover_last_viewport_without_overshoot() {
    assert_eq!(
        browser_page_capture_scroll_positions(1_829, 700),
        vec![0, 700, 1_129]
    );
    assert_eq!(browser_page_capture_scroll_positions(600, 700), vec![0]);
}

#[test]
fn full_page_capture_rejects_excessive_pixel_allocation() {
    assert!(validate_browser_page_capture_pixels(4_000, 8_000).is_ok());
    assert!(validate_browser_page_capture_pixels(4_001, 8_000).is_err());
}
