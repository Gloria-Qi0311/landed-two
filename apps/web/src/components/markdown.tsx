// Minimal Markdown for agent replies: paragraphs, headings, lists, fenced
// code, **bold**, *italic*, `code` and http(s) links. Builds React elements
// directly — never HTML strings — so agent output can't inject markup.
import type { ReactNode } from 'react'

const INLINE = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\[[^\]\n]+\]\((https?:\/\/[^)\s]+)\))|(\*[^*\s\n][^*\n]*\*)|(https?:\/\/[^\s)]+)/g

function inline(text: string, key: string): ReactNode[] {
  const out: ReactNode[] = []
  let last = 0
  let i = 0
  for (const m of text.matchAll(INLINE)) {
    if (m.index! > last) out.push(text.slice(last, m.index))
    const k = `${key}-${i++}`
    const [tok] = m
    if (m[1]) out.push(<code key={k} style={{ fontFamily: 'var(--font-mono)', fontSize: '0.92em', padding: '0 4px', borderRadius: 4, background: 'var(--surface-3)' }}>{tok.slice(1, -1)}</code>)
    else if (m[2]) out.push(<strong key={k}>{inline(tok.slice(2, -2), k)}</strong>)
    else if (m[3]) out.push(<a key={k} href={m[4]} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--accent)' }}>{tok.slice(1, tok.indexOf(']('))}</a>)
    else if (m[5]) out.push(<em key={k}>{tok.slice(1, -1)}</em>)
    else if (m[6]) out.push(<a key={k} href={tok} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--accent)', wordBreak: 'break-all' }}>{tok}</a>)
    last = m.index! + tok.length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

export function Markdown({ text }: { text: string }) {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const blocks: ReactNode[] = []
  let para: string[] = []
  let list: { ordered: boolean; items: string[] } | null = null

  const flushPara = () => {
    if (para.length) {
      const k = `p${blocks.length}`
      blocks.push(<p key={k} style={{ margin: '0 0 8px' }}>{para.flatMap((l, i) => (i ? [<br key={`${k}-br${i}`} />, ...inline(l, `${k}-${i}`)] : inline(l, `${k}-${i}`)))}</p>)
      para = []
    }
  }
  const flushList = () => {
    if (list) {
      const k = `l${blocks.length}`
      const items = list.items.map((it, i) => <li key={`${k}-${i}`} style={{ margin: '2px 0' }}>{inline(it, `${k}-${i}`)}</li>)
      blocks.push(list.ordered
        ? <ol key={k} style={{ margin: '0 0 8px', paddingLeft: 20 }}>{items}</ol>
        : <ul key={k} style={{ margin: '0 0 8px', paddingLeft: 18 }}>{items}</ul>)
      list = null
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line.startsWith('```')) {
      flushPara(); flushList()
      const code: string[] = []
      while (++i < lines.length && !lines[i].startsWith('```')) code.push(lines[i])
      blocks.push(<pre key={`c${blocks.length}`} style={{ margin: '0 0 8px', padding: '8px 10px', borderRadius: 6, background: 'var(--surface-3)', overflowX: 'auto', fontSize: 11.5 }}><code style={{ fontFamily: 'var(--font-mono)' }}>{code.join('\n')}</code></pre>)
      continue
    }
    const heading = line.match(/^(#{1,4})\s+(.*)$/)
    const bullet = line.match(/^\s*[-*•]\s+(.*)$/)
    const numbered = line.match(/^\s*\d+[.)]\s+(.*)$/)
    if (heading) {
      flushPara(); flushList()
      blocks.push(<div key={`h${blocks.length}`} style={{ fontWeight: 600, margin: '4px 0 6px' }}>{inline(heading[2], `h${blocks.length}`)}</div>)
    } else if (bullet || numbered) {
      flushPara()
      const ordered = !!numbered
      if (list && list.ordered !== ordered) flushList()
      list ??= { ordered, items: [] }
      list.items.push((bullet ?? numbered)![1])
    } else if (!line.trim()) {
      flushPara(); flushList()
    } else {
      flushList()
      para.push(line)
    }
  }
  flushPara(); flushList()
  return <div style={{ lineHeight: 1.55 }}>{blocks}</div>
}
