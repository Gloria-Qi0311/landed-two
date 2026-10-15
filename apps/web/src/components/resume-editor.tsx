// An ordinary resume (an upload or a version), edited in place: click any
// text to change it; add or remove entries. The extension auto-fills from
// these fields, so what you fix here is what employers' forms get.
import type { ReactNode } from 'react'
import { blankEntry, type EducationEntry, type ExperienceEntry, type ProjectEntry, type Resume } from '@landed/schema'
import { EditableList, EditableText } from './editable'
import { Icon } from './primitives'

const sectionLabel = { fontSize: 11, fontWeight: 600, color: 'var(--fg-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' } as const
const block = { background: 'var(--surface)', boxShadow: 'var(--shadow-sm)', borderRadius: 12, padding: 16, display: 'flex', flexDirection: 'column', gap: 10 } as const
const kvLabel = { fontSize: 10.5, color: 'var(--fg-muted)', marginBottom: 1 } as const

function Section({ title, onAdd, addLabel, children }: { title: string; onAdd?: () => void; addLabel?: string; children: ReactNode }) {
  return (
    <div style={block}>
      <div style={{ display: 'flex', alignItems: 'center' }}>
        <div style={sectionLabel}>{title}</div>
        {onAdd && (
          <button type="button" className="btn-secondary" onClick={onAdd} style={{ marginLeft: 'auto', fontSize: 11, padding: '2px 8px' }}>
            <Icon name="plus" size={11} /> {addLabel ?? 'Add'}
          </button>
        )}
      </div>
      {children}
    </div>
  )
}

function Kv({ k, v, onSave }: { k: string; v: string; onSave: (v: string) => void }) {
  return (
    <div style={{ minWidth: 0 }}>
      <div style={kvLabel}>{k}</div>
      <div style={{ fontSize: 12.5, overflowWrap: 'anywhere' }}><EditableText label={k} value={v} placeholder="Add" onSave={onSave} /></div>
    </div>
  )
}

function RemoveButton({ onClick, what }: { onClick: () => void; what: string }) {
  return (
    <button type="button" className="icon-btn" title={`Remove ${what}`} aria-label={`Remove ${what}`} onClick={onClick}
      style={{ background: 'transparent', border: 'none', color: 'var(--fg-muted)', cursor: 'pointer', padding: 2, display: 'flex', flexShrink: 0 }}>
      <Icon name="x" size={12} />
    </button>
  )
}

const dates = (start: string, end: string, set: (patch: { start_date?: string; end_date?: string }) => void) => (
  <span style={{ fontSize: 11.5, color: 'var(--fg-muted)', whiteSpace: 'nowrap' }}>
    <EditableText label="start date" value={start} placeholder="start" onSave={(start_date) => set({ start_date })} />
    {' – '}
    <EditableText label="end date" value={end} placeholder="end" onSave={(end_date) => set({ end_date })} />
  </span>
)

