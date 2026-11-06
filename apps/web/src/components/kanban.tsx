// Kanban view with drag-and-drop between stages (optimistic update on drop).
// Columns: Leads → Applied → OA / Test → Interview → Offer → Rejected.
// Leads holds what you haven't applied to yet: jobs your agents found
// (✕ dismisses; tick some and "Approve N" saves them for later, undoably)
// and jobs you saved for later (stage `saved`), highest priority first.
// Dragging either into a stage adds/moves it. Ghosted applications sit in
// Rejected with a tag; Interview cards show their latest round. In every
// column, a company's cards sit together under its name (same company by
// company key, so 蚂蚁集团 and 蚂蚁 are one), in the column's own order.
import React, { useState, useMemo, type CSSProperties, type ReactNode } from 'react';
import type { DragEndEvent, UniqueIdentifier } from '@dnd-kit/core';
import type { Stage } from '@landed/observation-processor';
import type { BoardApp, BoardCompany } from '../hooks/queries';
import type { DbJobLead } from '../lib/store';
import type { MarkCompany, StageColor } from './primitives';
import {
  DndContext,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  useDraggable,
  useDroppable,
  DragOverlay,
} from '@dnd-kit/core';
import { currentRound, formatWhen, roundLabel } from '@landed/schema/pipeline';
import { DeadlineChip } from './deadline-chip';
import { CompanyMark, Icon, stageColors } from './primitives';
import { ApplyNextBatch, LeadAssistButton } from './apply-assist';
import { STAGES, columnOf } from '../data';
import { findDuplicateAppIds } from '../lib/duplicates';
import type { SupplyCheck } from '../lib/supply';
import { byPriority, rankOf } from '../lib/fit';
import type { Approval } from '../lib/inbox';
import { companyKey } from '@landed/observation-processor';
import { ago, agoShort, FitLine, FoldedLeads, FoldedRow, insideCard, LeadDetails, sourceOn } from './leads';

// ────────────────────────────────────────────────────────────────────────
// Pure card markup (shared between sortable card + DragOverlay preview).
// Extracted so the floating overlay can render identical visuals.
// ────────────────────────────────────────────────────────────────────────
type SetDeadline = (id: string, deadline: string | null) => void;
type CardProps = {
  app: BoardApp; comp: MarkCompany; c: StageColor; isDuplicate?: boolean; onSetDeadline?: SetDeadline; grouped?: boolean;
};

function CardContent({ app, comp, c, isDuplicate, onSetDeadline, grouped }: CardProps) {
  const round = columnOf(app.stage) === 'interview' ? currentRound(app.interviews) : null;
  return (
    <>
      {/* In a company group the group header names the company. */}
      {!grouped && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <CompanyMark company={comp} size={22} />
          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--fg-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>{comp.name}</div>
        </div>
      )}
      <div>
        <div style={{ fontSize: 13, color: 'var(--fg)', fontWeight: 550, lineHeight: 1.35, letterSpacing: '-0.005em' }}>{app.role}</div>
        {app.location && <div style={{ fontSize: 11, color: 'var(--fg-muted)', marginTop: 2 }}>{app.location}</div>}
      </div>
      {app.stage === 'ghosted' && (
        <span style={{ fontSize: 10, color: stageColors.ghosted.fg, background: stageColors.ghosted.bg, border: `0.5px solid ${stageColors.ghosted.ring}`, padding: '1px 6px', borderRadius: 4, width: 'fit-content' }}>
          Ghosted
        </span>
      )}
      {round && (
        <span title={app.interviews.length > 1 ? `${app.interviews.length} rounds so far` : undefined} style={{
          fontSize: 10.5, color: stageColors.interview.fg, background: stageColors.interview.bg, border: `0.5px solid ${stageColors.interview.ring}`,
          padding: '1px 6px', borderRadius: 4, width: 'fit-content', display: 'flex', flexDirection: 'column', gap: 1,
        }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <Icon name={round.format === 'onsite' ? 'map' : 'device'} size={10} />
            {roundLabel(round)}
          </span>
          {round.at && <span style={{ fontWeight: 600 }}>{formatWhen(round.at)}</span>}
        </span>
      )}
      {app.stage === 'saved' && onSetDeadline && <DeadlineChip compact deadline={app.deadline} onSave={(d) => onSetDeadline(app.id, d)} />}
      {isDuplicate && (
        <div
          title="Looks like another application here (same company, same role or link). Merge them on the Agent page."
          style={{
            fontSize: 10, color: 'oklch(0.42 0.12 60)',
            background: 'oklch(0.97 0.04 60)',
            border: '0.5px solid oklch(0.85 0.06 60)',
            padding: '1px 6px', borderRadius: 4, width: 'fit-content',
            display: 'flex', alignItems: 'center', gap: 4,
          }}
        >
          <Icon name="alert" size={9} /> Possible duplicate
        </div>
      )}
      {app.nextStep && app.nextStep !== '—' && (
        <div style={{ fontSize: 10.5, color: c.fg, display: 'flex', alignItems: 'center', gap: 4, background: c.bg, padding: '3px 6px', borderRadius: 5, marginTop: -2, width: 'fit-content' }}>
          <Icon name={app.stage === 'offer' ? 'sparkle' : 'calendar'} size={10} />
          {app.nextStep}
        </div>
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 10.5, color: 'var(--fg-muted)' }}>
        {app.referral && <span style={{ background: 'oklch(0.96 0.03 90)', color: 'oklch(0.42 0.1 90)', padding: '1px 5px', borderRadius: 4, fontSize: 10 }}>referral</span>}
        <span style={{ fontVariantNumeric: 'tabular-nums' }}>{app.appliedDays === 0 ? 'draft' : `${app.appliedDays}d ago`}</span>
        {app.starred && <Icon name="star" size={11} stroke={2} />}
      </div>
    </>
  );
}

