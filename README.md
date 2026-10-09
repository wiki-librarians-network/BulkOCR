# BulkOCR (ws-ocr.js)
A user script for **Wikisource** that OCRs every page of a book (Index page) in one go, using OCR through the Wikimedia OCR service.

**Author:** Manoj K ([User:Manojk](https://ml.wikisource.org/wiki/User:Manojk))
Wiki Librarians Network, as part of the Grandham Project Initiative

---

## Features

- **Whole-book OCR from the Index page** (സൂചിക:): no need to open each page's edit form.
- **Three modes**
  - **Semi-automatic:** see the scan and the OCR text side by side, correct it, then save and move to the next page. The next page is OCR'd in the background while you review.
  - **Fully automatic:** OCR and save every page in the chosen range without stopping.
  - **Dry run:** OCR only, nothing is saved; download all text as a `.txt` file.
- **Watermark removal:** strips lines such as "Digitized by Kerala Sahitya Akademi". The pattern list can be edited in the panel.
- **Blank pages** are created with the status **എഴുത്ത് ഇല്ലാത്തവ** (Without text).
- **Safe by default:** never touches pages that are Proofread, Validated or Problematic.
- **Resume support:** remembers the last page done for each book.
- **Progress and log:** progress bar, counts, and a per-page log with links.

---

## Installation

You need to be logged in to ml.wikisource.org. Choose **one** option.

### Option A – paste into your common.js

1. Open `https://ml.wikisource.org/wiki/User:<YourName>/common.js`
2. Click **Edit** (or **Create**).
3. Paste the full contents of `ws-ocr.js` (below any code already there) and save.

### Option B – load from a shared script page

If the script is hosted at `User:Manojk/ws-ocr.js`, add only this line to your own `common.js`:

```js
mw.loader.load('//ml.wikisource.org/w/index.php?title=User:Manojk/ws-ocr.js&action=raw&ctype=text/javascript');
```

Everyone using this line gets updates automatically whenever the script page is updated.

After installing, open any സൂചിക: page and press **Ctrl+Shift+R** to reload without cache.

---

## How to use

1. Open a book's Index page, e.g. `സൂചിക:Book.pdf`.
2. Click the blue **📄 BulkOCR – OCR this book** button above the page list (also available as **BulkOCR** in the *More* and *Tools* menus).
3. The panel shows the book's status, e.g. *312 pages · 280 not created · 30 not proofread · 2 proofread*.
4. Choose your settings and click **▶ Start**.

### Settings

| Setting | Description |
|---|---|
| **From / To** | Page range (file page numbers). |
| **Mode** | Semi-automatic, Fully automatic, or Dry run. |
| **Pages** | *Only pages that don't exist yet* (default), or also overwrite pages that are *Without text* / *Not proofread*. |
| **Langs** | Language hint for Google OCR (default `ml`). |
| **Width** | Scan image width sent to OCR (960 / 1280 / 1920 / 3840 px). Default 1920. Use a smaller size if images fail to load. |
| **Delay s** | Seconds to wait between pages in automatic and dry-run modes. Default 4. |
| **Summary** | Edit summary. Default: `Created Using BulkOCR Tool #ocrmlwikisource` |
| **Watermark removal** | On/off, plus the list of regex patterns (one per line). |

Settings are remembered in your browser.

### Buttons

| Button | Action |
|---|---|
| **▶ Start / Resume** | Start the run, or continue after a pause. |
| **⏸ Pause** | Pause after the current page. |
| **⏹ Stop** | Stop the run. |
| **↪ From last** | Set *From* to the page after the last one completed for this book. |
| **⬇ Download text** | (Dry run) Download all OCR text as one `.txt` file. |

### Review screen (semi-automatic mode)

| Button | Action |
|---|---|
| **💾 Save & next** (Ctrl+Enter) | Save the text as *Not proofread* and go to the next page. Saving an empty box saves the page as *എഴുത്ത് ഇല്ലാത്തവ*. |
| **Skip** | Leave this page and go to the next. |
| **🔄 Re-OCR** | Run OCR again for this page. |
| **⬜ Blank page** | Save the page as *എഴുത്ത് ഇല്ലാത്തവ* (Without text). |

---

## What gets saved

| OCR result | Page status | Edit summary |
|---|---|---|
| Text found | Not proofread (level 1) | `Created Using BulkOCR Tool #ocrmlwikisource` |
| Blank page | എഴുത്ത് ഇല്ലാത്തവ / Without text (level 0) | `/* എഴുത്ത് ഇല്ലാത്തവ */ Created Using BulkOCR Tool #ocrmlwikisource` |

Pages are saved with standard ProofreadPage markup, so they look the same as pages created from the normal editor.

---

## How it works

```
Index page (സൂചിക:)
  → list all page (താൾ:) titles and their status      [ProofreadPage API]
  → for each page in range:
      → get the scan image of that page                [MediaWiki imageinfo API]
      → OCR with Google                                [ocr.wmcloud.org – same as the editor's OCR button]
      → remove watermark lines
      → (semi mode: you review and edit)
      → save the page                                  [MediaWiki edit API]
```

The script does not click buttons in the editor; it talks directly to the wiki and OCR services, so it works on a whole book from one browser tab.

---

## Safety

- Only creates **new** pages by default.
- With the overwrite option, only replaces pages that are *Without text* or *Not proofread*.
- **Never** changes pages that are Proofread, Validated or Problematic. The status is checked again just before each save, in case someone edited the page meanwhile.
- If the wiki reports editing too fast, the script waits (30–120 s) and retries.
- After 3 errors in a row, the run pauses so you can check the log.
- Closing the tab during a run shows a warning.

**Good practice:** test on a small range (e.g. pages 1–5) in semi-automatic mode first, and check the text and watermark removal before running a full book.

---

## Default watermark patterns

Each line is a regular expression applied with flags `gm`:

```
Digitized\s+[Bb]y\s+Kerala\s+Sahitya\s+Akademi[^\n]*
Kerala\s+Sahitya\s+Akademi\s+[Dd]igitized[^\n]*
[Dd]igitized\s+[Bb]y\s+KSA[^\n]*
^[Dd]igitized\s+[Bb]y[^\n]*\n?
^\s*(Kerala\s+)?Sahitya\s+Akademi\s*$
^_+\s*$
```

"Sahitya Akademi" is only removed when it stands alone on a line, so genuine mentions in the book text are kept.

---

## Troubleshooting

| Problem | What to check |
|---|---|
| No BulkOCR button | Make sure you are logged in, the code is saved in your `common.js` (or the page in the `mw.loader.load` line exists), and reload with Ctrl+Shift+R. Press F12 → Console and look for lines starting with `[BulkOCR]`. |
| "No image for …" / OCR HTTP errors | Try a smaller **Width** (1280 or 960). |
| `ratelimited` in the log | Normal; the script waits and retries. Increase **Delay** for large books. |
| Run paused after errors | Read the red lines in the log, then **Resume** or **Stop**. |
| Old edit summary still used | Change it once in the panel's Summary box; settings are remembered. |

---

## Credits

Developed by **Manoj K** (User:Manojk) for the **Wiki Librarians Network**, as part of the **Grandham Project Initiative**.
Uses the [Wikimedia OCR](https://ocr.wmcloud.org/) service and the MediaWiki / ProofreadPage APIs.
