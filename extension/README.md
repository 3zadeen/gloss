# Gloss for every tab

A Chrome (Manifest V3) extension that brings Gloss to any page. Highlight text, press **✦ Ask Gloss**
(or `Ctrl/⌘+Shift+G`, or right-click → *Ask Gloss about…*), and the answer streams into a panel
beside the page, citing the paragraphs it used. Click a `¶n` chip to scroll to and flash that paragraph.

It talks to the existing `/api/ask` route, so prompts, models, web search, and the free daily allowance
all behave exactly as in the web app. No server changes are needed.

## Load it

1. Open `chrome://extensions`, turn on **Developer mode**.
2. **Load unpacked** and pick this `extension/` folder.
3. Open the extension's **Options** to point it at your deployment (default `https://gloss-lovat.vercel.app`,
   or `http://localhost:3100` while running `npm run dev`) and optionally paste a Together AI key.

## How it works

- `content.js` runs on every http(s) page. It numbers the page's visible text blocks (`p, li, h1-h4,
  blockquote, pre, td`, skipping nav/aside/footer), finds the paragraphs your selection spans, and sends
  `{ doc, thread, history }` in the same shape the web app uses. Very long pages are windowed around the selection.
- `background.js` (service worker) makes the network call and relays the server's SSE events back over a port,
  so keys never reach the page and CORS doesn't apply.
- The UI lives in a closed shadow root, so page styles can't affect it.

## Not done yet

- Saving answers to the Library (needs an extension-friendly auth path to `/api/sync`).
- PDFs opened in Chrome's built-in viewer (content scripts can't run there).
- Text inside iframes and shadow DOM on the page.
- Icons and Chrome Web Store packaging.