export function ResumeEditor({ resume, onChange }: { resume: Resume; onChange: (next: Resume) => void }) {
  const set = (patch: Partial<Resume>) => onChange({ ...resume, ...patch })
  const setBasic = (k: keyof Resume['basic']) => (v: string) => set({ basic: { ...resume.basic, [k]: v } })
  const setIntent = (k: keyof Resume['intent']) => (v: string) => set({ intent: { ...resume.intent, [k]: v } })

  const jobs = (key: 'experience' | 'internship', title: string) => {
    const list = resume[key]
    const update = (i: number, patch: Partial<ExperienceEntry>) => set({ [key]: list.map((e, j) => (j === i ? { ...e, ...patch } : e)) })
    return (
      <Section title={title} addLabel={key === 'internship' ? 'Add internship' : 'Add job'} onAdd={() => set({ [key]: [...list, blankEntry('experience') as ExperienceEntry] })}>
        {list.length === 0 && <div style={{ fontSize: 12, color: 'var(--fg-muted)' }}>None yet.</div>}
        {list.map((e, i) => (
          <div key={i} style={{ borderTop: i ? '0.5px solid var(--border-subtle)' : 'none', paddingTop: i ? 10 : 0 }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 13, fontWeight: 600 }}><EditableText label="company" value={e.company} placeholder="Company" onSave={(company) => update(i, { company })} /></span>
              <span style={{ fontSize: 12.5 }}><EditableText label="title" value={e.title} placeholder="Title" onSave={(title) => update(i, { title })} /></span>
              <span style={{ fontSize: 11.5, color: 'var(--fg-muted)' }}><EditableText label="location" value={e.location} placeholder="location" onSave={(location) => update(i, { location })} /></span>
              <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6 }}>
                {dates(e.start_date, e.end_date, (p) => update(i, p))}
                <RemoveButton what={e.company || 'this entry'} onClick={() => set({ [key]: list.filter((_, j) => j !== i) })} />
              </span>
            </div>
            <div style={{ fontSize: 12.5, lineHeight: 1.55, marginTop: 6 }}>
              <EditableText label="description" multiline value={e.description} placeholder="What you did — one bullet per line (⌘/Ctrl+Enter to save)"
                onSave={(description) => update(i, { description })} />
            </div>
          </div>
        ))}
      </Section>
    )
  }

  const updateProject = (i: number, patch: Partial<ProjectEntry>) => set({ projects: resume.projects.map((e, j) => (j === i ? { ...e, ...patch } : e)) })
  const updateEdu = (i: number, patch: Partial<EducationEntry>) => set({ education: resume.education.map((e, j) => (j === i ? { ...e, ...patch } : e)) })

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={block}>
        <div style={{ fontSize: 16, fontWeight: 600 }}><EditableText label="name" value={resume.basic.name} placeholder="Your name" onSave={setBasic('name')} /></div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(170px, 1fr))', gap: 10 }}>
          <Kv k="Email" v={resume.basic.email} onSave={setBasic('email')} />
          <Kv k="Phone" v={resume.basic.phone} onSave={setBasic('phone')} />
          <Kv k="Location" v={resume.basic.location} onSave={setBasic('location')} />
          <Kv k="LinkedIn" v={resume.basic.linkedin} onSave={setBasic('linkedin')} />
          <Kv k="GitHub" v={resume.basic.github} onSave={setBasic('github')} />
          <Kv k="Portfolio" v={resume.basic.portfolio} onSave={setBasic('portfolio')} />
        </div>
        <div>
          <div style={kvLabel}>Summary</div>
          <div style={{ fontSize: 12.5, lineHeight: 1.55 }}>
            <EditableText label="summary" multiline value={resume.summary} placeholder="A sentence or two about you" onSave={(summary) => set({ summary })} />
          </div>
        </div>
      </div>

      {jobs('experience', 'Experience')}
      {jobs('internship', 'Internships')}

      <Section title="Projects" addLabel="Add project" onAdd={() => set({ projects: [...resume.projects, blankEntry('projects') as ProjectEntry] })}>
        {resume.projects.length === 0 && <div style={{ fontSize: 12, color: 'var(--fg-muted)' }}>None yet.</div>}
        {resume.projects.map((p, i) => (
          <div key={i} style={{ borderTop: i ? '0.5px solid var(--border-subtle)' : 'none', paddingTop: i ? 10 : 0 }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 13, fontWeight: 600 }}><EditableText label="project name" value={p.name} placeholder="Project" onSave={(name) => updateProject(i, { name })} /></span>
              <span style={{ fontSize: 12.5 }}><EditableText label="your role" value={p.role} placeholder="Your role" onSave={(role) => updateProject(i, { role })} /></span>
              <span style={{ fontSize: 11.5, color: 'var(--fg-muted)', overflowWrap: 'anywhere' }}><EditableText label="link" value={p.link} placeholder="link" onSave={(link) => updateProject(i, { link })} /></span>
              <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6 }}>
                {dates(p.start_date, p.end_date, (d) => updateProject(i, d))}
                <RemoveButton what={p.name || 'this project'} onClick={() => set({ projects: resume.projects.filter((_, j) => j !== i) })} />
              </span>
            </div>
            <div style={{ fontSize: 12.5, lineHeight: 1.55, marginTop: 6 }}>
              <EditableText label="description" multiline value={p.description} placeholder="What it is and what you did" onSave={(description) => updateProject(i, { description })} />
            </div>
          </div>
        ))}
      </Section>

      <Section title="Education" addLabel="Add school" onAdd={() => set({ education: [...resume.education, blankEntry('education') as EducationEntry] })}>
        {resume.education.map((ed, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap', borderTop: i ? '0.5px solid var(--border-subtle)' : 'none', paddingTop: i ? 8 : 0 }}>
            <span style={{ fontSize: 13, fontWeight: 600 }}><EditableText label="school" value={ed.school} placeholder="School" onSave={(school) => updateEdu(i, { school })} /></span>
            <span style={{ fontSize: 12.5 }}><EditableText label="degree" value={ed.degree} placeholder="Degree" onSave={(degree) => updateEdu(i, { degree })} /></span>
            <span style={{ fontSize: 12.5 }}><EditableText label="major" value={ed.major} placeholder="Major" onSave={(major) => updateEdu(i, { major })} /></span>
            <span style={{ fontSize: 11.5, color: 'var(--fg-muted)' }}>GPA <EditableText label="GPA" value={ed.gpa} placeholder="—" onSave={(gpa) => updateEdu(i, { gpa })} /></span>
            <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6 }}>
              {dates(ed.start_date, ed.end_date, (d) => updateEdu(i, d))}
              <RemoveButton what={ed.school || 'this school'} onClick={() => set({ education: resume.education.filter((_, j) => j !== i) })} />
            </span>
          </div>
        ))}
      </Section>

      <div style={block}>
        <div>
          <div style={kvLabel}>Skills</div>
          <div style={{ fontSize: 12.5 }}><EditableList label="skills" items={resume.skills} placeholder="Comma-separated, e.g. SQL, Python, Figma" onSave={(skills) => set({ skills })} /></div>
        </div>
        <div>
          <div style={kvLabel}>Languages</div>
          <div style={{ fontSize: 12.5 }}><EditableList label="languages" items={resume.languages} placeholder="e.g. English, 中文" onSave={(languages) => set({ languages })} /></div>
        </div>
      </div>

      <div style={block}>
        <div style={sectionLabel}>For application forms</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(170px, 1fr))', gap: 10 }}>
          <Kv k="Target role" v={resume.intent.apply_position} onSave={setIntent('apply_position')} />
          <Kv k="Years of experience" v={resume.intent.years_exp} onSave={setIntent('years_exp')} />
          <Kv k="Expected salary" v={resume.intent.salary} onSave={setIntent('salary')} />
          <Kv k="Available from" v={resume.intent.available_date} onSave={setIntent('available_date')} />
        </div>
      </div>
    </div>
  )
}
