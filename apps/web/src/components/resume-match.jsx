// Resume Match — AI round-trip primitive
// Pattern: generate prompt -> launch user's AI -> wait for paste-back -> parse -> compare
// Demonstrated with 3 AIs in different states simultaneously (parsed / awaiting / failed)
// so the whole pattern is visible at once.

import React, { useState as rmState, useMemo as rmMemo, useRef as rmRef } from 'react';
import { CompanyMark, Icon } from './primitives';
import { PageHeader, SectionLabel } from './shell';
import { COMPANIES } from '../data';

const RESUME_FILE = { name: 'senior-fe-resume.pdf', size: '2.4 KB', updated: 'Apr 18, 9:14 AM' };

const RM_JDS = [
  { id: 'jd1', title: 'Senior Frontend Engineer', company: 'Northwind Systems', companyId: 'c01', team: 'Developer Experience', wordCount: 412 },
  { id: 'jd2', title: 'Staff Product Designer',   company: 'Northwind Systems', companyId: 'c01', team: 'Platform',             wordCount: 358 },
  { id: 'jd3', title: 'Research Engineer, LLMs',  company: 'Umbra Labs',        companyId: 'c20', team: 'Research',             wordCount: 489 },
  { id: 'jd4', title: 'Growth PM',                company: 'Fern Fintech',      companyId: 'c11', team: 'Acquisition',          wordCount: 312 },
];

const PROVIDERS = [
  { id: 'chatgpt', name: 'ChatGPT', model: 'GPT-4o',     color: 'oklch(0.55 0.13 155)', url: 'https://chat.openai.com' },
  { id: 'claude',  name: 'Claude',  model: 'Sonnet 4.5', color: 'oklch(0.58 0.14 40)',  url: 'https://claude.ai' },
  { id: 'gemini',  name: 'Gemini',  model: '2.0 Pro',    color: 'oklch(0.55 0.13 255)', url: 'https://gemini.google.com' },
];

const MOCK_RESPONSES = {
  chatgpt: [
    { jd_id: 'jd1', rank: 1, score: 87, reasons: 'Strong React + DX tooling fit; senior IC track aligned.', gaps: 'Limited platform engineering depth shown.' },
    { jd_id: 'jd3', rank: 2, score: 81, reasons: 'Eval infra background; demonstrated research-eng crossover.', gaps: 'RLHF math depth not visible from resume.' },
    { jd_id: 'jd2', rank: 3, score: 72, reasons: 'Design ops crossover; comfortable bridging design.', gaps: 'No formal senior IC design role.' },
    { jd_id: 'jd4', rank: 4, score: 58, reasons: 'Activation metrics fluent.', gaps: 'No fintech, no recent PM title.' },
  ],
  claude: [
    { jd_id: 'jd1', rank: 1, score: 91, reasons: 'Best fit; design system depth + React maturity.', gaps: 'Could cite measurable perf wins.' },
    { jd_id: 'jd2', rank: 2, score: 78, reasons: 'Cross-functional with design DNA.', gaps: 'No design-title history.' },
    { jd_id: 'jd3', rank: 3, score: 80, reasons: 'Research mindset; eval infra crossover.', gaps: 'Currently not in ML role.' },
    { jd_id: 'jd4', rank: 4, score: 55, reasons: 'SQL strong; activation metric knowledge.', gaps: 'No PM ownership in last 3 years.' },
  ],
  gemini: [
    { jd_id: 'jd3', rank: 1, score: 84, reasons: 'Tech depth aligns to research-engineering role.', gaps: 'Need a recent ML role on resume.' },
    { jd_id: 'jd1', rank: 2, score: 82, reasons: 'Most direct skill alignment.', gaps: 'Less performance optimization cited.' },
    { jd_id: 'jd2', rank: 3, score: 71, reasons: 'Adjacent design skills.', gaps: 'Title mismatch for "Staff".' },
    { jd_id: 'jd4', rank: 4, score: 60, reasons: 'SQL strong.', gaps: 'Industry switch friction.' },
  ],
};

