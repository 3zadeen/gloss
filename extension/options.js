const DEFAULTS = { base: "https://gloss-lovat.vercel.app", apiKey: "", length: "normal", search: true };
const $ = (id) => document.getElementById(id);

chrome.storage.local.get(DEFAULTS).then((s) => {
  $("base").value = s.base;
  $("apiKey").value = s.apiKey;
  $("length").value = s.length;
  $("search").checked = s.search;
});

$("save").addEventListener("click", async () => {
  const status = $("status");
  let base = $("base").value.trim().replace(/\/+$/, "") || DEFAULTS.base;
  try {
    const u = new URL(base);
    base = u.origin;
    const origins = [`${u.origin}/*`];
    const has = await chrome.permissions.contains({ origins });
    if (!has && !(await chrome.permissions.request({ origins }))) {
      status.textContent = "Permission for that server was declined.";
      return;
    }
  } catch {
    status.textContent = "That is not a valid URL.";
    return;
  }
  await chrome.storage.local.set({
    base,
    apiKey: $("apiKey").value.trim(),
    length: $("length").value,
    search: $("search").checked,
  });
  status.textContent = "Saved.";
  setTimeout(() => (status.textContent = ""), 2000);
});
