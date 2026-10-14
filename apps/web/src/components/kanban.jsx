// Kanban view with drag-and-drop between stages (optimistic update on drop).
// Columns: Leads → Applied → OA / Test → Interview → Offer → Rejected.
// Leads holds what you haven't applied to yet: jobs your agents found
// (dashed; ✕ dismisses) and jobs you saved for later (stage `saved`).
// Dragging either into a stage adds/moves it. Ghosted applications sit in
// Rejected with a tag; Interview cards show their latest round. In every
// column, a company's cards sit together under its name (same company by
// company key, so 蚂蚁集团 and 蚂蚁 are one), in the column's own order.
import React, { useState, useMemo } from 'react';
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
import { CompanyMark, PortalDot, Icon, stageColors } from './primitives';
import { STAGES, columnOf } from '../data';
import { findDuplicateAppIds } from '../lib/duplicates';
import { companyKey } from '@landed/observation-processor';

// ────────────────────────────────────────────────────────────────────────
// Pure card markup (shared between sortable card + DragOverlay preview).
// Extracted so the floating overlay can render identical visuals.
// ────────────────────────────────────────────────────────────────────────
function CardContent({ app, comp, c, isDuplicate, onSetDeadline, grouped }) {
  const round = columnOf(app.stage) === 'interview' ? currentRound(app.interviews) : null;
  return (
    <>
      {/* In a company group the group header names the company. */}
      {!grouped && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <CompanyMark company={comp} size={24} />
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--fg)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{comp.name}</div>
            <div style={{ fontSize: 10.5, color: 'var(--fg-muted)' }}>{comp.loc}</div>
          </div>
          <PortalDot companyId={comp.id} />
        </div>
      )}
      <div style={{ fontSize: 12.5, color: 'var(--fg)', fontWeight: 500, lineHeight: 1.3 }}>{app.role}</div>
      {grouped && app.location && <div style={{ fontSize: 10.5, color: 'var(--fg-muted)', marginTop: -5 }}>{app.location}</div>}
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
function DraggableCard({ app, comp, c, onOpen, isDuplicate, onSetDeadline, grouped }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: app.id });
  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      onClick={() => { if (!isDragging) onOpen(app.id); }}
      style={{
        background: 'var(--surface)',
        border: '0.5px solid var(--border)',
        borderRadius: 8,
        padding: grouped ? 9 : 10,
        cursor: isDragging ? 'grabbing' : 'grab',
        display: 'flex', flexDirection: 'column', gap: grouped ? 6 : 8,
        boxShadow: '0 1px 0 rgba(0,0,0,0.02)',
        opacity: isDragging ? 0.35 : 1,
        // Hide the source while DragOverlay renders the floating preview
        visibility: isDragging ? 'hidden' : 'visible',
      }}
      className="kanban-card"
    >
      <CardContent app={app} comp={comp} c={c} isDuplicate={isDuplicate} onSetDeadline={onSetDeadline} grouped={grouped} />
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────
// Company groups: a column's cards, a company's together, in the column's
// order (a group sits where its first card would). One card → no group.
// ────────────────────────────────────────────────────────────────────────
function byCompany(items, nameOf) {
  const groups = new Map();
  for (const item of items) {
    const name = nameOf(item) || '';
    const key = companyKey(name) || name.trim().toLowerCase();
    if (!groups.has(key)) groups.set(key, { key, name, items: [] });
    groups.get(key).items.push(item);
  }
  return [...groups.values()];
}

