// @ts-check
// lib/fill/files.js — the resume / cover letter files saved on the Extension page,
// attached to upload fields. A fill with a tailored version uploads that
// version's one-page PDF as the resume, when it has one.
//
// Part of the autofill content script: manifest content_scripts loads
// lib/fill/* in order, then content.js. Helpers are shared through
// window.LandedFill.
(function (global) {
const F = global.LandedFill || (global.LandedFill = {});
const { getFieldLabel } = global.ResumeFillerFieldDetect;
const CA = global.LandedChoiceAnswers;

// ─── files to upload (Landed → Extension page) ─────────────────────────────

const VERSION_PDFS_KEY = 'landed:version-pdfs';

function readLocal(key) {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get(key, (res) => {
        void chrome.runtime.lastError;
        const stored = res && res[key];
        resolve(stored && typeof stored === 'object' ? stored : {});
      });
    } catch {
      resolve({});
    }
  });
}

/** The files to upload: the Extension page's, with the resume replaced by
 *  `resumeId`'s one-page PDF when that tailored version has one. */
async function loadApplicationFiles(resumeId) {
  const files = await readLocal(CA.FILES_KEY);
  if (!resumeId) return files;
  const version = (await readLocal(VERSION_PDFS_KEY))[resumeId];
  return version && version.file ? { ...files, resume: version.file } : files;
}

/** Does the input take this file? (`accept` lists types or extensions.) */
function acceptsFile(input, file) {
  const accept = String(input.getAttribute('accept') || '').toLowerCase().split(',').map((a) => a.trim()).filter(Boolean);
  if (accept.length === 0) return true;
  const ext = '.' + file.name.toLowerCase().split('.').pop();
  return accept.some((a) => a === ext || a === file.mime || (a.endsWith('/*') && file.mime.startsWith(a.slice(0, -1))));
}

/** Put a saved file into an upload field the way a drop or pick would. */
function attachFile(input, file) {
  try {
    const binary = atob(file.data);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const transfer = new DataTransfer();
    transfer.items.add(new File([bytes], file.name, { type: file.mime }));
    input.files = transfer.files;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return !!input.files && input.files.length > 0;
  } catch {
    return false;
  }
}

/** What an upload field is for. Upload fields are usually hidden behind an
 *  "Attach" button, with the "Resume/CV" heading not tied to them, so look
 *  at what names them, then their id or name ("resume", "cover_letter"),
 *  then the text around them, closest first. */
function fileInputKind(el) {
  const clean = (t) => String(t || '').replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
  const labelledBy = (el.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean)
    .map((id) => document.getElementById(id)?.textContent || '').join(' ');
  const candidates = [labelledBy, getFieldLabel(el), el.getAttribute('aria-label'), el.id, el.name].map(clean);
  let node = el.parentElement;
  for (let depth = 0; node && depth < 6; depth++, node = node.parentElement) candidates.push(clean(node.textContent).slice(0, 200));
  for (const text of candidates) {
    const kind = text && CA ? CA.fileKind(text) : null;
    if (kind) return { kind, label: text.slice(0, 120) };
  }
  return { kind: null, label: candidates.find(Boolean)?.slice(0, 120) || '' };
}

Object.assign(F, { loadApplicationFiles, acceptsFile, attachFile, fileInputKind });
})(typeof window !== 'undefined' ? window : globalThis);