// ────────────────────────────────────────────────────────────────────────
// Draggable card. PointerSensor's activationConstraint distinguishes drag
// from click — a quick tap fires onOpen; a >5px drag enters drag mode.
// ────────────────────────────────────────────────────────────────────────
function DraggableCard({ app, comp, c, onOpen, isDuplicate, onSetDeadline, grouped }: CardProps & { onOpen: (id: string) => void }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: app.id });
  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      onClick={() => { if (!isDragging) onOpen(app.id); }}
      style={{
        // In a company card each application is a row; otherwise a card of its own.
        ...(grouped
          ? { padding: '9px 12px 10px', borderTop: '1px solid var(--border-subtle)', gap: 6 }
          : { background: 'var(--surface)', borderRadius: 10, boxShadow: 'var(--shadow-sm)', padding: 12, gap: 9 }),
        cursor: isDragging ? 'grabbing' : 'grab',
        display: 'flex', flexDirection: 'column',
        opacity: isDragging ? 0.35 : 1,
        // Hide the source while DragOverlay renders the floating preview
        visibility: isDragging ? 'hidden' : 'visible',
      }}
      className={grouped ? 'kanban-row' : 'kanban-card'}
    >
      <CardContent app={app} comp={comp} c={c} isDuplicate={isDuplicate} onSetDeadline={onSetDeadline} grouped={grouped} />
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────
// Company groups: a column's cards, a company's together, in the column's
// order (a group sits where its first card would). One card → no group.
// ────────────────────────────────────────────────────────────────────────
type Group<T> = { key: string; name: string; items: T[] };

function byCompany<T>(items: T[], nameOf: (item: T) => string | undefined): Group<T>[] {
  const groups = new Map<string, Group<T>>();
  for (const item of items) {
    const name = nameOf(item) || '';
    const key = companyKey(name) || name.trim().toLowerCase();
    if (!groups.has(key)) groups.set(key, { key, name, items: [] });
    groups.get(key)!.items.push(item);
  }
  return [...groups.values()];
}