const SAMPLE_PASTES = {
  json: () => JSON.stringify({ rankings: MOCK_RESPONSES.claude }, null, 2),
  markdown: () => `Here's my analysis:

| Rank | JD | Score | Why |
|------|-----|------|------|
| 1 | jd1 — Senior Frontend Engineer | 91 | Best fit; depth in DS + React |
| 2 | jd2 — Staff Product Designer | 78 | Cross-functional design DNA |
| 3 | jd3 — Research Engineer | 80 | Research mindset evident |
| 4 | jd4 — Growth PM | 55 | SQL strong but title mismatch |`,
  plain: () => `Looking at your resume against the four JDs, here's how I'd rank them:

1. Senior Frontend Engineer at Northwind — strong fit, 91/100
2. Staff Product Designer at Northwind — adjacent skills, 78/100
3. Research Engineer at Umbra Labs — interesting but stretch, 80/100
4. Growth PM at Fern — weakest match, 55/100

Hope that helps!`,
};

// Try to parse pasted text in three escalating ways: JSON -> markdown table -> heuristics.
function tryParseResponse(text) {
  if (!text || !text.trim()) return { ok: false, error: 'Empty input' };
  // 1. JSON
  try {
    const obj = JSON.parse(text);
    const arr = obj.rankings || obj;
    if (Array.isArray(arr) && arr[0]?.jd_id) {
      return { ok: true, format: 'JSON', rankings: arr };
    }
  } catch (e) { /* fall through */ }
  // 2. Markdown table
  const rows = text.split('\n').filter(l => l.includes('|') && /jd\d/i.test(l));
  if (rows.length >= 2) {
    const rankings = rows.map(r => {
      const cells = r.split('|').map(c => c.trim()).filter(Boolean);
      const rank = parseInt(cells[0], 10);
      const jdMatch = cells[1]?.match(/jd\d/i);
      const score = parseInt(cells[2], 10);
      return { rank, jd_id: jdMatch?.[0].toLowerCase(), score, reasons: cells[3] || '', gaps: '' };
    }).filter(r => r.jd_id && r.score);
    if (rankings.length) return { ok: true, format: 'Markdown table', rankings };
  }
  // 3. Numbered list with "Senior Frontend Engineer" style references — fragile
  const titleMatches = text.match(/(senior frontend|staff product|research engineer|growth pm)/gi);
  if (titleMatches && titleMatches.length >= 2) {
    return { ok: false, error: 'Found JD mentions but no clear ranking structure. Try pasting the JSON instead.' };
  }
  return { ok: false, error: 'Could not detect a ranking format. Expected JSON, a markdown table, or a structured list.' };
}

