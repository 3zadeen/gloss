// End-to-end test: real Chromium + the extension + a mock Gloss server that speaks the real /api/ask SSE protocol.
//
//   npm i -D playwright && npx playwright install chromium
//   node extension/test/e2e.cjs            (CHROME_PATH=/path/to/chrome to use a specific binary)
//
// The test loads a temporary copy of the extension with its shadow root set to "open" so Playwright can
// query the panel; everything else is the shipped source. Ports 8123 (pages) and 3100 (mock API) must be free.
const { chromium } = require("playwright");
const os = require("os");
const http = require("http");
const path = require("path");
const fs = require("fs");
const assert = require("assert");

const HERE = fs.mkdtempSync(path.join(os.tmpdir(), "gloss-ext-test-"));
const EXT = path.join(HERE, "ext");
fs.cpSync(path.join(__dirname, ".."), EXT, { recursive: true, filter: (p) => !p.includes(`${path.sep}test`) });
const content = path.join(EXT, "content.js");
fs.writeFileSync(content, fs.readFileSync(content, "utf8").replace('mode: "closed"', 'mode: "open"'));
const requests = [];
const results = [];
const check = (name, fn) => Promise.resolve().then(fn).then(
  () => { results.push([true, name]); console.log("PASS", name); },
  (e) => { results.push([false, name]); console.log("FAIL", name, "\n   ", String(e.message).split("\n")[0]); }
);

// ---- pages ----
const para = (i) => `Paragraph ${i} of the essay. ` + "The quick brown fox explores an idea in careful detail, then returns to the argument. ".repeat(2);
const article = (count) => `<!doctype html><html><head><title>Test Essay</title><meta name="author" content="A. Writer"></head><body>
<header><nav>Home About Contact navigation links that should be skipped entirely</nav></header>
<main><article><h1>On Foxes and Ideas</h1>
${Array.from({ length: count }, (_, i) => `<p id="p${i + 1}">${para(i + 1)}</p>`).join("\n")}
</article></main>
<aside>SIDEBAR TEXT that is long enough to be a paragraph but belongs to an aside element</aside>
<footer>FOOTER TEXT that is also long enough to look like a paragraph of content here</footer></body></html>`;

const pageServer = http.createServer((req, res) => {
  res.setHeader("Content-Type", "text/html");
  res.end(req.url.startsWith("/long") ? article(800) : article(30));
});

// ---- mock Gloss API ----
const apiServer = http.createServer((req, res) => {
  if (req.method !== "POST" || req.url !== "/api/ask") { res.statusCode = 404; return res.end(); }
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", async () => {
    const body = JSON.parse(raw);
    requests.push(body);
    if (body.thread?.question === "boom") {
      res.statusCode = 429;
      res.setHeader("Content-Type", "application/json");
      return res.end(JSON.stringify({ error: "Today's free answers are used up.", code: "need_key" }));
    }
    res.setHeader("Content-Type", "text/event-stream");
    const send = (e) => res.write(`data: ${JSON.stringify(e)}\n\n`);
    send({ type: "meta", model: "mock" });
    send({ type: "searching" });
    send({ type: "sources", sources: [{ n: 1, title: "Example Source", url: "https://example.com/a", site: "example.com" }] });
    const parts = ["==It is a joke ", "at his own expense.== See [¶3] and the source [1].\n\n", "- point one [¶5]\n- point two with <b>html</b>"];
    for (const p of parts) { send({ type: "content", text: p }); await new Promise((r) => setTimeout(r, 40)); }
    send({ type: "usage", usage: { promptTokens: 1, cachedTokens: 0, completionTokens: 1, costUsd: 0 } });
    send({ type: "done" });
    res.end();
  });
});

