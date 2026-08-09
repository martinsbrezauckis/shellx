pub(crate) fn browser_page_context_menu_initialization_script() -> &'static str {
    r#"
(() => {
  if (window.__shellxBrowserContextMenuInstalled) return;
  window.__shellxBrowserContextMenuInstalled = true;
  const MENU_ID = "__shellx_browser_context_menu";
  const removeMenu = () => document.getElementById(MENU_ID)?.remove?.();
  const linkHrefForEvent = (event) => {
    const target = event.target instanceof Element ? event.target : null;
    const anchor = target?.closest?.("a[href]");
    const href = anchor?.href || "";
    if (!href || /^javascript:/i.test(href)) return "";
    return href;
  };
  const positionMenu = (menu, event) => {
    const x = Math.max(8, Math.min(event.clientX, window.innerWidth - 190));
    const y = Math.max(8, Math.min(event.clientY, window.innerHeight - 46));
    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;
  };
  document.addEventListener("contextmenu", (event) => {
    const href = linkHrefForEvent(event);
    if (!href) return;
    event.preventDefault();
    event.stopPropagation();
    removeMenu();
    const menu = document.createElement("div");
    menu.id = MENU_ID;
    menu.setAttribute("data-shellx-browser-context-menu", "true");
    menu.style.cssText = [
      "position:fixed",
      "z-index:2147483647",
      "min-width:180px",
      "padding:4px",
      "border:1px solid rgba(120,130,150,.35)",
      "border-radius:6px",
      "background:rgba(18,20,24,.98)",
      "color:#f5f7fb",
      "box-shadow:0 12px 32px rgba(0,0,0,.35)",
      "font:13px system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif"
    ].join(";");
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "Open link in new tab";
    button.setAttribute("data-shellx-browser-context-action", "open-link-new-tab");
    button.style.cssText = [
      "display:block",
      "width:100%",
      "border:0",
      "border-radius:4px",
      "padding:7px 10px",
      "background:transparent",
      "color:inherit",
      "text-align:left",
      "cursor:pointer",
      "font:inherit"
    ].join(";");
    button.addEventListener("mouseenter", () => { button.style.background = "rgba(255,255,255,.12)"; });
    button.addEventListener("mouseleave", () => { button.style.background = "transparent"; });
    button.addEventListener("click", (clickEvent) => {
      clickEvent.preventDefault();
      clickEvent.stopPropagation();
      removeMenu();
      window.open(href, "_blank", "noopener,noreferrer");
    });
    menu.appendChild(button);
    positionMenu(menu, event);
    document.documentElement.appendChild(menu);
  }, true);
  document.addEventListener("pointerdown", (event) => {
    if (!(event.target instanceof Element) || !event.target.closest(`#${MENU_ID}`)) removeMenu();
  }, true);
  window.addEventListener("blur", removeMenu);
  window.addEventListener("scroll", removeMenu, true);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") removeMenu();
  }, true);
})()
"#
}