function CompanyGroup({ name, mark, count, children }: { name: string; mark: MarkCompany; count: number; children: ReactNode }) {
  // flexShrink 0: in a lane that overflows, `overflow: hidden` would let the
  // group shrink to nothing (cards keep their height; groups vanished).
  return (
    <div style={{ background: 'var(--surface)', borderRadius: 10, boxShadow: 'var(--shadow-sm)', overflow: 'hidden', display: 'flex', flexDirection: 'column', flexShrink: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px 9px' }}>
        <CompanyMark company={mark} size={22} />
        <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--fg-muted)', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</span>
        <span style={{ fontSize: 11, color: 'var(--fg-muted)', fontVariantNumeric: 'tabular-nums' }}>{count}</span>
      </div>
      {children}
    </div>
  );
}

// A lane: a soft column with its name and count; no box around it.
const laneStyle = (over: boolean, tint: string): CSSProperties => ({
  minWidth: 276, width: 276, flexShrink: 0, borderRadius: 14,
  background: over ? tint : 'oklch(from var(--surface-3) l c h / 0.55)',
  display: 'flex', flexDirection: 'column', maxHeight: '100%',
  transition: 'background 120ms',
});
const laneCount: CSSProperties = { marginLeft: 'auto', fontSize: 11.5, fontWeight: 500, fontVariantNumeric: 'tabular-nums', color: 'var(--fg-muted)' };

// ────────────────────────────────────────────────────────────────────────
// Droppable column. Highlights its border/background when an active drag
// is hovering over it.
// ────────────────────────────────────────────────────────────────────────
type ColumnProps = {
  stage: { id: string; label: string }; items: BoardApp[]; c: StageColor; getCompany: (id: string) => MarkCompany;
  onOpen: (id: string) => void; duplicateIds: Set<string>;
};

function DroppableColumn({ stage, items, c, getCompany, onOpen, duplicateIds }: ColumnProps) {
  const { setNodeRef, isOver } = useDroppable({ id: stage.id });
  return (
    <div ref={setNodeRef} style={laneStyle(isOver, c.bg)}>
      <div style={{ padding: '12px 14px 8px', display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ width: 8, height: 8, borderRadius: 4, background: c.dot }} />
        <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--fg)' }}>{stage.label}</span>
        <span style={laneCount}>{items.length}</span>
      </div>
      <div style={{ padding: '2px 8px 10px', display: 'flex', flexDirection: 'column', gap: 8, overflowY: 'auto', flex: 1 }}>
        {/* Most recent first; a company's cards together. */}
        {byCompany([...items].sort((x, y) => (x.lastActivity ?? 0) - (y.lastActivity ?? 0)), (a) => getCompany(a.companyId).name).map((g) => {
          if (g.items.length === 1) {
            const a = g.items[0];
            return <DraggableCard key={a.id} app={a} comp={getCompany(a.companyId)} c={c} onOpen={onOpen} isDuplicate={duplicateIds.has(a.id)} />;
          }
          const comp = getCompany(g.items[0].companyId);
          return (
            <CompanyGroup key={g.key} name={comp.name} mark={comp} count={g.items.length}>
              {g.items.map((a) => <DraggableCard key={a.id} app={a} comp={getCompany(a.companyId)} c={c} onOpen={onOpen} isDuplicate={duplicateIds.has(a.id)} grouped />)}
            </CompanyGroup>
          );
        })}
        {items.length === 0 && (
          <div style={{ fontSize: 11.5, color: 'var(--fg-muted)', textAlign: 'center', padding: '18px 8px', opacity: 0.8 }}>Nothing here yet</div>
        )}
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────
// Leads — jobs agents found (job_leads, status 'new'). Dashed cards: not in
// the pipeline yet. Draggable ids are prefixed so they can't collide with
// application ids.
// ────────────────────────────────────────────────────────────────────────
const LEAD_PREFIX = 'lead:';

const leadMark = (lead: DbJobLead): MarkCompany => ({ name: lead.company_name, hue: null, logo: null });

type LeadProps = {
  lead: DbJobLead; onDismiss?: (id: string) => void; onOpen?: (lead: DbJobLead) => void; onSetDeadline?: SetDeadline; grouped?: boolean;
  /** picked for "Approve N" */
  selected?: boolean; onSelect?: (id: string, on: boolean) => void;
};

function LeadCardContent({ lead, onDismiss, onOpen, onSetDeadline, grouped, selected, onSelect, details }: LeadProps & { details?: { open: boolean; toggle: () => void } }) {
  const agents = [...new Set(lead.sources.map((s) => sourceOn(lead, s.provider)))];
  const stop = (e: { stopPropagation(): void }) => e.stopPropagation();
  const detailsId = `lead-details-${lead.id}`;
  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        {onSelect && (
          <input type="checkbox" checked={!!selected} onChange={(e) => onSelect(lead.id, e.target.checked)} {...insideCard} onClick={stop}
            aria-label={`Select ${lead.company_name} · ${lead.title}`} style={{ margin: 0, flexShrink: 0, alignSelf: grouped ? 'flex-start' : 'center', marginTop: grouped ? 3 : 0 }} />
        )}
        {grouped ? (
          // In a company group: the title leads, the group header names the company.
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontSize: 13, color: 'var(--fg)', fontWeight: 550, lineHeight: 1.35 }}>{lead.title}</div>
            {lead.location && <div style={{ fontSize: 11, color: 'var(--fg-muted)', marginTop: 2 }}>{lead.location}</div>}
          </div>
        ) : (
          <>
            <CompanyMark company={leadMark(lead)} size={22} />
            <div style={{ minWidth: 0, flex: 1, fontSize: 12, fontWeight: 600, color: 'var(--fg-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{lead.company_name}</div>
          </>
        )}
        {lead.job_url && (
          <a href={lead.job_url} target="_blank" rel="noopener noreferrer" title="Open job posting" {...insideCard}
            onClick={(e) => { stop(e); onOpen?.(lead); }}
            style={{ color: 'var(--fg-muted)', display: 'flex', padding: 2 }}>
            <Icon name="external" size={11} />
          </a>
        )}
        <LeadAssistButton lead={lead} />
        {onDismiss && (
          <button type="button" title="Not interested" aria-label="Dismiss lead" {...insideCard}
            onClick={(e) => { stop(e); onDismiss(lead.id); }}
            style={{ background: 'transparent', border: 'none', color: 'var(--fg-muted)', cursor: 'pointer', padding: 2, display: 'flex' }}>
            <Icon name="x" size={12} />
          </button>
        )}
      </div>
      {!grouped && (
        <div>
          <div style={{ fontSize: 13, color: 'var(--fg)', fontWeight: 550, lineHeight: 1.35 }}>{lead.title}</div>
          {lead.location && <div style={{ fontSize: 11, color: 'var(--fg-muted)', marginTop: 2 }}>{lead.location}</div>}
        </div>
      )}
      {onSetDeadline && <DeadlineChip compact deadline={lead.deadline} onSave={(d) => onSetDeadline(lead.id, d)} />}
      <FitLine lead={lead} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 10.5, color: 'var(--fg-muted)' }}>
        <Icon name="wand" size={10} />
        <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          found by {agents.join(', ')}{lead.sources.length > 1 ? ` · ${lead.sources.length}×` : ''}{lead.posted_at ? ` · posted ${agoShort(lead.posted_at)}` : ''}
        </span>
        {details && (
          <button type="button" className="btn-ghost" aria-expanded={details.open} aria-controls={detailsId} {...insideCard}
            onClick={(e) => { stop(e); details.toggle(); }}
            style={{ fontSize: 10.5, color: 'var(--fg-muted)', padding: '1px 4px', display: 'flex', alignItems: 'center', gap: 3, flexShrink: 0 }}>
            Details <Icon name={details.open ? 'chevronDown' : 'chevronRight'} size={9} />
          </button>
        )}
      </div>
      {details?.open && <LeadDetails lead={lead} id={detailsId} />}
    </>
  );
}

