// JD Breakdown — three sections, two AI round-trips
// 1. Source JD (compact, re-parse with different AI)
// 2. Requirements analysis (rendered from JD parse)
// 3. Resume Tailor — full round-trip producing diff variants

import React, { useState as jbState, useMemo as jbMemo } from 'react';
import { CompanyMark, Icon } from './primitives';
import { PageHeader, SectionLabel } from './shell';
import { COMPANIES } from '../data';

const SOURCE_JD = {
  id: 'jd-pc-staff-fe',
  title: 'Staff Frontend Engineer',
  company: 'Paperclip Labs',
  companyId: 'c04',
  location: 'San Francisco, CA',
  type: 'Full-time',
  parsedBy: 'Claude',
  parsedAt: 'Apr 18, 2:14 PM',
  wordCount: 612,
};

const PARSED = {
  must: [
    { text: '5+ years building production React apps', hit: true,  evidence: 'Resume: 6 yrs React at 3 companies' },
    { text: 'TypeScript fluency at scale',             hit: true,  evidence: 'Resume: TS-only codebases for 3 yrs' },
    { text: 'Design systems / component library work', hit: true,  evidence: 'Resume: Built Helios DS at Northwind' },
    { text: 'Client-side performance optimization',    hit: 'partial', evidence: 'Mentioned, no benchmarks cited' },
    { text: 'Led cross-functional technical initiatives', hit: true, evidence: 'Resume: Led 3 cross-team refactors' },
  ],
  nice: [
    { text: 'WebAssembly experience',          hit: false },
    { text: 'Background in ML / AI tooling',   hit: 'partial' },
    { text: 'Open-source contributions',       hit: true },
    { text: 'Public speaking / writing',       hit: false },
  ],
  gaps: [
    { skill: 'WebAssembly',       weeks: 4, why: 'Missing entirely — do a weekend project compiling Rust → WASM.', resources: 3 },
    { skill: 'Perf benchmarking', weeks: 2, why: 'You have the skill but no measurable evidence on resume.',       resources: 2 },
    { skill: 'Public writing',    weeks: 6, why: 'Publish 2 technical posts on your DS migration work.',           resources: 4 },
  ],
};

// Resume bullets — original
const ORIGINAL_BULLETS = [
  { id: 'b1', section: 'Senior Engineer · Northwind Systems · 2022–Present',
    text: 'Built component library used by 12 product teams.' },
  { id: 'b2', section: 'Senior Engineer · Northwind Systems · 2022–Present',
    text: 'Led migration of legacy codebase to React 18 with TypeScript.' },
  { id: 'b3', section: 'Senior Engineer · Northwind Systems · 2022–Present',
    text: 'Mentored 3 junior engineers and ran weekly tech reviews.' },
  { id: 'b4', section: 'Software Engineer · Helix Robotics · 2019–2022',
    text: 'Developed customer-facing web apps using Vue.' },
  { id: 'b5', section: 'Software Engineer · Helix Robotics · 2019–2022',
    text: 'Reduced bundle size by 30% through code splitting.' },
];

// Segment-based diff representation: keep | add | remove
const VARIANTS = {
  chatgpt: {
    state: 'parsed',
    changes: 5,
    confidence: 0.91,
    parsedAt: 'Apr 19, 11:42 AM',
    bullets: {
      b1: [
        { t: 'keep', s: 'Built ' },
        { t: 'add', s: 'and maintained a TypeScript-first React ' },
        { t: 'keep', s: 'component library used by 12 product teams' },
        { t: 'add', s: ', cutting UI duplication by ~40% across the org' },
        { t: 'keep', s: '.' },
      ],
      b2: [
        { t: 'keep', s: 'Led ' },
        { t: 'add', s: 'cross-team ' },
        { t: 'keep', s: 'migration of legacy codebase to React 18 with TypeScript' },
        { t: 'add', s: ', shipping zero-downtime in 8 weekly waves' },
        { t: 'keep', s: '.' },
      ],
      b5: [
        { t: 'keep', s: 'Reduced bundle size by 30% through code splitting' },
        { t: 'add', s: ' and dynamic imports; documented technique in internal eng blog (later open-sourced)' },
        { t: 'keep', s: '.' },
      ],
    },
  },
  claude: {
    state: 'parsed',
    changes: 3,
    confidence: 0.94,
    parsedAt: 'Apr 19, 11:58 AM',
    bullets: {
      b1: [
        { t: 'keep', s: 'Built ' },
        { t: 'add', s: 'React + TypeScript ' },
        { t: 'keep', s: 'component library used by 12 product teams' },
        { t: 'add', s: ' and integrated with cross-functional design + product partners' },
        { t: 'keep', s: '.' },
      ],
      b5: [
        { t: 'keep', s: 'Reduced bundle size by 30% through code splitting' },
        { t: 'add', s: '; reduced LCP from 3.1s to 1.4s on a P95 cohort' },
        { t: 'keep', s: '.' },
      ],
      b3: [
        { t: 'remove', s: 'Mentored 3 junior engineers and ran weekly tech reviews.' },
        { t: 'add', s: 'Led cross-functional technical initiatives including API redesign with backend and i18n rollout with design.' },
      ],
    },
  },
  gemini: { state: 'awaiting', changes: 0, bullets: {} },
};

