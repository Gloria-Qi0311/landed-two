# ApplyMint (resume-filler)

[![CI](https://github.com/AntaresYuan/resume-filler/actions/workflows/ci.yml/badge.svg)](https://github.com/AntaresYuan/resume-filler/actions/workflows/ci.yml)

Chrome extension that fills job-application forms from a structured resume JSON. Built for cross-border applicants — bilingual (zh/en) UI, CJK + Latin field detection, and (planned) optional LLM fallback for tricky forms.

## Install (development)

1. `git clone https://github.com/AntaresYuan/resume-filler.git`
2. Open `chrome://extensions` → enable **Developer mode**
3. Click **Load unpacked** and select the cloned folder
4. Click the extension icon to open the side panel

## Usage

1. **Side panel step 1**: copy the prompt and paste it (with your resume) into any LLM (ChatGPT / Claude / others). Paste the JSON it returns back into step 2.
2. **Options page**: visually edit the structured resume.
3. **On any application form**: click the extension icon → **Fill** → unmatched fields surface in step 3 for manual handling.

## Development

```bash
npm install        # install dev dependencies
npm test           # run Jest test suite
npm run lint       # run ESLint
npm run lint:fix   # autofix lint issues
```

CI runs `npm run lint` and `npm test` on every PR.

## Project layout

| File | Purpose |
|---|---|
| `manifest.json` | MV3 extension manifest |
| `background.js` | Service worker — opens the side panel on icon click |
| `schema.js` | Resume JSON schema, normalization, flatten-for-fill |
| `content.js` | DOM scan + form filling (text, select, combobox, date, multi-entry) |
| `popup.js` / `popup.html` | Side panel UI |
| `options.js` / `options.html` | Resume editor |
| `i18n.js` | zh/en localization |

See [`ARCHITECTURE.md`](./ARCHITECTURE.md) for the full module map, data flow, and `content.js` fill pipeline. See [`CONTRIBUTING.md`](./CONTRIBUTING.md) for the branch/PR flow, smoke-test checklist, and how to add a new field-detection rule.

## Roadmap

Tracked as GitHub issues across milestones v2.3 → v2.6. See [open issues](https://github.com/AntaresYuan/resume-filler/issues) and [milestones](https://github.com/AntaresYuan/resume-filler/milestones).
