// Service worker: owns the network call to the Gloss server, so pages never see keys and CORS never applies.

const DEFAULTS = { base: "https://gloss-lovat.vercel.app", apiKey: "", length: "normal", search: true };

async function settings() {
  const s = await chrome.storage.local.get(DEFAULTS);
  return { ...DEFAULTS, ...s, base: String(s.base || DEFAULTS.base).replace(/\/+$/, "") };
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({ id: "gloss-ask", title: "Ask Gloss about “%s”", contexts: ["selection"] });
});

function openOn(tabId) {
  chrome.tabs.sendMessage(tabId, { type: "gloss:open" }).catch(() => {});
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === "gloss-ask" && tab?.id != null) openOn(tab.id);
});

chrome.commands.onCommand.addListener(async (cmd) => {
  if (cmd !== "ask-selection") return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id != null) openOn(tab.id);
});

// Content scripts connect on a port per question and get the server's SSE events relayed back.
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "ask") return;
  const ctrl = new AbortController();
  let live = true;
  port.onDisconnect.addListener(() => {
    live = false;
    ctrl.abort();
  });
  port.onMessage.addListener(async (msg) => {
    if (msg.type === "stop") return ctrl.abort();
    if (msg.type !== "ask") return;
    const post = (e) => live && port.postMessage(e);
    try {
      const s = await settings();
      const body = { ...msg.body, apiKey: s.apiKey || undefined, length: s.length, search: s.search };
      const res = await fetch(`${s.base}/api/ask`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      if (!res.ok || !res.body) {
        let error = `Request failed (${res.status}).`;
        let needKey = false;
        try {
          const j = await res.json();
          error = j.error || error;
          needKey = j.code === "need_key";
        } catch {}
        post({ type: "error", text: error, needKey });
        return;
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const frames = buf.split("\n\n");
        buf = frames.pop() ?? "";
        for (const f of frames) {
          if (!f.startsWith("data:")) continue;
          try {
            post(JSON.parse(f.slice(5).trim()));
          } catch {}
        }
      }
      post({ type: "done" });
    } catch (e) {
      if (!ctrl.signal.aborted) post({ type: "error", text: `Connection lost: ${String(e)}` });
    }
  });
});