const JD_PROVIDERS = [
  { id: 'chatgpt', name: 'ChatGPT', model: 'GPT-4o',     color: 'oklch(0.55 0.13 155)' },
  { id: 'claude',  name: 'Claude',  model: 'Sonnet 4.5', color: 'oklch(0.58 0.14 40)'  },
  { id: 'gemini',  name: 'Gemini',  model: '2.0 Pro',    color: 'oklch(0.55 0.13 255)' },
];

export const JDBreakdownPage = () => {
  const [tailorActive, setTailorActive] = jbState('claude');
  const [bulletStates, setBulletStates] = jbState({}); // id -> 'accepted' | 'rejected'
  const [sourceExpanded, setSourceExpanded] = jbState(false);
  const [tailorOpen, setTailorOpen] = jbState(true);

  const company = COMPANIES.find(c => c.id === SOURCE_JD.companyId);
  const hitColor = (h) => h === true ? 'oklch(0.55 0.14 155)' : h === 'partial' ? 'oklch(0.65 0.14 80)' : 'oklch(0.65 0.14 30)';

  const variant = VARIANTS[tailorActive];
  const acceptedCount = Object.values(bulletStates).filter(s => s === 'accepted').length;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <PageHeader
        title="JD Breakdown"
        subtitle={`${SOURCE_JD.title} @ ${SOURCE_JD.company} · ${PARSED.must.length + PARSED.nice.length} requirements · ${acceptedCount > 0 ? `${acceptedCount} changes accepted` : 'review and tailor your resume'}`}
        actions={
          <>
            <button className="btn-secondary"><Icon name="doc" size={13} /> Paste new JD</button>
            <button className="btn-primary"><Icon name="external" size={13} /> Export resume</button>
          </>
        }
      />

      <div style={{ flex: 1, overflowY: 'auto', padding: '14px 28px 28px' }}>
        {/* Source JD strip */}
        <SourceJDStrip
          expanded={sourceExpanded}
          onToggle={() => setSourceExpanded(!sourceExpanded)}
          company={company}
        />

        {/* Match summary header */}
        <div style={{ background: 'var(--surface)', border: '0.5px solid var(--border)', borderRadius: 10, padding: 14, marginTop: 10, marginBottom: 12, display: 'flex', alignItems: 'center', gap: 14 }}>
          <CompanyMark company={company} size={36} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--fg)', letterSpacing: '-0.01em' }}>{SOURCE_JD.title}</div>
            <div style={{ fontSize: 11.5, color: 'var(--fg-muted)' }}>{SOURCE_JD.company} · {SOURCE_JD.location} · {SOURCE_JD.type}</div>
          </div>
          <div style={{ display: 'flex', gap: 14 }}>
            <Stat value="78%" label="Match" color="oklch(0.55 0.14 155)" />
            <Stat value={<>4.5<span style={{ fontSize: 11, color: 'var(--fg-muted)' }}>/5</span></>} label="Must-haves" />
            <Stat value={PARSED.gaps.length} label="Gaps" />
            <Stat value={Object.keys(variant.bullets).length} label="Suggested edits" />
          </div>
        </div>

        {/* Requirements grid */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 18 }}>
          {/* Must-haves */}
          <div style={{ background: 'var(--surface)', border: '0.5px solid var(--border)', borderRadius: 10, padding: 14 }}>
            <SectionLabel>Must-have requirements</SectionLabel>
            {PARSED.must.map((r, i) => (
              <div key={i} style={{ padding: '7px 0', borderTop: i === 0 ? 'none' : '0.5px solid var(--border-subtle)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ width: 8, height: 8, borderRadius: 4, background: hitColor(r.hit), flexShrink: 0 }} />
                  <span style={{ fontSize: 12.5, color: 'var(--fg)' }}>{r.text}</span>
                </div>
                {r.evidence && (
                  <div style={{ fontSize: 11, color: 'var(--fg-muted)', marginTop: 3, paddingLeft: 16, fontStyle: 'italic' }}>{r.evidence}</div>
                )}
              </div>
            ))}
            <div style={{ marginTop: 12, paddingTop: 12, borderTop: '0.5px solid var(--border)' }}>
              <SectionLabel style={{ marginBottom: 6 }}>Nice-to-have</SectionLabel>
              {PARSED.nice.map((r, i) => (
                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '3px 0' }}>
                  <span style={{ width: 6, height: 6, borderRadius: 3, background: hitColor(r.hit), flexShrink: 0 }} />
                  <span style={{ fontSize: 12, color: 'var(--fg-muted)' }}>{r.text}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Gap study plan */}
          <div style={{ background: 'var(--surface)', border: '0.5px solid var(--border)', borderRadius: 10, padding: 14 }}>
            <SectionLabel>Close your gaps · {PARSED.gaps.reduce((s, g) => s + g.weeks, 0)}-week plan</SectionLabel>
            {PARSED.gaps.map((g, i) => (
              <div key={i} style={{ padding: '10px 0', borderTop: i === 0 ? 'none' : '0.5px solid var(--border-subtle)', display: 'flex', gap: 10 }}>
                <div style={{ flexShrink: 0, width: 36, height: 36, background: 'var(--surface-2)', border: '0.5px solid var(--border)', borderRadius: 6, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--fg)', fontFamily: 'var(--font-display)' }}>{g.weeks}w</span>
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 12.5, fontWeight: 500, color: 'var(--fg)' }}>{g.skill}</div>
                  <div style={{ fontSize: 11, color: 'var(--fg-muted)', lineHeight: 1.4, marginTop: 2 }}>{g.why}</div>
                  <div style={{ fontSize: 10.5, color: 'var(--accent)', marginTop: 4, display: 'flex', alignItems: 'center', gap: 3 }}>
                    <Icon name="link" size={10} /> {g.resources} resources
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Tailor section */}
        <div>
          <div style={{ display: 'flex', alignItems: 'center', marginBottom: 8 }}>
            <SectionLabel style={{ marginBottom: 0 }}>Resume Tailor · AI-suggested edits</SectionLabel>
            <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--fg-muted)' }}>
              <Icon name="sparkle" size={11} /> Routes through your AI · same round-trip pattern
            </span>
          </div>

          {/* Models strip — like Resume Match but for tailoring */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8, marginBottom: 12 }}>
            {JD_PROVIDERS.map(p => {
              const v = VARIANTS[p.id];
              const active = tailorActive === p.id;
              return (
                <div key={p.id} onClick={() => v.state === 'parsed' && setTailorActive(p.id)}
                  style={{
                    background: 'var(--surface)',
                    border: `0.5px solid ${active ? 'var(--fg)' : 'var(--border)'}`,
                    borderRadius: 8, padding: 12,
                    cursor: v.state === 'parsed' ? 'pointer' : 'default',
                    boxShadow: active ? '0 0 0 2px oklch(from var(--fg) l c h / 0.08)' : 'none',
                  }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, minWidth: 0 }}>
                    <span style={{ width: 9, height: 9, borderRadius: 5, background: p.color, flexShrink: 0 }} />
                    <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--fg)', whiteSpace: 'nowrap' }}>{p.name}</span>
                    <span style={{ fontSize: 10.5, color: 'var(--fg-muted)', fontFamily: 'var(--font-mono)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0 }}>{p.model}</span>
                  </div>
                  {v.state === 'parsed' ? (
                    <>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: 'oklch(0.45 0.13 155)', marginBottom: 4 }}>
                        <Icon name="check" size={12} stroke={2} />
                        <span style={{ fontWeight: 500, whiteSpace: 'nowrap' }}>Tailored</span>
                      </div>
                      <div style={{ fontSize: 11, color: 'var(--fg-muted)', display: 'flex', alignItems: 'baseline', gap: 4 }}>
                        <span style={{ fontFamily: 'var(--font-display)', fontWeight: 600, color: 'var(--fg)', fontSize: 13 }}>{v.changes}</span>
                        edits across {Object.keys(v.bullets).length} bullets
                      </div>
                    </>
                  ) : (
                    <>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: 'oklch(0.50 0.14 245)', marginBottom: 6 }}>
                        <Icon name="inbox" size={12} stroke={1.75} />
                        <span style={{ fontWeight: 500 }}>Not run</span>
                      </div>
                      <button className="btn-secondary" style={{ width: '100%', justifyContent: 'center', fontSize: 11.5, padding: '4px 8px' }}>
                        <Icon name="external" size={11} /> Tailor with {p.name}
                      </button>
                    </>
                  )}
                </div>
              );
            })}
          </div>

          {/* Diff viewer */}
          {variant.state === 'parsed' && (
            <DiffViewer
              variant={variant}
              provider={JD_PROVIDERS.find(p => p.id === tailorActive)}
              bulletStates={bulletStates}
              setBulletStates={setBulletStates}
            />
          )}
        </div>
      </div>
    </div>
  );
};

