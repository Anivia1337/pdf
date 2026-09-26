# PDF Editor

Combine, reorder, rotate, and annotate PDFs entirely in your browser. Nothing
is uploaded — every file is processed client-side and never leaves your device.

**Live:** https://anivia.ch/pdf

## Features

- **Merge** — add several PDFs and combine them into one
- **Reorder** — drag pages into any order
- **Rotate** — a page, all pages, left/right; reverse page order
- **Duplicate / delete** pages, insert **blank** pages
- **Annotate** — draw and add text with adjustable colour, font size, stroke width
- **Undo**, multi-select, select all
- Light/dark theme, keyboard shortcuts

## Privacy

No server, no upload, no tracking. A strict `Content-Security-Policy`
(`default-src 'none'`) blocks all external requests — the page can only talk to
itself. Your PDFs are opened, edited, and saved locally in the browser.

## Tech

Static HTML/CSS/JS, no build step. Rendering via [pdf.js](https://github.com/mozilla/pdf.js),
writing via [pdf-lib](https://github.com/Hopding/pdf-lib) — both vendored in `vendor/`.

## Run locally

Serve the folder under the path `/pdf/` (assets use absolute `/pdf/...` paths):

```
python3 -m http.server 8000   # then open http://localhost:8000/pdf/
```

Or drop it in a webroot at `/pdf`. `.htaccess` sets the CSP and cache headers for Apache.
