// Apply user-selected theme to <html data-theme="…"> ASAP to avoid a flash.
(async () => {
  try {
    const { theme } = await chrome.storage.local.get("theme");
    const t = theme || "system";
    const valid = new Set(["system", "light", "dark"]);
    document.documentElement.setAttribute("data-theme", valid.has(t) ? t : "system");
  } catch {
    document.documentElement.setAttribute("data-theme", "system");
  }
})();