function CompanyGroup({ name, mark, count, portalId, children }) {
  return (
    <div style={{ border: '0.5px solid var(--border)', borderRadius: 9, background: 'color-mix(in oklch, var(--surface) 55%, transparent)', padding: 5, display: 'flex', flexDirection: 'column', gap: 5 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '2px 4px 0' }}>
        <CompanyMark company={mark} size={20} />
        <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--fg)', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</span>
        {portalId && <PortalDot companyId={portalId} />}
        <span style={{ fontSize: 10.5, color: 'var(--fg-muted)', fontVariantNumeric: 'tabular-nums' }}>{count}</span>
      </div>
      {children}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────
// Droppable column. Highlights its border/background when an active drag
// is hovering over it.
// ────────────────────────────────────────────────────────────────────────
function DroppableColumn({ stage, items, c, getCompany, onOpen, duplicateIds }) {
  const { setNodeRef, isOver } = useDroppable({ id: stage.id });
  return (
    <div
      ref={setNodeRef}
      style={{
        minWidth: 280, width: 280, flexShrink: 0,
        background: isOver ? c.bg : 'var(--surface-2)',
        borderRadius: 10,
        border: `0.5px solid ${isOver ? c.dot : 'var(--border)'}`,
        display: 'flex', flexDirection: 'column',
        maxHeight: '100%',
        transition: 'background 120ms, border-color 120ms',
      }}
    >
      <div style={{ padding: '10px 12px', display: 'flex', alignItems: 'center', gap: 8, borderBottom: '0.5px solid var(--border)' }}>
        <span style={{ width: 8, height: 8, borderRadius: 4, background: c.dot }} />
        <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--fg)' }}>{stage.label}</span>
        <span style={{ marginLeft: 'auto', fontSize: 11, fontVariantNumeric: 'tabular-nums', color: 'var(--fg-muted)', background: 'var(--surface)', padding: '1px 7px', borderRadius: 8, border: '0.5px solid var(--border)' }}>{items.length}</span>
      </div>
      <div style={{ padding: 8, display: 'flex', flexDirection: 'column', gap: 6, overflowY: 'auto', flex: 1 }}>
        {/* Most recent first; a company's cards together. */}
        {byCompany([...items].sort((x, y) => (x.lastActivity ?? 0) - (y.lastActivity ?? 0)), (a) => getCompany(a.companyId)?.name).map((g) => {
          if (g.items.length === 1) {
            const a = g.items[0];
            return <DraggableCard key={a.id} app={a} comp={getCompany(a.companyId)} c={c} onOpen={onOpen} isDuplicate={duplicateIds.has(a.id)} />;
          }
          const comp = getCompany(g.items[0].companyId);
          return (
            <CompanyGroup key={g.key} name={comp.name} mark={comp} count={g.items.length} portalId={comp.id}>
              {g.items.map((a) => <DraggableCard key={a.id} app={a} comp={getCompany(a.companyId)} c={c} onOpen={onOpen} isDuplicate={duplicateIds.has(a.id)} grouped />)}
            </CompanyGroup>
          );
        })}
        {items.length === 0 && (
          <div style={{ fontSize: 11, color: 'var(--fg-muted)', textAlign: 'center', padding: 16, border: '1px dashed var(--border)', borderRadius: 6 }}>empty</div>
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
const PROVIDER_LABELS = { meta_muse: 'Muse', claude: 'Claude', codex: 'Codex' };

function hueOf(name) {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
}

const leadMark = (lead) => ({ name: lead.company_name, hue: hueOf(lead.company_key || lead.company_name), logo: lead.company_name.slice(0, 2).toUpperCase() });

function LeadCardContent({ lead, onDismiss, onOpen, onSetDeadline, grouped }) {
  const agents = [...new Set(lead.sources.map((s) => PROVIDER_LABELS[s.provider] ?? s.provider ?? 'agent'))];
  const stop = (e) => e.stopPropagation();
  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        {grouped ? (
          // In a company group: the title leads, the group header names the company.
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontSize: 12.5, color: 'var(--fg)', fontWeight: 500, lineHeight: 1.3 }}>{lead.title}</div>
            {lead.location && <div style={{ fontSize: 10.5, color: 'var(--fg-muted)' }}>{lead.location}</div>}
          </div>
        ) : (
          <>
            <CompanyMark company={leadMark(lead)} size={24} />
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--fg)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{lead.company_name}</div>
              <div style={{ fontSize: 10.5, color: 'var(--fg-muted)' }}>{lead.location || ''}</div>
            </div>
          </>
        )}
        {lead.job_url && (
          <a href={lead.job_url} target="_blank" rel="noopener noreferrer" title="Open job posting" onPointerDown={stop}
            onClick={(e) => { stop(e); onOpen?.(lead); }}
            style={{ color: 'var(--fg-muted)', display: 'flex', padding: 2 }}>
            <Icon name="external" size={11} />
          </a>
        )}
        {onDismiss && (
          <button type="button" title="Not interested" aria-label="Dismiss lead" onPointerDown={stop}
            onClick={(e) => { stop(e); onDismiss(lead.id); }}
            style={{ background: 'transparent', border: 'none', color: 'var(--fg-muted)', cursor: 'pointer', padding: 2, display: 'flex' }}>
            <Icon name="x" size={12} />
          </button>
        )}
      </div>
      {!grouped && <div style={{ fontSize: 12.5, color: 'var(--fg)', fontWeight: 500, lineHeight: 1.3 }}>{lead.title}</div>}
      {onSetDeadline && <DeadlineChip compact deadline={lead.deadline} onSave={(d) => onSetDeadline(lead.id, d)} />}
      <div style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 10.5, color: 'var(--fg-muted)' }}>
        <Icon name="wand" size={10} />
        <span>found by {agents.join(', ')}{lead.sources.length > 1 ? ` · ${lead.sources.length}×` : ''}</span>
      </div>
    </>
  );
}

