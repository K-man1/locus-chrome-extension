// Apply user-selected theme to <html data-theme="…"> ASAP to avoid a flash.
(async () => {
  try {
    const { theme } = await chrome.storage.local.get("theme");
    const t = theme || "system";
    document.documentElement.setAttribute("data-theme", t);
  } catch {
    document.documentElement.setAttribute("data-theme", "system");
  }
})();