const Stat = ({ value, label, color }) => (
  <div style={{ textAlign: 'center', minWidth: 60 }}>
    <div style={{ fontSize: 18, fontWeight: 600, color: color || 'var(--fg)', fontFamily: 'var(--font-display)', fontVariantNumeric: 'tabular-nums', lineHeight: 1.1, letterSpacing: '-0.01em' }}>{value}</div>
    <div style={{ fontSize: 10, color: 'var(--fg-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 600, marginTop: 3, whiteSpace: 'nowrap' }}>{label}</div>
  </div>
);

const SourceJDStrip = ({ expanded, onToggle, company }) => {
  return (
    <div style={{ background: 'var(--surface-2)', border: '0.5px solid var(--border)', borderRadius: 8, padding: '8px 12px', display: 'flex', alignItems: 'center', gap: 10 }}>
      <CompanyMark company={company} size={20} />
      <span style={{ fontSize: 11.5, color: 'var(--fg-muted)' }}>
        Source JD parsed by <strong style={{ color: 'var(--fg)', fontWeight: 600 }}>{SOURCE_JD.parsedBy}</strong> on {SOURCE_JD.parsedAt} · {SOURCE_JD.wordCount} words
      </span>
      <div style={{ flex: 1 }} />
      <button onClick={onToggle} className="btn-secondary" style={{ fontSize: 11, padding: '3px 8px' }}>
        <Icon name={expanded ? 'chevronDown' : 'chevronRight'} size={11} stroke={2} />
        {expanded ? 'Hide details' : 'Re-parse'}
      </button>
      {expanded && (
        <div style={{ position: 'absolute', /* placeholder */ }} />
      )}
    </div>
  );
};

const DiffViewer = ({ variant, provider, bulletStates, setBulletStates }) => {
  const bullets = ORIGINAL_BULLETS.map(b => ({
    ...b,
    diff: variant.bullets[b.id] || null,
  }));

  const setBullet = (id, state) => setBulletStates(s => ({ ...s, [id]: s[id] === state ? undefined : state }));

  return (
    <div style={{ background: 'var(--surface)', border: '0.5px solid var(--border)', borderRadius: 10, overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px', borderBottom: '0.5px solid var(--border)', background: 'var(--surface-2)' }}>
        <span style={{ width: 8, height: 8, borderRadius: 4, background: provider.color }} />
        <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--fg)' }}>{provider.name}'s edits</span>
        <span style={{ fontSize: 11, color: 'var(--fg-muted)', fontFamily: 'var(--font-mono)' }}>
          confidence {Math.round(variant.confidence * 100)}% · {variant.parsedAt}
        </span>
        <div style={{ flex: 1 }} />
        <button className="btn-secondary" style={{ fontSize: 11, padding: '3px 8px' }}>
          <Icon name="check" size={11} stroke={2} /> Accept all
        </button>
        <button className="btn-secondary" style={{ fontSize: 11, padding: '3px 8px' }}>
          <Icon name="x" size={11} stroke={2} /> Reject all
        </button>
      </div>

      <div style={{ padding: '4px 0' }}>
        {bullets.map((b, i) => (
          <BulletDiff
            key={b.id}
            bullet={b}
            isFirst={i === 0}
            state={bulletStates[b.id]}
            onAccept={() => setBullet(b.id, 'accepted')}
            onReject={() => setBullet(b.id, 'rejected')}
          />
        ))}
      </div>

      <div style={{ padding: 10, borderTop: '0.5px solid var(--border)', background: 'var(--surface-2)', display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 11, color: 'var(--fg-muted)' }}>
          Pick changes to apply · accept-all clones {provider.name}'s version verbatim
        </span>
        <div style={{ flex: 1 }} />
        <button className="btn-primary" style={{ fontSize: 11.5 }}>
          Apply to resume <Icon name="arrowRight" size={11} />
        </button>
      </div>
    </div>
  );
};

const BulletDiff = ({ bullet, isFirst, state, onAccept, onReject }) => {
  const hasDiff = !!bullet.diff;
  const accepted = state === 'accepted';
  const rejected = state === 'rejected';

  return (
    <div style={{
      padding: '12px 14px',
      borderTop: isFirst ? 'none' : '0.5px solid var(--border-subtle)',
      background: accepted ? 'oklch(0.985 0.02 155)' : rejected ? 'oklch(0.985 0.015 30)' : 'transparent',
      transition: 'background 120ms',
      display: 'flex', alignItems: 'flex-start', gap: 14,
    }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 10.5, color: 'var(--fg-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 600, marginBottom: 6, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {bullet.section}
        </div>

        {/* Original */}
        <div style={{ display: 'flex', gap: 8, marginBottom: hasDiff ? 4 : 0 }}>
          <span style={{ width: 14, fontSize: 10.5, color: 'var(--fg-muted)', fontFamily: 'var(--font-mono)', flexShrink: 0, paddingTop: 2 }}>{hasDiff ? '–' : ' '}</span>
          <div style={{
            fontSize: 12.5, lineHeight: 1.5,
            color: hasDiff ? 'var(--fg-muted)' : 'var(--fg)',
            textDecoration: hasDiff && rejected ? 'none' : (hasDiff ? 'line-through' : 'none'),
            textDecorationColor: 'oklch(0.7 0.05 240)',
            textDecorationThickness: '0.5px',
          }}>
            {bullet.text}
          </div>
        </div>

        {/* New (with diff highlighting) */}
        {hasDiff && (
          <div style={{ display: 'flex', gap: 8 }}>
            <span style={{ width: 14, fontSize: 10.5, color: 'oklch(0.5 0.14 155)', fontFamily: 'var(--font-mono)', flexShrink: 0, paddingTop: 2, fontWeight: 600 }}>+</span>
            <div style={{ fontSize: 12.5, lineHeight: 1.5, color: 'var(--fg)' }}>
              {bullet.diff.map((seg, j) => {
                if (seg.t === 'keep') return <span key={j}>{seg.s}</span>;
                if (seg.t === 'add') return (
                  <span key={j} style={{
                    background: 'oklch(0.94 0.06 155)',
                    color: 'oklch(0.32 0.13 155)',
                    padding: '0 2px',
                    borderRadius: 3,
                    boxShadow: 'inset 0 -1px 0 oklch(0.7 0.13 155)',
                  }}>{seg.s}</span>
                );
                if (seg.t === 'remove') return (
                  <span key={j} style={{
                    background: 'oklch(0.96 0.04 30)',
                    color: 'oklch(0.55 0.14 30)',
                    padding: '0 2px',
                    borderRadius: 3,
                    textDecoration: 'line-through',
                    textDecorationThickness: '0.5px',
                  }}>{seg.s}</span>
                );
                return null;
              })}
            </div>
          </div>
        )}
      </div>

      {/* Controls */}
      <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
        {hasDiff ? (
          <>
            <button
              onClick={onAccept}
              title="Accept this change"
              style={{
                padding: '4px 6px', background: accepted ? 'oklch(0.55 0.14 155)' : 'var(--surface-2)',
                color: accepted ? 'white' : 'var(--fg-muted)',
                border: `0.5px solid ${accepted ? 'oklch(0.55 0.14 155)' : 'var(--border)'}`,
                borderRadius: 5, cursor: 'pointer', display: 'flex', alignItems: 'center',
              }}>
              <Icon name="check" size={12} stroke={2} />
            </button>
            <button
              onClick={onReject}
              title="Reject this change"
              style={{
                padding: '4px 6px', background: rejected ? 'oklch(0.55 0.14 30)' : 'var(--surface-2)',
                color: rejected ? 'white' : 'var(--fg-muted)',
                border: `0.5px solid ${rejected ? 'oklch(0.55 0.14 30)' : 'var(--border)'}`,
                borderRadius: 5, cursor: 'pointer', display: 'flex', alignItems: 'center',
              }}>
              <Icon name="x" size={12} stroke={2} />
            </button>
          </>
        ) : (
          <span style={{ fontSize: 10.5, color: 'var(--fg-muted)', padding: '4px 6px', fontStyle: 'italic' }}>kept as-is</span>
        )}
      </div>
    </div>
  );
};