const leadCardStyle = {
  background: 'var(--surface)',
  border: '1px dashed var(--border-strong)',
  borderRadius: 8,
  padding: 10,
  display: 'flex', flexDirection: 'column', gap: 8,
};

function DraggableLeadCard({ lead, onDismiss, onOpen, onSetDeadline, grouped }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: LEAD_PREFIX + lead.id });
  return (
    <div ref={setNodeRef} {...attributes} {...listeners} className="kanban-card"
      title={lead.description || undefined}
      style={{ ...leadCardStyle, ...(grouped ? { padding: 9, gap: 6 } : {}), cursor: isDragging ? 'grabbing' : 'grab', visibility: isDragging ? 'hidden' : 'visible' }}>
      <LeadCardContent lead={lead} onDismiss={onDismiss} onOpen={onOpen} onSetDeadline={onSetDeadline} grouped={grouped} />
    </div>
  );
}

function LeadsColumn({ leads, saved, onDismiss, onOpen, onOpenApp, getCompany, duplicateIds, onSetLeadDeadline, onSetAppDeadline }) {
  // Dropping an application here puts it back to "not applied yet".
  const { setNodeRef, isOver } = useDroppable({ id: 'saved' });
  const count = leads.length + saved.length;
  return (
    <div ref={setNodeRef} style={{
      minWidth: 280, width: 280, flexShrink: 0, background: isOver ? 'var(--surface-2)' : 'transparent', borderRadius: 10,
      border: '1px dashed var(--border-strong)', display: 'flex', flexDirection: 'column', maxHeight: '100%',
    }}>
      <div style={{ padding: '10px 12px 8px', borderBottom: '0.5px dashed var(--border)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Icon name="wand" size={12} />
          <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--fg)' }}>Leads</span>
          <span style={{ marginLeft: 'auto', fontSize: 11, fontVariantNumeric: 'tabular-nums', color: 'var(--fg-muted)', background: 'var(--surface)', padding: '1px 7px', borderRadius: 8, border: '0.5px solid var(--border)' }}>{count}</span>
        </div>
        <div style={{ fontSize: 10.5, color: 'var(--fg-muted)', marginTop: 3 }}>Not applied yet — drag into a stage when you apply</div>
      </div>
      <div style={{ padding: 8, display: 'flex', flexDirection: 'column', gap: 6, overflowY: 'auto', flex: 1 }}>
        {/* Soonest deadline first; a company's leads and saved applications together. */}
        {byCompany(
          [...leads.map((l) => ({ lead: l, deadline: l.deadline })), ...saved.map((a) => ({ app: a, deadline: a.deadline }))].sort(byDeadline),
          (x) => (x.lead ? x.lead.company_name : getCompany(x.app.companyId)?.name),
        ).map((g) => {
          const card = (x, grouped) => (x.lead
            ? <DraggableLeadCard key={x.lead.id} lead={x.lead} onDismiss={onDismiss} onOpen={onOpen} onSetDeadline={onSetLeadDeadline} grouped={grouped} />
            : <DraggableCard key={x.app.id} app={x.app} comp={getCompany(x.app.companyId)} c={stageColors.saved} onOpen={onOpenApp} isDuplicate={duplicateIds.has(x.app.id)} onSetDeadline={onSetAppDeadline} grouped={grouped} />);
          if (g.items.length === 1) return card(g.items[0], false);
          const first = g.items.find((x) => x.app) ?? g.items[0];
          const comp = first.app ? getCompany(first.app.companyId) : leadMark(first.lead);
          return (
            <CompanyGroup key={g.key} name={comp.name} mark={comp} count={g.items.length} portalId={first.app ? comp.id : null}>
              {g.items.map((x) => card(x, true))}
            </CompanyGroup>
          );
        })}
        {count === 0 && (
          <div style={{ fontSize: 11, color: 'var(--fg-muted)', textAlign: 'center', padding: 16, border: '1px dashed var(--border)', borderRadius: 6, lineHeight: 1.5 }}>
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
/**
 * @param {{ apps: any[], companies: any[], onOpen: (id: string) => void, onMoveCard: (id: string, stage: string) => void,
 *   leads?: any[], onAddLead?: (lead: any, stage: any) => void, onDismissLead?: (id: string) => void, onOpenLead?: (lead: any) => void,
 *   onSetLeadDeadline?: (id: string, deadline: string | null) => void, onSetAppDeadline?: (id: string, deadline: string | null) => void }} props
 */
export const KanbanView = ({ apps, companies, onOpen, onMoveCard, leads = [], onAddLead, onDismissLead, onOpenLead, onSetLeadDeadline, onSetAppDeadline }) => {
  const [activeId, setActiveId] = useState(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor),
  );

  const pipelineStages = STAGES;
  const getCompany = (id) => companies.find(c => c.id === id);

  // Applications that look like the same one (lib/duplicates.ts): badged
  // here, merged from the Agent page.
  const duplicateIds = useMemo(() => findDuplicateAppIds(apps, companies), [apps, companies]);

  const handleDragEnd = ({ active, over }) => {
    setActiveId(null);
    if (!over) return;
    const cardId = active.id;
    const newStage = over.id;
    if (String(cardId).startsWith(LEAD_PREFIX)) {
      const lead = leads.find((l) => LEAD_PREFIX + l.id === cardId);
      if (lead && onAddLead && pipelineStages.some((st) => st.id === newStage)) onAddLead(lead, newStage);
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
  const activeStageColors = activeApp ? stageColors[activeApp.stage] : null;

  return (
    <DndContext
      sensors={sensors}
      onDragStart={({ active }) => setActiveId(active.id)}
      onDragEnd={handleDragEnd}
      onDragCancel={() => setActiveId(null)}
    >
      <div style={{ display: 'flex', gap: 12, padding: '8px 28px 24px', overflowX: 'auto', height: '100%', alignItems: 'stretch' }}>
        <LeadsColumn leads={leads} saved={apps.filter(a => a.stage === 'saved')} onDismiss={onDismissLead} onOpen={onOpenLead}
          onOpenApp={onOpen} getCompany={getCompany} duplicateIds={duplicateIds}
          onSetLeadDeadline={onSetLeadDeadline} onSetAppDeadline={onSetAppDeadline} />
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
          <div style={{ ...leadCardStyle, width: 264, cursor: 'grabbing', transform: 'rotate(1deg)', boxShadow: '0 12px 32px rgba(0,0,0,0.18)' }}>
            <LeadCardContent lead={activeLead} />
          </div>
        ) : activeApp ? (
          <div style={{
            background: 'var(--surface)',
            border: `0.5px solid ${activeStageColors.dot}`,
            borderRadius: 8, padding: 10,
            display: 'flex', flexDirection: 'column', gap: 8,
            boxShadow: '0 12px 32px rgba(0,0,0,0.18), 0 0 0 0.5px var(--border)',
            cursor: 'grabbing',
            width: 264, // matches column inner width (280 - 8*2 padding)
            transform: 'rotate(1deg)',
          }}>
            <CardContent app={activeApp} comp={getCompany(activeApp.companyId)} c={activeStageColors} isDuplicate={duplicateIds.has(activeApp.id)} />
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
};