const leadCardStyle: CSSProperties = {
  background: 'var(--surface)',
  borderRadius: 10,
  boxShadow: 'var(--shadow-sm)',
  padding: 12,
  display: 'flex', flexDirection: 'column', gap: 9,
};

function DraggableLeadCard({ lead, onDismiss, onOpen, onSetDeadline, grouped, selected, onSelect }: LeadProps) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: LEAD_PREFIX + lead.id });
  const [open, setOpen] = useState(false);
  // A picked card is marked: an accent ring on a card, a tint on a row.
  const picked: CSSProperties = selected ? (grouped ? { background: 'var(--accent-soft)' } : { boxShadow: '0 0 0 1.5px var(--accent), var(--shadow-sm)' }) : {};
  return (
    <div ref={setNodeRef} {...attributes} {...listeners} className={grouped ? 'kanban-row' : 'kanban-card'}
      title={open ? undefined : lead.description || undefined}
      style={{ ...(grouped ? { padding: '9px 12px 10px', borderTop: '1px solid var(--border-subtle)', display: 'flex', flexDirection: 'column', gap: 6 } : leadCardStyle), ...picked, cursor: isDragging ? 'grabbing' : 'grab', visibility: isDragging ? 'hidden' : 'visible' }}>
      <LeadCardContent lead={lead} onDismiss={onDismiss} onOpen={onOpen} onSetDeadline={onSetDeadline} grouped={grouped}
        selected={selected} onSelect={onSelect} details={{ open, toggle: () => setOpen(!open) }} />
    </div>
  );
}

