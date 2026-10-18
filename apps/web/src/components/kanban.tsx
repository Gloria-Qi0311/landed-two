// Kanban view with drag-and-drop between stages (optimistic update on drop).
// Columns: Leads → Applied → OA / Test → Interview → Offer → Rejected.
// Leads holds what you haven't applied to yet: jobs your agents found
// (dashed; ✕ dismisses) and jobs you saved for later (stage `saved`).
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
import { DeadlineChip, byDeadline } from './deadline-chip';
import { CompanyMark, Icon, stageColors } from './primitives';
import { LeadAssistButton } from './apply-assist';
import { STAGES, columnOf } from '../data';
import { findDuplicateAppIds } from '../lib/duplicates';
import type { SupplyCheck } from '../lib/supply';
import { companyKey } from '@landed/observation-processor';

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
const PROVIDER_LABELS: Record<string, string> = { meta_muse: 'Muse', claude: 'Claude', codex: 'Codex' };


const leadMark = (lead: DbJobLead): MarkCompany => ({ name: lead.company_name, hue: null, logo: null });

type LeadProps = {
  lead: DbJobLead; onDismiss?: (id: string) => void; onOpen?: (lead: DbJobLead) => void; onSetDeadline?: SetDeadline; grouped?: boolean;
};

function LeadCardContent({ lead, onDismiss, onOpen, onSetDeadline, grouped }: LeadProps) {
  const agents = [...new Set(lead.sources.map((s) => (s.provider ? PROVIDER_LABELS[s.provider] ?? s.provider : 'agent')))];
  const stop = (e: { stopPropagation(): void }) => e.stopPropagation();
  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
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
          <a href={lead.job_url} target="_blank" rel="noopener noreferrer" title="Open job posting" onPointerDown={stop}
            onClick={(e) => { stop(e); onOpen?.(lead); }}
            style={{ color: 'var(--fg-muted)', display: 'flex', padding: 2 }}>
            <Icon name="external" size={11} />
          </a>
        )}
        <LeadAssistButton lead={lead} />
        {onDismiss && (
          <button type="button" title="Not interested" aria-label="Dismiss lead" onPointerDown={stop}
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
      <div style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 10.5, color: 'var(--fg-muted)' }}>
        <Icon name="wand" size={10} />
        <span>found by {agents.join(', ')}{lead.sources.length > 1 ? ` · ${lead.sources.length}×` : ''}</span>
      </div>
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

function DraggableLeadCard({ lead, onDismiss, onOpen, onSetDeadline, grouped }: LeadProps) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: LEAD_PREFIX + lead.id });
  return (
    <div ref={setNodeRef} {...attributes} {...listeners} className={grouped ? 'kanban-row' : 'kanban-card'}
      title={lead.description || undefined}
      style={{ ...(grouped ? { padding: '9px 12px 10px', borderTop: '1px solid var(--border-subtle)', display: 'flex', flexDirection: 'column', gap: 6 } : leadCardStyle), cursor: isDragging ? 'grabbing' : 'grab', visibility: isDragging ? 'hidden' : 'visible' }}>
      <LeadCardContent lead={lead} onDismiss={onDismiss} onOpen={onOpen} onSetDeadline={onSetDeadline} grouped={grouped} />
    </div>
  );
}

/** Checking the public job lists now (hooks/supply.ts); refresh is null
 *  without an active search to fit. */
export type LeadsRefresh = { refresh: (() => void) | null; running: boolean; last: SupplyCheck | null; error: string | null };

type LeadsColumnProps = {
  leads: DbJobLead[]; saved: BoardApp[]; onDismiss?: (id: string) => void; onOpen?: (lead: DbJobLead) => void;
  onOpenApp: (id: string) => void; getCompany: (id: string) => MarkCompany; duplicateIds: Set<string>;
  onSetLeadDeadline?: SetDeadline; onSetAppDeadline?: SetDeadline; refresh?: LeadsRefresh;
};

