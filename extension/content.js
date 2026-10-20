// Content script: a floating Ask button on any selection, and a margin panel that streams the answer.
// Everything visual lives in a closed shadow root so the page's CSS can't touch it, and ours can't touch the page.

(() => {
  if (window.top !== window || window.__glossExt) return;
  window.__glossExt = true;

  const BUDGET = 120_000; // characters of page text sent per question
  const ACTIONS = [
    { id: "explain", label: "Explain" },
    { id: "simplify", label: "Simplify" },
    { id: "check", label: "Fact-check" },
    { id: "counter", label: "Counterpoint" },
    { id: "connect", label: "Related" },
  ];

  // ---------- page text, numbered like Gloss numbers paragraphs ----------

  const SKIP = "nav,aside,footer,header,script,style,noscript,form,button,select,[aria-hidden='true'],[role='navigation'],[role='banner'],[role='complementary']";
  const BLOCKS = "p,li,h1,h2,h3,h4,blockquote,pre,td";
  const norm = (s) => s.replace(/\s+/g, " ").trim();

  function collect() {
    const root = document.querySelector("article, main, [role='main']") || document.body;
    const out = [];
    for (const el of root.querySelectorAll(BLOCKS)) {
      if (el.closest(SKIP) || el.querySelector(BLOCKS)) continue;
      if (!el.getClientRects().length) continue;
      const text = norm(el.innerText || el.textContent || "");
      const min = /^H[1-4]$/.test(el.tagName) ? 3 : 25;
      if (text.length < min) continue;
      out.push({ n: out.length + 1, text, el });
    }
    return out;
  }

  function metaContent(sel) {
    return document.querySelector(sel)?.getAttribute("content")?.trim() || undefined;
  }

  /** Builds the payload for /api/ask and the from/to paragraph numbers of the selection. */
  function buildDoc(range, quote) {
    const paras = collect();
    const find = (node, edge) => {
      const el = node.nodeType === 1 ? node : node.parentElement;
      let hit = paras.find((p) => p.el.contains(el));
      if (!hit) {
        const snippet = norm(edge === "start" ? quote.slice(0, 80) : quote.slice(-80));
        hit = paras.find((p) => p.text.includes(snippet));
      }
      return hit?.n;
    };
    let from = find(range.startContainer, "start");
    let to = find(range.endContainer, "end");
    // A selection outside the numbered text (a chat bubble, a custom widget): add it as its own paragraph.
    if (!from) {
      const n = paras.length + 1;
      paras.push({ n, text: norm(quote), el: null });
      from = to = n;
    }
    if (!to || to < from) to = from;

    let used = paras.reduce((a, p) => a + p.text.length, 0);
    let chosen = paras;
    let partial = false;
    if (used > BUDGET) {
      partial = true;
      let lo = paras.findIndex((p) => p.n === from);
      let hi = lo;
      used = paras[lo].text.length;
      // Grow a window outward from the selection, alternating sides, until the budget is spent.
      let growBefore = true;
      for (;;) {
        const first = growBefore ? paras[lo - 1] : paras[hi + 1];
        const next = first ?? (growBefore ? paras[hi + 1] : paras[lo - 1]);
        if (!next || used + next.text.length > BUDGET) break;
        used += next.text.length;
        if (next === paras[lo - 1]) lo--;
        else hi++;
        growBefore = !growBefore;
      }
      chosen = paras.slice(lo, hi + 1);
    }
    return {
      paras,
      from,
      to,
      doc: {
        title: document.title || location.hostname,
        author: metaContent("meta[name='author']") || metaContent("meta[property='article:author']"),
        published: metaContent("meta[property='article:published_time']")?.slice(0, 10),
        paras: chosen.map(({ n, text }) => ({ n, text })),
        partial,
      },
    };
  }

  // ---------- UI ----------

  const host = document.createElement("gloss-ext-root");
  host.style.cssText = "all:initial;position:fixed;z-index:2147483647;top:0;left:0;width:0;height:0;";
  const root = host.attachShadow({ mode: "closed" });
  root.innerHTML = `
    <style>
      :host { all: initial; }
      * { box-sizing: border-box; }
      .btn { position: fixed; display: none; align-items: center; gap: 6px; padding: 6px 11px; border: 0; border-radius: 999px;
        background: #1c1a17; color: #faf8f4; font: 600 12.5px/1 Georgia, serif; cursor: pointer; box-shadow: 0 4px 16px rgba(0,0,0,.28); }
      .btn:hover { background: #2d2a25; }
      .panel { position: fixed; top: 16px; right: 16px; width: 380px; max-width: calc(100vw - 32px); max-height: calc(100vh - 32px);
        display: none; flex-direction: column; background: #faf8f4; color: #1c1a17; border: 1px solid #ddd6c8; border-radius: 12px;
        box-shadow: 0 12px 40px rgba(0,0,0,.25); font: 14.5px/1.55 Georgia, 'Iowan Old Style', serif; overflow: hidden; }
      @media (prefers-color-scheme: dark) {
        .panel { background: #1b1a17; color: #ece8e0; border-color: #36322c; }
        .quote { background: #24221e; } .chip { border-color: #4a453d; color: inherit; } .chip:hover { background: #2a2824; }
        input { background: #24221e; color: inherit; border-color: #3d3932; } .cite { background: #3a352c; color: #f0dca8; }
        mark { background: #5a4a1a; color: inherit; } .foot { border-color: #36322c; }
      }
      .head { display: flex; align-items: flex-start; gap: 8px; padding: 12px 14px 8px; }
      .quote { flex: 1; margin: 0; padding: 6px 10px; font-style: italic; font-size: 13px; opacity: .85; background: #f0ece3; border-radius: 6px;
        display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
      .x { border: 0; background: none; font-size: 20px; line-height: 1; cursor: pointer; color: inherit; opacity: .55; padding: 0 2px; }
      .x:hover { opacity: 1; }
      .chips { display: flex; flex-wrap: wrap; gap: 6px; padding: 0 14px 8px; }
      .chip { padding: 4px 10px; border: 1px solid #cfc8bb; border-radius: 999px; background: none; font: 12.5px Georgia, serif; cursor: pointer; color: inherit; }
      .chip:hover { background: #efe9dc; } .chip.on { background: #1c1a17; color: #faf8f4; border-color: #1c1a17; }
      .ask { display: flex; gap: 6px; padding: 0 14px 10px; }
      input { flex: 1; min-width: 0; padding: 7px 10px; border: 1px solid #cfc8bb; border-radius: 6px; font: 13.5px Georgia, serif; background: #fff; color: #1c1a17; }
      .go { padding: 0 12px; border: 0; border-radius: 6px; background: #1c1a17; color: #faf8f4; font: 600 12.5px Georgia, serif; cursor: pointer; }
      .body { padding: 2px 16px 12px; overflow: auto; flex: 1; min-height: 0; }
      .body:empty { display: none; }
      .body p { margin: 0 0 .7em; } .body ul { margin: 0 0 .7em; padding-left: 1.2em; }
      mark { background: #f6e3a1; color: inherit; padding: 0 2px; border-radius: 2px; }
      .cite { border: 0; border-radius: 4px; padding: 0 5px; margin: 0 1px; background: #efe3bd; color: #6a4f0c; font: 600 11.5px Georgia, serif; cursor: pointer; }
      .src { font-size: 11.5px; font-weight: 600; text-decoration: none; color: #2f6fb0; margin: 0 1px; }
      .note { font-size: 12.5px; opacity: .65; font-style: italic; }
      .err { color: #b3361f; font-size: 13px; }
      .foot { display: none; padding: 8px 16px 10px; border-top: 1px solid #e5dfd2; font-size: 12px; }
      .foot a { color: #2f6fb0; display: block; text-decoration: none; margin: 2px 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    </style>
    <button class="btn" type="button">✦ Ask Gloss</button>
    <section class="panel" aria-label="Gloss">
      <div class="head"><p class="quote"></p><button class="x" type="button" aria-label="Close">×</button></div>
      <div class="chips"></div>
      <form class="ask"><input placeholder="Ask anything about it…" /><button class="go" type="submit">Ask</button></form>
      <div class="body"></div>
      <div class="foot"></div>
    </section>`;
  document.documentElement.appendChild(host);

  const $ = (s) => root.querySelector(s);
  const btn = $(".btn");
  const panel = $(".panel");
  const quoteEl = $(".quote");
  const chipsEl = $(".chips");
  const input = $("input");
  const body = $(".body");
  const foot = $(".foot");

  for (const a of ACTIONS) {
    const c = document.createElement("button");
    c.type = "button";
    c.className = "chip";
    c.textContent = a.label;
    c.addEventListener("click", () => start(a.id));
    chipsEl.appendChild(c);
  }

  // ---------- selection tracking ----------

  /** The selection that opened the panel. Kept so a click elsewhere on the page doesn't lose it. */
  let current = null;
  let lastRect = null;

  function readSelection() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
    const quote = sel.toString().trim();
    if (quote.length < 2) return null;
    const range = sel.getRangeAt(0);
    return { quote, range: range.cloneRange(), rect: range.getBoundingClientRect() };
  }

  document.addEventListener("mouseup", (e) => {
    if (e.composedPath().includes(host)) return;
    setTimeout(() => {
      const s = readSelection();
      if (!s) return void (btn.style.display = "none");
      lastRect = s.rect;
      const x = Math.min(Math.max(8, s.rect.right - 6), window.innerWidth - 120);
      const y = Math.min(s.rect.bottom + 8, window.innerHeight - 40);
      btn.style.left = `${x}px`;
      btn.style.top = `${y}px`;
      btn.style.display = "flex";
    }, 0);
  });
  document.addEventListener("mousedown", (e) => {
    if (!e.composedPath().includes(host)) btn.style.display = "none";
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closePanel();
  });

  function openPanel() {
    const s = readSelection();
    if (s) {
      current = { ...s, thread: null };
      quoteEl.textContent = s.quote;
      body.innerHTML = "";
      foot.style.display = "none";
      for (const c of chipsEl.children) c.classList.remove("on");
      input.value = "";
      input.placeholder = "Ask anything about it…";
    } else if (!current) return;
    btn.style.display = "none";
    panel.style.display = "flex";
    input.focus();
  }
  function closePanel() {
    stop();
    panel.style.display = "none";
    btn.style.display = "none";
  }

  btn.addEventListener("mousedown", (e) => e.preventDefault()); // keep the page's selection alive
  btn.addEventListener("click", openPanel);
  $(".x").addEventListener("click", closePanel);
  chrome.runtime.onMessage.addListener((m) => m?.type === "gloss:open" && openPanel());

  // ---------- asking ----------

  let port = null;

  function stop() {
    if (port) {
      try {
        port.postMessage({ type: "stop" });
        port.disconnect();
      } catch {}
      port = null;
    }
  }

  $(".ask").addEventListener("submit", (e) => {
    e.preventDefault();
    const q = input.value.trim();
    if (!q) return;
    input.value = "";
    if (current?.thread) followUp(q);
    else start("ask", q);
  });

  function start(action, question) {
    if (!current) return;
    stop();
    const built = buildDoc(current.range, current.quote);
    current.thread = {
      built,
      payload: { action, quote: current.quote, from: built.from, to: built.to, question },
      turns: [], // after the first answer: alternating {role, content}
      sources: [],
    };
    for (const c of chipsEl.children) c.classList.toggle("on", c.textContent === ACTIONS.find((a) => a.id === action)?.label);
    input.placeholder = "Ask a follow-up…";
    run();
  }

  function followUp(q) {
    const t = current.thread;
    t.turns.push({ role: "user", content: q });
    run(`<p class="note">${esc(q)}</p>`);
  }

  function run(prefix = "") {
    const t = current.thread;
    const keep = t.turns.length ? body.innerHTML : "";
    let answer = "";
    let pending = 0;
    let state = { searching: false };
    t.sources = [];
    foot.style.display = "none";

    const paint = () => {
      pending = 0;
      const inner = answer ? renderAnswer(answer, t) : state.searching ? '<p class="note">Searching the web…</p>' : '<p class="note">Reading…</p>';
      body.innerHTML = keep + prefix + inner;
      body.scrollTop = body.scrollHeight;
    };
    paint();

    port = chrome.runtime.connect({ name: "ask" });
    const mine = port;
    port.onMessage.addListener((e) => {
      if (mine !== port) return;
      if (e.type === "content") {
        answer += e.text;
        if (!pending) pending = requestAnimationFrame(paint);
      } else if (e.type === "reset") answer = "";
      else if (e.type === "searching") {
        state.searching = true;
        paint();
      } else if (e.type === "sources") {
        t.sources = e.sources || [];
        state.searching = false;
        showSources(t.sources);
      } else if (e.type === "error") {
        body.innerHTML = keep + prefix + (answer ? renderAnswer(answer, t) : "") +
          `<p class="err">${esc(e.text)}${e.needKey ? " Add your Together AI key in the extension settings." : ""}</p>`;
      } else if (e.type === "done") {
        if (pending) cancelAnimationFrame(pending);
        paint();
        if (answer) t.turns.push({ role: "assistant", content: answer });
        port = null;
      }
    });
    port.onDisconnect.addListener(() => {
      if (mine === port) port = null;
    });
    port.postMessage({
      type: "ask",
      body: {
        doc: t.built.doc,
        thread: t.payload,
        // The server rebuilds the first user turn from `thread`, so history starts with the first answer.
        history: t.turns.slice(-12),
      },
    });
  }

  function showSources(list) {
    if (!list.length) return;
    foot.innerHTML = "";
    for (const s of list) {
      if (!/^https?:\/\//.test(s.url)) continue;
      const a = document.createElement("a");
      a.href = s.url;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.textContent = `${s.n}. ${s.title}${s.site ? ` (${s.site})` : ""}`;
      foot.appendChild(a);
    }
    foot.style.display = foot.children.length ? "block" : "none";
  }

  // ---------- rendering ----------

  function esc(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function inline(text, t) {
    let h = esc(text);
    h = h.replace(/==([^=]+)==/g, "<mark>$1</mark>");
    h = h.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    h = h.replace(/\[¶(\d+)\]/g, '<button class="cite" type="button" data-n="$1">¶$1</button>');
    h = h.replace(/\[(\d+)\]/g, (m, n) => {
      const s = t.sources.find((x) => String(x.n) === n);
      return s && /^https?:\/\//.test(s.url) ? `<a class="src" href="${esc(s.url)}" target="_blank" rel="noopener noreferrer">[${n}]</a>` : m;
    });
    return h;
  }

  function renderAnswer(text, t) {
    return text
      .split(/\n{2,}/)
      .map((chunk) => {
        const lines = chunk.split("\n").filter(Boolean);
        if (lines.length && lines.every((l) => /^\s*[-*]\s+/.test(l))) {
          return `<ul>${lines.map((l) => `<li>${inline(l.replace(/^\s*[-*]\s+/, ""), t)}</li>`).join("")}</ul>`;
        }
        return `<p>${lines.map((l) => inline(l, t)).join("<br>")}</p>`;
      })
      .join("");
  }

  // Clicking a ¶ chip scrolls the page to that paragraph and flashes it.
  body.addEventListener("click", (e) => {
    const b = e.target.closest?.(".cite");
    if (!b || !current?.thread) return;
    const p = current.thread.built.paras.find((x) => String(x.n) === b.dataset.n);
    if (!p?.el) return;
    p.el.scrollIntoView({ block: "center", behavior: "smooth" });
    const prev = { outline: p.el.style.outline, offset: p.el.style.outlineOffset, bg: p.el.style.backgroundColor, tr: p.el.style.transition };
    p.el.style.transition = "background-color .3s";
    p.el.style.outline = "2px solid #e0a82e";
    p.el.style.outlineOffset = "3px";
    p.el.style.backgroundColor = "rgba(246,227,161,.45)";
    setTimeout(() => {
      p.el.style.outline = prev.outline;
      p.el.style.outlineOffset = prev.offset;
      p.el.style.backgroundColor = prev.bg;
      p.el.style.transition = prev.tr;
    }, 2200);
  });
})();