/** Checking the public job lists now (hooks/supply.ts); refresh is null
 *  without an active search to fit. */
export type LeadsRefresh = { refresh: (() => void) | null; running: boolean; last: SupplyCheck | null; error: string | null };

type LeadsColumnProps = {
  leads: DbJobLead[]; queueLeads: DbJobLead[]; saved: BoardApp[]; onDismiss?: (id: string) => void; onOpen?: (lead: DbJobLead) => void;
  onOpenApp: (id: string) => void; getCompany: (id: string) => MarkCompany; duplicateIds: Set<string>;
  onSetLeadDeadline?: SetDeadline; onSetAppDeadline?: SetDeadline; refresh?: LeadsRefresh;
  filtered?: DbJobLead[]; onPutBack?: (lead: DbJobLead) => void;
  /** leads whose posting is gone from its source */
  closed?: DbJobLead[];
  /** the lead a saved application came from (its fit ranks the card) */
  leadForApp?: (appId: string) => DbJobLead | undefined;
  onApprove?: (leads: DbJobLead[]) => Promise<{ approved: Approval[]; failed: string[] }>; onUndoApprove?: (approvals: Approval[]) => Promise<number>;
};

const smallBtn: CSSProperties = { fontSize: 11.5, padding: '4px 9px' };

/** Picked leads → "Approve N"; afterwards, what happened and a way back. */
function ApproveBar({ count, total, onApprove, onSelectAll, onClear, busy }: {
  count: number; total: number; onApprove: () => void; onSelectAll: () => void; onClear: () => void; busy: boolean;
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
      <button type="button" className="btn-primary" disabled={busy} onClick={onApprove} style={smallBtn}
        title="Authorize Landed to fill, review and submit these applications; human-only blockers still wait for you">
        Approve {count}
      </button>
      {count < total && <button type="button" className="btn-ghost" onClick={onSelectAll} style={smallBtn}>Select all {total}</button>}
      <button type="button" className="btn-ghost" onClick={onClear} style={smallBtn}>Clear</button>
    </div>
  );
}

/** "Checked SimplifyJobs and 4 company boards · 3 new" after a check, or what went wrong. */
function refreshNote(r: LeadsRefresh): string | null {
  if (r.running) return 'Checking job lists and company boards…';
  if (r.error) return "Couldn't check the job lists";
  const last = r.last;
  if (!last) return null;
  const listsOk = last.lists.length > 0 && last.failed.length < last.lists.length;
  const jobrightOk = (last.jobright?.lists.length ?? 0) > (last.jobright?.failed.length ?? 0);
  const boardsOk = last.boards - last.boards_failed.length;
  const checked = [listsOk && 'SimplifyJobs', jobrightOk && 'jobright', boardsOk > 0 && `${boardsOk} company board${boardsOk === 1 ? '' : 's'}`].filter(Boolean).join(', ').replace(/, ([^,]*)$/, ' and $1');
  if (!checked) return last.lists.length === 0 && last.boards === 0 && !last.jobright?.lists.length
    ? 'Nothing to check: the job lists carry internships and new-grad roles, and no company is followed yet'
    : "Couldn't reach the job lists or company boards";
  return `Checked ${checked} · ${last.added ? `${last.added} new` : 'nothing new'}${last.closed ? ` · ${last.closed} closed` : ''}`;
}
// A Leads card: an agent-found job, or an application not applied to yet.
type LeadItem = { lead: DbJobLead; app?: undefined; deadline: string | null } | { app: BoardApp; lead?: undefined; deadline: string | null };