(async () => {
  await new Promise((r) => pageServer.listen(8123, r));
  await new Promise((r) => apiServer.listen(3100, r));

  const ctx = await chromium.launchPersistentContext(path.join(HERE, "profile"), {
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
    headless: false,
    viewport: { width: 1100, height: 800 },
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, "--headless=new", "--no-sandbox"],
  });
  const errors = [];
  let sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent("serviceworker", { timeout: 15000 }));
  const extId = new URL(sw.url()).host;
  await sw.evaluate(() => chrome.storage.local.set({ base: "http://localhost:3100" }));
  console.log("extension id:", extId);

  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  page.on("console", (m) => m.type() === "error" && errors.push("console: " + m.text()));
  await page.goto("http://localhost:8123/article.html");

  const selectPara = async (id) => {
    await page.evaluate((id) => {
      const el = document.getElementById(id);
      const r = document.createRange();
      r.selectNodeContents(el);
      const s = getSelection(); s.removeAllRanges(); s.addRange(r);
      el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, composed: true }));
    }, id);
  };
  const selectRange = async (a, b) => {
    await page.evaluate(([a, b]) => {
      const r = document.createRange();
      r.setStart(document.getElementById(a).firstChild, 5);
      r.setEnd(document.getElementById(b).firstChild, 20);
      const s = getSelection(); s.removeAllRanges(); s.addRange(r);
      document.getElementById(b).dispatchEvent(new MouseEvent("mouseup", { bubbles: true, composed: true }));
    }, [a, b]);
  };

  // 1. button appears
  await check("Ask button appears on selection", async () => {
    await selectPara("p3");
    await page.locator(".btn").waitFor({ state: "visible", timeout: 5000 });
  });

  // 2. open panel, quote shown
  await check("clicking Ask opens the panel with the quote", async () => {
    await page.locator(".btn").click();
    await page.locator(".panel").waitFor({ state: "visible" });
    const q = await page.locator(".quote").innerText();
    assert(q.includes("Paragraph 3 of the essay"), "quote was: " + q);
  });

  // 3. Explain chip: request shape + rendering
  await check("Explain sends the right payload", async () => {
    requests.length = 0;
    await page.locator(".chip", { hasText: "Explain" }).click();
    await page.locator(".body .cite").first().waitFor({ timeout: 8000 });
    await page.waitForTimeout(300);
    const r = requests[0];
    assert(r, "no request received");
    assert.equal(r.thread.action, "explain");
    assert.equal(r.thread.from, 4, "from=" + r.thread.from); // h1 is ¶1, so p3 is ¶4
    assert.equal(r.thread.to, 4);
    assert.equal(r.doc.title, "Test Essay");
    assert.equal(r.doc.author, "A. Writer");
    assert.equal(r.doc.paras[0].n, 1);
    assert.equal(r.length, "normal");
    const all = r.doc.paras.map((p) => p.text).join(" ");
    assert(!all.includes("SIDEBAR") && !all.includes("FOOTER") && !all.includes("navigation links"), "skipped regions leaked in");
    assert(r.doc.paras.length >= 30, "paras=" + r.doc.paras.length);
  });
  await check("answer renders: highlight, cites, source link, list, no raw HTML injection", async () => {
    const html = await page.locator(".body").innerHTML();
    assert(html.includes("<mark>It is a joke at his own expense.</mark>"), "mark missing");
    assert((await page.locator(".body .cite").count()) === 2, "cite count");
    assert(await page.locator('.body a.src[href="https://example.com/a"]').count(), "source link");
    assert(await page.locator(".body ul li").count() === 2, "list items");
    assert(!html.includes("<b>html</b>") && html.includes("&lt;b&gt;html&lt;/b&gt;"), "html not escaped");
    assert((await page.locator(".foot a").count()) === 1, "footer sources");
  });

  // 4. citation click scrolls + flashes
  await check("clicking a ¶ chip scrolls to and highlights that paragraph", async () => {
    await page.evaluate(() => scrollTo(0, 0));
    await page.locator(".cite", { hasText: "¶5" }).click();
    await page.waitForTimeout(900);
    const info = await page.evaluate(() => {
      const el = document.getElementById("p4"); // ¶5
      const r = el.getBoundingClientRect();
      return { outline: el.style.outline, inView: r.top >= 0 && r.bottom <= innerHeight };
    });
    assert(info.outline.includes("2px"), "no outline: " + info.outline);
    assert(info.inView, "p4 (¶5) not scrolled into view");
    await page.waitForTimeout(2000);
    assert.equal(await page.evaluate(() => document.getElementById("p4").style.outline), "", "outline not restored");
  });

  // 5. follow-up carries history incl. first answer
  await check("follow-up sends history starting with the first answer", async () => {
    requests.length = 0;
    await page.locator("input").fill("why is that funny?");
    await page.locator("input").press("Enter");
    await page.waitForFunction(() => document.querySelector("gloss-ext-root").shadowRoot.querySelector(".body").innerText.includes("why is that funny?"));
    await page.waitForTimeout(600);
    const r = requests[0];
    assert(r, "no request");
    assert.deepEqual(r.history.map((m) => m.role), ["assistant", "user"]);
    assert(r.history[0].content.includes("It is a joke"), "first answer missing");
    assert.equal(r.history[1].content, "why is that funny?");
    const body = await page.locator(".body").innerText();
    assert(body.includes("why is that funny?") && (body.match(/It is a joke/g) || []).length >= 2, "previous turn not kept on screen");
  });

  // 6. error path
  await check("server error shows message and key hint", async () => {
    await page.locator(".x").click();
    await selectPara("p7");
    await page.locator(".btn").click();
    await page.locator("input").fill("boom");
    await page.locator("input").press("Enter");
    await page.locator(".err").waitFor({ timeout: 5000 });
    const t = await page.locator(".err").innerText();
    assert(t.includes("free answers") && t.includes("Together AI key"), t);
  });

  // 7. multi-paragraph selection
  await check("multi-paragraph selection maps to from/to", async () => {
    await page.locator(".x").click();
    requests.length = 0;
    await selectRange("p10", "p12");
    await page.locator(".btn").click();
    await page.locator(".chip", { hasText: "Simplify" }).click();
    await page.waitForFunction(() => document.querySelector("gloss-ext-root").shadowRoot.querySelector(".cite"));
    const t = requests[0].thread;
    assert.equal(t.from, 11, "from=" + t.from); // p10 is ¶11
    assert.equal(t.to, 13, "to=" + t.to);
    assert(t.quote.includes("Paragraph 12") || t.quote.length > 100, "quote");
  });

  // 8. Escape closes
  await check("Escape closes the panel", async () => {
    await page.keyboard.press("Escape");
    await page.waitForTimeout(100);
    assert(!(await page.locator(".panel").isVisible()));
  });

  // 9. selection inside our own UI doesn't spawn a button; clicking away hides it
  await check("button hides when clicking elsewhere on the page", async () => {
    await selectPara("p2");
    await page.locator(".btn").waitFor({ state: "visible" });
    await page.mouse.click(5, 5);
    await page.waitForTimeout(150);
    assert(!(await page.locator(".btn").isVisible()));
  });

  // 10. long page is windowed around the selection
  await check("very long page is windowed and keeps the selected paragraph", async () => {
    const lp = await ctx.newPage();
    await lp.goto("http://localhost:8123/long.html");
    requests.length = 0;
    await lp.evaluate(() => {
      const el = document.getElementById("p300");
      const r = document.createRange(); r.selectNodeContents(el);
      const s = getSelection(); s.removeAllRanges(); s.addRange(r);
      el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, composed: true }));
    });
    await lp.locator(".btn").click();
    await lp.locator(".chip", { hasText: "Explain" }).click();
    await lp.waitForFunction(() => document.querySelector("gloss-ext-root").shadowRoot.querySelector(".cite"));
    const r = requests[0];
    const size = r.doc.paras.reduce((a, p) => a + p.text.length, 0);
    assert.equal(r.doc.partial, true, "partial flag");
    assert(size <= 120000, "size " + size);
    assert(r.doc.paras.some((p) => p.n === 301 || p.text.startsWith("Paragraph 300 ")), "selected paragraph missing");
    const ns = r.doc.paras.map((p) => p.n);
    assert(Math.min(...ns) < 300 && Math.max(...ns) > 300, "window not centred");
    await lp.close();
  });

  // 11. options page loads defaults, saves key, key reaches the server
  await check("options page saves a key and it is sent with requests", async () => {
    await sw.evaluate(() => chrome.storage.local.remove("base")); // so the options page shows the shipped default
    const op = await ctx.newPage();
    await op.goto(`chrome-extension://${extId}/options.html`);
    assert.equal(await op.locator("#base").inputValue(), "https://gloss-lovat.vercel.app");
    await op.locator("#base").fill("http://localhost:3100");
    await op.locator("#apiKey").fill("tgp_test_key");
    await op.locator("#length").selectOption("short");
    await op.locator("#save").click();
    await op.waitForFunction(() => document.getElementById("status").textContent === "Saved.", null, { timeout: 5000 });
    await op.close();
    requests.length = 0;
    await selectPara("p4");
    await page.locator(".btn").click();
    await page.locator(".chip", { hasText: "Explain" }).click();
    await page.waitForFunction(() => document.querySelector("gloss-ext-root").shadowRoot.querySelector(".cite"));
    assert.equal(requests[0].apiKey, "tgp_test_key");
    assert.equal(requests[0].length, "short");
  });

  // 12. context-menu/shortcut path: background -> content message opens the panel
  await check("background 'gloss:open' message opens the panel on a fresh selection", async () => {
    await page.locator(".x").click();
    await selectPara("p6");
    await page.locator(".btn").waitFor({ state: "visible" });
    await page.mouse.click(5, 5); // hide the button but keep nothing selected? clicking clears selection
    await selectPara("p6");
    await page.bringToFront();
    await sw.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      await chrome.tabs.sendMessage(tab.id, { type: "gloss:open" });
    });
    await page.locator(".panel").waitFor({ state: "visible", timeout: 3000 });
    assert((await page.locator(".quote").innerText()).includes("Paragraph 6"));
  });

  await page.screenshot({ path: path.join(HERE, "panel.png") });
  console.log("screenshot:", path.join(HERE, "panel.png"));
  await check("no page or extension console errors", async () => assert.deepEqual(errors, []));

  await ctx.close();
  pageServer.close(); apiServer.close();
  const failed = results.filter((r) => !r[0]).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error("HARNESS ERROR", e); process.exit(2); });