export const ResumeMatchPage = () => {
  // Default scenario: ChatGPT parsed, Claude awaiting, Gemini failed
  const [aiState, setAiState] = rmState({
    chatgpt: { status: 'parsed',   data: MOCK_RESPONSES.chatgpt, parsedAt: 'Apr 19, 11:02 AM', confidence: 0.94 },
    claude:  { status: 'awaiting', launchedAt: '11:18 AM' },
    gemini:  { status: 'failed',   error: 'Found 3 sections but could not map jd_ids cleanly.', rawSnippet: '"Looking at your resume, I notice you have strong React experience..."' },
  });
  const [activePaste, setActivePaste] = rmState('claude');
  const [pasteText, setPasteText] = rmState('');
  const [parsePreview, setParsePreview] = rmState(null);
  const [toast, setToast] = rmState(null);
  const [inputsOpen, setInputsOpen] = rmState(false);
  const [promptOpen, setPromptOpen] = rmState(true);
  const pasteRef = rmRef(null);

  const showToast = (msg) => {
    setToast(msg);
    setTimeout(() => setToast(null), 2800);
  };

  const promptText = rmMemo(() => {
    return `You are a senior career advisor. Compare the candidate's resume against ${RM_JDS.length} job descriptions and rank them by fit. Return JSON in the exact shape:

{ "rankings": [{ "jd_id": "jd1", "rank": 1, "score": 87, "reasons": "...", "gaps": "..." }] }

# RESUME
<attached file: ${RESUME_FILE.name}, ${RESUME_FILE.size}>

# JOB DESCRIPTIONS
${RM_JDS.map(j => `[${j.id}] ${j.title} @ ${j.company} (${j.team}) — ${j.wordCount} words`).join('\n')}

Be specific in reasons and gaps. Score 0–100. Rank 1 = best fit.`;
  }, []);

  const launchAI = (providerId) => {
    const p = PROVIDERS.find(x => x.id === providerId);
    try { navigator.clipboard.writeText(promptText); } catch (e) {}
    try { window.open(p.url, '_blank', 'noopener'); } catch (e) {}
    setAiState(s => ({ ...s, [providerId]: { status: 'awaiting', launchedAt: new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) } }));
    setActivePaste(providerId);
    showToast(`Prompt copied · ${p.name} opened in new tab. Paste the response here when ready.`);
  };

  const handlePasteChange = (text) => {
    setPasteText(text);
    if (!text.trim()) { setParsePreview(null); return; }
    setParsePreview(tryParseResponse(text));
  };

  const tryInsertSample = (kind) => {
    const text = SAMPLE_PASTES[kind]();
    setPasteText(text);
    setParsePreview(tryParseResponse(text));
    pasteRef.current?.focus();
  };

  const commitParse = () => {
    if (!parsePreview?.ok) return;
    setAiState(s => ({ ...s, [activePaste]: { status: 'parsed', data: parsePreview.rankings, parsedAt: 'just now', confidence: 0.91 } }));
    setPasteText(''); setParsePreview(null);
    showToast(`${PROVIDERS.find(p => p.id === activePaste).name} response saved · ${parsePreview.rankings.length} JDs ranked`);
    // Auto-select next non-parsed AI if any
    const next = PROVIDERS.find(p => p.id !== activePaste && aiState[p.id].status !== 'parsed');
    setActivePaste(next?.id || null);
  };

  const resetAI = (providerId) => {
    setAiState(s => ({ ...s, [providerId]: { status: 'idle' } }));
    setActivePaste(providerId);
  };

  // Build comparison: only AIs that are parsed
  const parsedAIs = PROVIDERS.filter(p => aiState[p.id].status === 'parsed');
  const hasComparison = parsedAIs.length >= 1;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <PageHeader
        title="Resume Match"
        subtitle={`Comparing ${RM_JDS.length} JDs against ${RESUME_FILE.name} · ${parsedAIs.length} of ${PROVIDERS.length} models compared`}
        actions={
          <>
            <button className="btn-secondary"><Icon name="doc" size={13} /> Resume</button>
            <button className="btn-primary"><Icon name="plus" size={13} stroke={2} /> Add JD</button>
          </>
        }
      />

      <div style={{ flex: 1, overflowY: 'auto', padding: '14px 28px 28px' }}>
        {/* Inputs row — collapsible */}
        <Collapsible
          open={inputsOpen} setOpen={setInputsOpen}
          label={`Inputs · ${RM_JDS.length} JDs + 1 resume`}
        >
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 8 }}>
            {RM_JDS.map(jd => {
              const company = COMPANIES.find(c => c.id === jd.companyId);
              return (
                <div key={jd.id} style={{ padding: 10, background: 'var(--surface-2)', border: '0.5px solid var(--border)', borderRadius: 7 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                    <span style={{ fontSize: 10, fontFamily: 'var(--font-mono)', color: 'var(--fg-muted)', background: 'var(--surface)', padding: '1px 5px', borderRadius: 3, border: '0.5px solid var(--border)' }}>{jd.id}</span>
                    <CompanyMark company={company} size={14} />
                    <span style={{ fontSize: 11, color: 'var(--fg-muted)' }}>{jd.company}</span>
                  </div>
                  <div style={{ fontSize: 12, fontWeight: 500, color: 'var(--fg)', lineHeight: 1.3 }}>{jd.title}</div>
                  <div style={{ fontSize: 10.5, color: 'var(--fg-muted)', marginTop: 2 }}>{jd.team} · {jd.wordCount} words</div>
                </div>
              );
            })}
            <div style={{ padding: 10, background: 'var(--surface-2)', border: '0.5px dashed var(--border)', borderRadius: 7, display: 'flex', alignItems: 'center', gap: 6, color: 'var(--fg-muted)', fontSize: 11.5 }}>
              <Icon name="plus" size={13} stroke={2} /> Paste another JD
            </div>
          </div>
        </Collapsible>

        {/* Prompt + launch row */}
        <Collapsible
          open={promptOpen} setOpen={setPromptOpen}
          label="Generated prompt"
          rightSlot={<span style={{ fontSize: 10.5, color: 'var(--fg-muted)', fontFamily: 'var(--font-mono)' }}>{promptText.length} chars</span>}
        >
          <div style={{ background: 'var(--surface-2)', border: '0.5px solid var(--border)', borderRadius: 7, padding: 12, fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--fg)', lineHeight: 1.55, maxHeight: 160, overflowY: 'auto', whiteSpace: 'pre-wrap', marginBottom: 10 }}>
            {promptText}
          </div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {PROVIDERS.map(p => (
              <button key={p.id} onClick={() => launchAI(p.id)} className="btn-secondary" style={{ paddingLeft: 8 }}>
                <span style={{ width: 7, height: 7, borderRadius: 4, background: p.color }} />
                Launch {p.name}
                <Icon name="external" size={11} />
              </button>
            ))}
            <span style={{ fontSize: 11, color: 'var(--fg-muted)', marginLeft: 4, alignSelf: 'center', whiteSpace: 'nowrap' }}>
              <Icon name="check" size={11} /> copies prompt + opens AI
            </span>
          </div>
        </Collapsible>

        {/* Models strip */}
        <div style={{ marginTop: 16 }}>
          <SectionLabel>Models</SectionLabel>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
            {PROVIDERS.map(p => (
              <ModelCard
                key={p.id}
                provider={p}
                state={aiState[p.id]}
                active={activePaste === p.id}
                onSelect={() => setActivePaste(p.id)}
                onLaunch={() => launchAI(p.id)}
                onReset={() => resetAI(p.id)}
              />
            ))}
          </div>
        </div>

        {/* Active task — context-aware: paste panel, fix panel, or null */}
        {activePaste && aiState[activePaste].status !== 'parsed' && (
          <ActiveTaskPanel
            provider={PROVIDERS.find(p => p.id === activePaste)}
            state={aiState[activePaste]}
            pasteText={pasteText}
            parsePreview={parsePreview}
            pasteRef={pasteRef}
            onChange={handlePasteChange}
            onSample={tryInsertSample}
            onCommit={commitParse}
            onCancel={() => { setPasteText(''); setParsePreview(null); }}
          />
        )}

        {/* Comparison results */}
        {hasComparison && (
          <ComparisonResults aiState={aiState} parsedAIs={parsedAIs} />
        )}
      </div>

      {toast && <Toast text={toast} />}
    </div>
  );
};

// ----- Subcomponents -----

const Collapsible = ({ open, setOpen, label, rightSlot, children }) => (
  <div style={{ marginBottom: 12 }}>
    <button onClick={() => setOpen(!open)} style={{
      width: '100%', textAlign: 'left',
      padding: '6px 0', background: 'transparent', border: 'none',
      display: 'flex', alignItems: 'center', gap: 6,
      cursor: 'pointer', color: 'var(--fg-muted)',
      fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em',
    }}>
      <Icon name={open ? 'chevronDown' : 'chevronRight'} size={11} stroke={2} />
      {label}
      {rightSlot && <span style={{ marginLeft: 'auto', textTransform: 'none', letterSpacing: 'normal' }}>{rightSlot}</span>}
    </button>
    {open && <div style={{ marginTop: 6 }}>{children}</div>}
  </div>
);

const ModelCard = ({ provider, state, active, onSelect, onLaunch, onReset }) => {
  const statusMeta = {
    idle:     { label: 'Not sent',          color: 'var(--fg-muted)',         icon: 'sparkle',  iconStroke: 1.5 },
    awaiting: { label: 'Awaiting paste',    color: 'oklch(0.50 0.14 245)',    icon: 'inbox',    iconStroke: 1.75 },
    parsing:  { label: 'Parsing…',          color: 'oklch(0.50 0.14 245)',    icon: 'refresh',  iconStroke: 1.75 },
    parsed:   { label: 'Parsed',            color: 'oklch(0.45 0.13 155)',    icon: 'check',    iconStroke: 2 },
    failed:   { label: 'Parse failed',      color: 'oklch(0.50 0.16 30)',     icon: 'alert',    iconStroke: 1.75 },
  };
  const meta = statusMeta[state.status] || statusMeta.idle;

  return (
    <div onClick={onSelect} style={{
      background: 'var(--surface)',
      border: `0.5px solid ${active ? 'var(--fg)' : 'var(--border)'}`,
      borderRadius: 8, padding: 12,
      cursor: 'pointer',
      boxShadow: active ? '0 0 0 2px oklch(from var(--fg) l c h / 0.08)' : 'none',
      transition: 'border-color 120ms, box-shadow 120ms',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, minWidth: 0 }}>
        <span style={{ width: 9, height: 9, borderRadius: 5, background: provider.color, flexShrink: 0 }} />
        <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--fg)', whiteSpace: 'nowrap' }}>{provider.name}</span>
        <span style={{ fontSize: 10.5, color: 'var(--fg-muted)', fontFamily: 'var(--font-mono)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0 }}>{provider.model}</span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: meta.color, marginBottom: 8, minWidth: 0 }}>
        <Icon name={meta.icon} size={12} stroke={meta.iconStroke} />
        <span style={{ fontWeight: 500, whiteSpace: 'nowrap' }}>{meta.label}</span>
        {state.status === 'parsed' && state.data && (
          <span style={{ marginLeft: 'auto', fontSize: 10.5, color: 'var(--fg-muted)', fontFamily: 'var(--font-mono)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0 }}>
            {state.data.length} JDs
          </span>
        )}
        {state.status === 'awaiting' && state.launchedAt && (
          <span style={{ marginLeft: 'auto', fontSize: 10.5, color: 'var(--fg-muted)', fontFamily: 'var(--font-mono)', whiteSpace: 'nowrap' }}>
            sent {state.launchedAt}
          </span>
        )}
      </div>
      <div style={{ display: 'flex', gap: 4 }}>
        {state.status === 'idle' && (
          <button onClick={(e) => { e.stopPropagation(); onLaunch(); }} className="btn-secondary" style={{ flex: 1, justifyContent: 'center', fontSize: 11.5, padding: '5px 8px' }}>
            <Icon name="external" size={11} /> Launch
          </button>
        )}
        {state.status === 'awaiting' && (
          <>
            <span style={{ flex: 1, fontSize: 11, color: 'var(--fg-muted)', alignSelf: 'center', paddingLeft: 2 }}>
              Paste response below
            </span>
            <button onClick={(e) => { e.stopPropagation(); onLaunch(); }} className="btn-secondary" style={{ padding: '4px 8px', fontSize: 11 }}>
              <Icon name="external" size={11} /> Reopen
            </button>
          </>
        )}
        {state.status === 'parsed' && (
          <>
            <button onClick={(e) => { e.stopPropagation(); onReset(); }} className="btn-secondary" style={{ flex: 1, justifyContent: 'center', fontSize: 11, padding: '5px 8px' }}>
              <Icon name="refresh" size={11} /> Re-run
            </button>
            <button onClick={(e) => e.stopPropagation()} className="btn-secondary" style={{ padding: '5px 8px', fontSize: 11 }}>
              <Icon name="sparkle" size={11} /> Follow-up
            </button>
          </>
        )}
        {state.status === 'failed' && (
          <button onClick={(e) => { e.stopPropagation(); onReset(); }} className="btn-secondary" style={{ flex: 1, justifyContent: 'center', fontSize: 11.5, padding: '5px 8px' }}>
            <Icon name="refresh" size={11} /> Try again
          </button>
        )}
      </div>
    </div>
  );
};

const ActiveTaskPanel = ({ provider, state, pasteText, parsePreview, pasteRef, onChange, onSample, onCommit, onCancel }) => {
  const isFailed = state.status === 'failed';

  return (
    <div style={{
      marginTop: 16,
      background: 'var(--surface)',
      border: `0.5px solid var(--border)`,
      borderRadius: 10,
      overflow: 'hidden',
    }}>
      <div style={{ padding: '10px 14px', borderBottom: '0.5px solid var(--border)', background: 'var(--surface-2)', display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ width: 8, height: 8, borderRadius: 4, background: provider.color }} />
        <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--fg)' }}>
          {isFailed ? `Recover ${provider.name} parse` : `Paste ${provider.name} response`}
        </span>
        <span style={{ fontSize: 10.5, color: 'var(--fg-muted)', fontFamily: 'var(--font-mono)', marginLeft: 'auto' }}>{provider.url.replace('https://', '')}</span>
      </div>

      {isFailed && (
        <div style={{ padding: '10px 14px', background: 'oklch(0.97 0.03 30)', borderBottom: '0.5px solid oklch(0.88 0.06 30)', display: 'flex', alignItems: 'flex-start', gap: 8 }}>
          <span style={{ flexShrink: 0, color: 'oklch(0.5 0.16 30)', marginTop: 1 }}><Icon name="alert" size={12} stroke={2} /></span>
          <div style={{ fontSize: 11.5, color: 'oklch(0.42 0.13 30)', lineHeight: 1.5 }}>
            <strong>Couldn't parse the last response.</strong> {state.error} {state.rawSnippet && <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'oklch(0.5 0.1 30)' }}>{state.rawSnippet}</span>}
          </div>
        </div>
      )}

      <div style={{ padding: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
          <span style={{ fontSize: 11, color: 'var(--fg-muted)' }}>Need a sample to test?</span>
          <button onClick={() => onSample('json')} className="btn-secondary" style={{ fontSize: 11, padding: '3px 8px' }}>JSON</button>
          <button onClick={() => onSample('markdown')} className="btn-secondary" style={{ fontSize: 11, padding: '3px 8px' }}>Markdown</button>
          <button onClick={() => onSample('plain')} className="btn-secondary" style={{ fontSize: 11, padding: '3px 8px' }}>Plain text</button>
        </div>
        <textarea
          ref={pasteRef}
          value={pasteText}
          onChange={(e) => onChange(e.target.value)}
          placeholder={`Paste ${provider.name}'s reply here. JSON is best, but we'll do our best with tables or plain text.`}
          style={{
            width: '100%', height: 140,
            padding: 10,
            background: 'var(--surface-2)', border: '0.5px solid var(--border)',
            borderRadius: 6, color: 'var(--fg)',
            fontSize: 11.5, fontFamily: 'var(--font-mono)', lineHeight: 1.5,
            resize: 'vertical', outline: 'none', boxSizing: 'border-box',
          }}
        />
        {parsePreview && <ParsePreview preview={parsePreview} />}
      </div>

      <div style={{ padding: 12, borderTop: '0.5px solid var(--border)', background: 'var(--surface-2)', display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 11, color: 'var(--fg-muted)' }}>
          {parsePreview?.ok ? `Detected ${parsePreview.format} · ${parsePreview.rankings.length} rankings ready` : pasteText ? 'Edit and we\'ll re-parse' : 'Awaiting paste'}
        </span>
        <div style={{ flex: 1 }} />
        {pasteText && <button onClick={onCancel} className="btn-secondary" style={{ fontSize: 11.5 }}>Clear</button>}
        <button
          onClick={onCommit}
          disabled={!parsePreview?.ok}
          className="btn-primary"
          style={{
            fontSize: 11.5,
            opacity: parsePreview?.ok ? 1 : 0.4,
            cursor: parsePreview?.ok ? 'pointer' : 'not-allowed',
          }}>
          <Icon name="check" size={12} stroke={2} /> Save response
        </button>
      </div>
    </div>
  );
};

const ParsePreview = ({ preview }) => {
  if (!preview) return null;
  if (!preview.ok) {
    return (
      <div style={{ marginTop: 10, padding: 10, background: 'oklch(0.97 0.03 30)', border: '0.5px solid oklch(0.88 0.06 30)', borderRadius: 6, fontSize: 11.5, color: 'oklch(0.45 0.13 30)' }}>
        <Icon name="alert" size={12} /> {preview.error}
      </div>
    );
  }
  return (
    <div style={{ marginTop: 10, padding: 10, background: 'oklch(0.97 0.03 155)', border: '0.5px solid oklch(0.88 0.05 155)', borderRadius: 6 }}>
      <div style={{ fontSize: 11.5, fontWeight: 600, color: 'oklch(0.4 0.13 155)', display: 'flex', alignItems: 'center', gap: 5, marginBottom: 6 }}>
        <Icon name="check" size={12} stroke={2} /> Parsed as {preview.format} · {preview.rankings.length} rankings
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4 }}>
        {preview.rankings.map(r => {
          const jd = RM_JDS.find(j => j.id === r.jd_id);
          return (
            <div key={r.jd_id} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'oklch(0.35 0.1 155)', padding: '2px 0' }}>
              <span style={{ fontFamily: 'var(--font-mono)', minWidth: 18 }}>#{r.rank}</span>
              <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'oklch(0.3 0.05 155)' }}>{jd?.title || r.jd_id}</span>
              <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 600 }}>{r.score}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
};

const Toast = ({ text }) => (
  <div style={{
    position: 'fixed', bottom: 24, left: '50%', transform: 'translateX(-50%)',
    background: 'var(--fg)', color: 'var(--bg)',
    padding: '9px 14px', borderRadius: 7, fontSize: 12, fontWeight: 500,
    boxShadow: '0 12px 30px rgba(0,0,0,0.18)',
    zIndex: 1000, display: 'flex', alignItems: 'center', gap: 6,
    animation: 'slideIn 200ms ease',
    maxWidth: 480,
  }}>
    <Icon name="check" size={12} stroke={2} />
    {text}
  </div>
);

const ComparisonResults = ({ aiState, parsedAIs }) => {
  // Build rankings matrix
  const rankings = rmMemo(() => {
    return RM_JDS.map(jd => {
      const byAI = {};
      parsedAIs.forEach(p => {
        const found = aiState[p.id].data.find(r => r.jd_id === jd.id);
        byAI[p.id] = found || null;
      });
      const scores = parsedAIs.map(p => byAI[p.id]?.score).filter(Boolean);
      const avgScore = scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : null;
      return { jd, byAI, avgScore };
    }).sort((a, b) => (b.avgScore || 0) - (a.avgScore || 0));
  }, [aiState, parsedAIs]);

  return (
    <div style={{ marginTop: 20 }}>
      <SectionLabel>Comparison · {parsedAIs.length} of {PROVIDERS.length} models</SectionLabel>
      {parsedAIs.length >= 2 && (
        <div style={{ background: 'var(--surface)', border: '0.5px solid var(--border)', borderRadius: 10, padding: 14, marginBottom: 10 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--fg)', marginBottom: 2 }}>Rank consensus</div>
          <div style={{ fontSize: 11, color: 'var(--fg-muted)', marginBottom: 10 }}>How each model ranked your fit · lower number is better</div>
          <BumpChart rankings={rankings} parsedAIs={parsedAIs} />
        </div>
      )}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 8 }}>
        {rankings.map(({ jd, byAI, avgScore }) => {
          const company = COMPANIES.find(c => c.id === jd.companyId);
          return (
            <div key={jd.id} style={{ background: 'var(--surface)', border: '0.5px solid var(--border)', borderRadius: 8, padding: 12 }}>
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, marginBottom: 8 }}>
                <CompanyMark company={company} size={26} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--fg)', lineHeight: 1.3 }}>{jd.title}</div>
                  <div style={{ fontSize: 10.5, color: 'var(--fg-muted)' }}>{jd.company} · {jd.team}</div>
                </div>
                {avgScore != null && (
                  <div style={{ textAlign: 'right', flexShrink: 0 }}>
                    <div style={{ fontSize: 20, fontWeight: 600, color: 'var(--fg)', fontFamily: 'var(--font-display)', fontVariantNumeric: 'tabular-nums', lineHeight: 1 }}>{avgScore}</div>
                    <div style={{ fontSize: 9.5, color: 'var(--fg-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 600, marginTop: 3 }}>avg</div>
                  </div>
                )}
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: `repeat(${parsedAIs.length}, 1fr)`, gap: 4 }}>
                {parsedAIs.map(p => {
                  const r = byAI[p.id];
                  return (
                    <div key={p.id} style={{ padding: '5px 7px', background: 'var(--surface-2)', border: '0.5px solid var(--border)', borderRadius: 5 }}>
                      <div style={{ fontSize: 9.5, color: 'var(--fg-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 600, display: 'flex', alignItems: 'center', gap: 4 }}>
                        <span style={{ width: 5, height: 5, borderRadius: 3, background: p.color }} />
                        {p.name}
                      </div>
                      <div style={{ display: 'flex', alignItems: 'baseline', gap: 4, marginTop: 1 }}>
                        <span style={{ fontSize: 13, fontWeight: 600, color: p.color, fontFamily: 'var(--font-display)', fontVariantNumeric: 'tabular-nums', lineHeight: 1 }}>#{r?.rank}</span>
                        <span style={{ fontSize: 10.5, color: 'var(--fg-muted)', fontVariantNumeric: 'tabular-nums' }}>· {r?.score}</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

// Bump chart — simpler version focused on rank changes across models
const BumpChart = ({ rankings, parsedAIs }) => {
  const width = 900, height = 180;
  const padX = 50, padY = 20, padRight = 240;
  const n = rankings.length;
  const xs = parsedAIs.map((p, i) => padX + (i * (width - padX - padRight) / Math.max(1, parsedAIs.length - 1)));
  const yForRank = (r) => padY + ((r - 1) * (height - 2*padY) / Math.max(1, n - 1));

  // Build a stable color per JD
  const jdColors = rankings.reduce((acc, { jd }, i) => {
    acc[jd.id] = `oklch(0.55 0.13 ${(i * 80 + 30) % 360})`;
    return acc;
  }, {});

  return (
    <svg viewBox={`0 0 ${width} ${height}`} style={{ width: '100%', height: 'auto', display: 'block' }}>
      {Array.from({ length: n }, (_, i) => (
        <line key={i} x1={padX} y1={yForRank(i+1)} x2={width - padRight + 30} y2={yForRank(i+1)} stroke="var(--border)" strokeWidth="0.5" strokeDasharray="2 3" />
      ))}
      {Array.from({ length: n }, (_, i) => (
        <text key={i} x={padX - 10} y={yForRank(i+1) + 4} fontSize="10" fill="var(--fg-muted)" textAnchor="end" fontFamily="var(--font-mono)">#{i+1}</text>
      ))}
      {parsedAIs.map((p, i) => (
        <text key={p.id} x={xs[i]} y={12} fontSize="11" fill="var(--fg)" textAnchor="middle" fontWeight="500">{p.name}</text>
      ))}
      {rankings.map(({ jd, byAI }) => {
        const pts = parsedAIs.map((p, i) => byAI[p.id] ? `${xs[i]},${yForRank(byAI[p.id].rank)}` : null).filter(Boolean).join(' ');
        if (parsedAIs.length < 2) return null;
        return <polyline key={jd.id} points={pts} fill="none" stroke={jdColors[jd.id]} strokeWidth="1.5" strokeLinejoin="round" opacity="0.5" />;
      })}
      {parsedAIs.map((p, i) => rankings.map(({ jd, byAI }) => byAI[p.id] && (
        <g key={p.id + jd.id}>
          <circle cx={xs[i]} cy={yForRank(byAI[p.id].rank)} r="5" fill={jdColors[jd.id]} stroke="var(--surface)" strokeWidth="1.5" />
          {i === parsedAIs.length - 1 && (
            <text x={xs[i] + 14} y={yForRank(byAI[p.id].rank) + 4} fontSize="11" fill="var(--fg)" fontWeight="500">{jd.title}</text>
          )}
        </g>
      )))}
    </svg>
  );
};

