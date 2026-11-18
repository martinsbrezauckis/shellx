use super::BROWSER_DOM_TRAVERSAL_SCRIPT;

#[test]
fn traversal_is_bounded_and_same_origin_only() {
    assert!(BROWSER_DOM_TRAVERSAL_SCRIPT.contains("SHELLX_DOM_MAX_NODES = 12000"));
    assert!(BROWSER_DOM_TRAVERSAL_SCRIPT.contains("frameOrigin === location.origin"));
    assert!(BROWSER_DOM_TRAVERSAL_SCRIPT.contains("element.shadowRoot"));
    assert!(BROWSER_DOM_TRAVERSAL_SCRIPT.contains("current.parentNode === root"));
    assert!(BROWSER_DOM_TRAVERSAL_SCRIPT.contains("shellxResolveDomLocator"));
}