function LeadsColumn({ leads, queueLeads, saved, onDismiss, onOpen, onOpenApp, getCompany, duplicateIds, onSetLeadDeadline, onSetAppDeadline, refresh, filtered = [], onPutBack, closed = [], leadForApp = () => undefined, onApprove, onUndoApprove }: LeadsColumnProps) {
  // Dropping an application here puts it back to "not applied yet".
  const { setNodeRef, isOver } = useDroppable({ id: 'saved' });
  const count = leads.length + saved.length;
  const now = new Date();
  // Picked leads (only those still here count), and the last approval, undoable.
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const selected = leads.filter((l) => picked.has(l.id));
  const [approved, setApproved] = useState<Approval[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const select = (id: string, on: boolean) => setPicked((p) => {
    const next = new Set(p);
    if (on) next.add(id); else next.delete(id);
    return next;
  });
  const approve = async () => {
    if (!onApprove || selected.length === 0) return;
    setBusy(true); setNote(null);
    try {
      const { approved: done, failed } = await onApprove(selected);
      // Ones that failed stay picked, to try again.
      setApproved(done.length ? done : null); setPicked(new Set(failed));
      setNote([done.length && `Approved ${done.length} · applying automatically`, failed.length && `${failed.length} couldn't be approved`].filter(Boolean).join(' · '));
    } catch (e) {
      setNote(`Couldn't approve: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };
  const undo = async () => {
    if (!onUndoApprove || !approved) return;
    setBusy(true);
    try {
      const undone = await onUndoApprove(approved);
      setApproved(null);
      // One applied to since stays where the user put it.
      const kept = approved.length - undone;
      setNote(`Moved ${undone} back to leads${kept ? ` · ${kept} already moved on, left as is` : ''}`);
    } catch (e) {
      setNote(`Couldn't undo: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div ref={setNodeRef} style={laneStyle(isOver, 'var(--surface-3)')}
      onKeyDown={(e) => { if (e.key === 'Escape' && picked.size > 0) setPicked(new Set()); }}>
      <div style={{ padding: '12px 14px 8px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Icon name="wand" size={12} />
          <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--fg)' }}>Leads</span>
          <span style={laneCount}>{count}</span>
          {refresh?.refresh && (
            <button type="button" className="btn-ghost" title="Check the job lists (SimplifyJobs, jobright) and the job boards of companies you follow for new postings that fit your search"
              aria-label="Check job lists now" disabled={refresh.running} onClick={refresh.refresh}
              style={{ padding: 2, display: 'flex', color: 'var(--fg-muted)', opacity: refresh.running ? 0.5 : 1 }}>
              <Icon name="refresh" size={12} />
            </button>
          )}
        </div>
        <div style={{ fontSize: 11, color: 'var(--fg-muted)', marginTop: 3, lineHeight: 1.4 }}>Not applied yet — drag into a stage when you apply</div>
        <ApplyNextBatch leads={queueLeads} />
        {refresh && refreshNote(refresh) && (
          <div role="status" style={{ fontSize: 11, color: 'var(--fg-muted)', marginTop: 3 }}>{refreshNote(refresh)}</div>
        )}
        {onApprove && selected.length > 0 && (
          <ApproveBar count={selected.length} total={leads.length} busy={busy} onApprove={approve}
            onSelectAll={() => setPicked(new Set(leads.map((l) => l.id)))} onClear={() => setPicked(new Set())} />
        )}
        {/* Always there, so a screen reader hears the note when it appears. */}
        <div role="status" style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11.5, color: 'var(--fg)', marginTop: note ? 8 : 0 }}>
          {note && (
            <>
              <span style={{ flex: 1, minWidth: 0 }}>{note}</span>
              {approved && onUndoApprove && <button type="button" className="btn-secondary" disabled={busy} onClick={undo} style={smallBtn}>Undo</button>}
              <button type="button" className="btn-ghost" aria-label="Dismiss note" onClick={() => { setNote(null); setApproved(null); }} style={{ padding: 2, display: 'flex', color: 'var(--fg-muted)' }}>
                <Icon name="x" size={11} />
              </button>
            </>
          )}
        </div>
      </div>
      <div style={{ padding: '2px 8px 10px', display: 'flex', flexDirection: 'column', gap: 8, overflowY: 'auto', flex: 1 }}>
        {/* Highest priority first (fit × urgency, lib/fit.ts); a company's leads and saved applications together. */}
        {byCompany(
          [...leads.map((l): LeadItem => ({ lead: l, deadline: l.deadline })), ...saved.map((a): LeadItem => ({ app: a, deadline: a.deadline }))]
            .map((item) => ({ item, rank: rankOf(item.lead ? { lead: item.lead } : { app: { id: item.app!.id, deadline: item.app!.deadline } }, leadForApp, now) }))
            .sort((a, b) => byPriority(a.rank, b.rank))
            .map(({ item }) => item),
          (x) => (x.lead ? x.lead.company_name : getCompany(x.app.companyId).name),
        ).map((g) => {
          const card = (x: LeadItem, grouped: boolean) => (x.lead
            ? <DraggableLeadCard key={x.lead.id} lead={x.lead} onDismiss={onDismiss} onOpen={onOpen} onSetDeadline={onSetLeadDeadline} grouped={grouped}
              selected={picked.has(x.lead.id)} onSelect={onApprove ? select : undefined} />
            : <DraggableCard key={x.app.id} app={x.app} comp={getCompany(x.app.companyId)} c={stageColors.saved} onOpen={onOpenApp} isDuplicate={duplicateIds.has(x.app.id)} onSetDeadline={onSetAppDeadline} grouped={grouped} />);
          if (g.items.length === 1) return card(g.items[0], false);
          const first = g.items.find((x) => x.app) ?? g.items[0];
          const comp = first.app ? getCompany(first.app.companyId) : leadMark(first.lead!);
          return (
            <CompanyGroup key={g.key} name={comp.name} mark={comp} count={g.items.length}>
              {g.items.map((x) => card(x, true))}
            </CompanyGroup>
          );
        })}
        {count === 0 && (
          <div style={{ fontSize: 11.5, color: 'var(--fg-muted)', textAlign: 'center', padding: '18px 8px', lineHeight: 1.6 }}>
            Jobs your agents find land here.<br />Agent → tell it what you're looking for.
          </div>
        )}
        {/* Hidden by the hard filters (#92), each with why and a way back. */}
        <FoldedLeads label="Filtered out" leads={filtered}>
          {(lead) => (
            <>
              <FoldedRow lead={lead}>
                {onPutBack && <button type="button" className="btn-ghost" onClick={() => onPutBack(lead)} style={{ fontSize: 11, padding: '1px 6px' }}>Put back</button>}
              </FoldedRow>
              {(lead.screen?.reasons ?? []).map((r) => (
                <span key={r} style={{ fontSize: 11, color: 'var(--fg-muted)', lineHeight: 1.4 }}>{r}</span>
              ))}
            </>
          )}
        </FoldedLeads>
        {/* Postings gone from their list or board: kept, out of the way. */}
        <FoldedLeads label="Closed" leads={closed}>
          {(lead) => (
            <>
              <FoldedRow lead={lead}>
                {onDismiss && <button type="button" className="btn-ghost" onClick={() => onDismiss(lead.id)} style={{ fontSize: 11, padding: '1px 6px' }}>Dismiss</button>}
              </FoldedRow>
              <span style={{ fontSize: 11, color: 'var(--fg-muted)', lineHeight: 1.4 }}>
                Gone from {sourceOn(lead, lead.sources[0]?.provider)} {ago(lead.closed_at!)}
                {lead.job_url && <> · <a href={lead.job_url} target="_blank" rel="noopener noreferrer" style={{ color: 'inherit' }}>posting</a></>}
              </span>
            </>
          )}
        </FoldedLeads>
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────
// KanbanView — wraps everything in DndContext. handleDragEnd resolves the
// active card + over column and calls onMoveCard for optimistic update.
// ────────────────────────────────────────────────────────────────────────
type KanbanProps = {
  apps: BoardApp[]; companies: BoardCompany[]; onOpen: (id: string) => void; onMoveCard: (id: string, stage: string) => void;
  leads?: DbJobLead[]; onAddLead?: (lead: DbJobLead, stage: Stage) => void; onDismissLead?: (id: string) => void;
  queueLeads?: DbJobLead[];
  onOpenLead?: (lead: DbJobLead) => void; onSetLeadDeadline?: SetDeadline; onSetAppDeadline?: SetDeadline;
  leadsRefresh?: LeadsRefresh; filteredLeads?: DbJobLead[]; onPutBackLead?: (lead: DbJobLead) => void; closedLeads?: DbJobLead[];
  leadForApp?: (appId: string) => DbJobLead | undefined;
  onApproveLeads?: (leads: DbJobLead[]) => Promise<{ approved: Approval[]; failed: string[] }>; onUndoApprove?: (approvals: Approval[]) => Promise<number>;
};

const UNKNOWN_COMPANY: MarkCompany = { name: 'Unknown company', hue: null, logo: null };

export const KanbanView = ({ apps, companies, onOpen, onMoveCard, leads = [], queueLeads = leads, onAddLead, onDismissLead, onOpenLead, onSetLeadDeadline, onSetAppDeadline, leadsRefresh, filteredLeads, onPutBackLead, closedLeads, leadForApp, onApproveLeads, onUndoApprove }: KanbanProps) => {
  const [activeId, setActiveId] = useState<UniqueIdentifier | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor),
  );

  const pipelineStages = STAGES;
  const getCompany = (id: string): MarkCompany => companies.find(c => c.id === id) ?? UNKNOWN_COMPANY;

  // Applications that look like the same one (lib/duplicates.ts): badged
  // here, merged from the Agent page.
  const duplicateIds = useMemo(() => findDuplicateAppIds(apps, companies), [apps, companies]);

  const handleDragEnd = ({ active, over }: DragEndEvent) => {
    setActiveId(null);
    if (!over) return;
    const cardId = String(active.id);
    const newStage = String(over.id);
    if (String(cardId).startsWith(LEAD_PREFIX)) {
      const lead = leads.find((l) => LEAD_PREFIX + l.id === cardId);
      if (lead && onAddLead && pipelineStages.some((st) => st.id === newStage)) onAddLead(lead, newStage as Stage);
      return;
    }
    const card = apps.find(a => a.id === cardId);
    // Same column (e.g. a ghosted card dropped back on Rejected): nothing to do.
    const sameColumn = card && (newStage === 'saved' ? card.stage === 'saved' : columnOf(card.stage) === newStage);
    if (card && !sameColumn && onMoveCard) {
      onMoveCard(cardId, newStage);
    }
  };

  const activeLead = activeId && String(activeId).startsWith(LEAD_PREFIX) ? leads.find((l) => LEAD_PREFIX + l.id === activeId) : null;
  const activeApp = activeId ? apps.find(a => a.id === activeId) : null;
  const activeStageColors = activeApp ? stageColors[activeApp.stage] ?? stageColors.saved : stageColors.saved;

  return (
    <DndContext
      sensors={sensors}
      onDragStart={({ active }) => setActiveId(active.id)}
      onDragEnd={handleDragEnd}
      onDragCancel={() => setActiveId(null)}
    >
      <div style={{ display: 'flex', gap: 12, padding: '16px 28px 24px', overflowX: 'auto', height: '100%', alignItems: 'stretch' }}>
        <LeadsColumn leads={leads} queueLeads={queueLeads} saved={apps.filter(a => a.stage === 'saved')} onDismiss={onDismissLead} onOpen={onOpenLead}
          onOpenApp={onOpen} getCompany={getCompany} duplicateIds={duplicateIds}
          onSetLeadDeadline={onSetLeadDeadline} onSetAppDeadline={onSetAppDeadline} refresh={leadsRefresh}
          filtered={filteredLeads} onPutBack={onPutBackLead} closed={closedLeads} leadForApp={leadForApp}
          onApprove={onApproveLeads} onUndoApprove={onUndoApprove} />
        {pipelineStages.map(stage => (
          <DroppableColumn
            key={stage.id}
            stage={stage}
            items={apps.filter(a => columnOf(a.stage) === stage.id)}
            c={stageColors[stage.id]}
            getCompany={getCompany}
            onOpen={onOpen}
            duplicateIds={duplicateIds}
          />
        ))}
      </div>
      <DragOverlay dropAnimation={null}>
        {activeLead ? (
          <div style={{ ...leadCardStyle, width: 260, cursor: 'grabbing', transform: 'rotate(1.5deg)', boxShadow: '0 14px 34px rgba(0,0,0,0.18)' }}>
            <LeadCardContent lead={activeLead} />
          </div>
        ) : activeApp ? (
          <div style={{
            background: 'var(--surface)',
            borderRadius: 10, padding: 12,
            display: 'flex', flexDirection: 'column', gap: 9,
            boxShadow: `0 14px 34px rgba(0,0,0,0.18), 0 0 0 1px ${activeStageColors.ring}`,
            cursor: 'grabbing',
            width: 260, // the lane's inner width (276 - 8*2 padding)
            transform: 'rotate(1.5deg)',
          }}>
            <CardContent app={activeApp} comp={getCompany(activeApp.companyId)} c={activeStageColors} isDuplicate={duplicateIds.has(activeApp.id)} />
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
};