/** "Checked SimplifyJobs and 4 company boards · 3 new" after a check, or what went wrong. */
function refreshNote(r: LeadsRefresh): string | null {
  if (r.running) return 'Checking job lists and company boards…';
  if (r.error) return "Couldn't check the job lists";
  const last = r.last;
  if (!last) return null;
  const listsOk = last.lists.length > 0 && last.failed.length < last.lists.length;
  const boardsOk = last.boards - last.boards_failed.length;
  const checked = [listsOk && 'SimplifyJobs', boardsOk > 0 && `${boardsOk} company board${boardsOk === 1 ? '' : 's'}`].filter(Boolean).join(' and ');
  if (!checked) return last.lists.length === 0 && last.boards === 0
    ? 'Nothing to check: the job lists carry internships and new-grad roles, and no company is followed yet'
    : "Couldn't reach the job lists or company boards";
  return `Checked ${checked} · ${last.added ? `${last.added} new` : 'nothing new'}${last.closed ? ` · ${last.closed} closed` : ''}`;
}
// A Leads card: an agent-found job, or an application not applied to yet.
type LeadItem = { lead: DbJobLead; app?: undefined; deadline: string | null } | { app: BoardApp; lead?: undefined; deadline: string | null };

function LeadsColumn({ leads, saved, onDismiss, onOpen, onOpenApp, getCompany, duplicateIds, onSetLeadDeadline, onSetAppDeadline, refresh }: LeadsColumnProps) {
  // Dropping an application here puts it back to "not applied yet".
  const { setNodeRef, isOver } = useDroppable({ id: 'saved' });
  const count = leads.length + saved.length;
  return (
    <div ref={setNodeRef} style={laneStyle(isOver, 'var(--surface-3)')}>
      <div style={{ padding: '12px 14px 8px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Icon name="wand" size={12} />
          <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--fg)' }}>Leads</span>
          <span style={laneCount}>{count}</span>
          {refresh?.refresh && (
            <button type="button" className="btn-ghost" title="Check the SimplifyJobs lists and the job boards of companies you follow for new postings that fit your search"
              aria-label="Check job lists now" disabled={refresh.running} onClick={refresh.refresh}
              style={{ padding: 2, display: 'flex', color: 'var(--fg-muted)', opacity: refresh.running ? 0.5 : 1 }}>
              <Icon name="refresh" size={12} />
            </button>
          )}
        </div>
        <div style={{ fontSize: 11, color: 'var(--fg-muted)', marginTop: 3, lineHeight: 1.4 }}>Not applied yet — drag into a stage when you apply</div>
        {refresh && refreshNote(refresh) && (
          <div role="status" style={{ fontSize: 11, color: 'var(--fg-muted)', marginTop: 3 }}>{refreshNote(refresh)}</div>
        )}
      </div>
      <div style={{ padding: '2px 8px 10px', display: 'flex', flexDirection: 'column', gap: 8, overflowY: 'auto', flex: 1 }}>
        {/* Soonest deadline first; a company's leads and saved applications together. */}
        {byCompany(
          [...leads.map((l): LeadItem => ({ lead: l, deadline: l.deadline })), ...saved.map((a): LeadItem => ({ app: a, deadline: a.deadline }))].sort(byDeadline),
          (x) => (x.lead ? x.lead.company_name : getCompany(x.app.companyId).name),
        ).map((g) => {
          const card = (x: LeadItem, grouped: boolean) => (x.lead
            ? <DraggableLeadCard key={x.lead.id} lead={x.lead} onDismiss={onDismiss} onOpen={onOpen} onSetDeadline={onSetLeadDeadline} grouped={grouped} />
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
  onOpenLead?: (lead: DbJobLead) => void; onSetLeadDeadline?: SetDeadline; onSetAppDeadline?: SetDeadline;
  leadsRefresh?: LeadsRefresh;
};

const UNKNOWN_COMPANY: MarkCompany = { name: 'Unknown company', hue: null, logo: null };

export const KanbanView = ({ apps, companies, onOpen, onMoveCard, leads = [], onAddLead, onDismissLead, onOpenLead, onSetLeadDeadline, onSetAppDeadline, leadsRefresh }: KanbanProps) => {
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
        <LeadsColumn leads={leads} saved={apps.filter(a => a.stage === 'saved')} onDismiss={onDismissLead} onOpen={onOpenLead}
          onOpenApp={onOpen} getCompany={getCompany} duplicateIds={duplicateIds}
          onSetLeadDeadline={onSetLeadDeadline} onSetAppDeadline={onSetAppDeadline} refresh={leadsRefresh} />
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
