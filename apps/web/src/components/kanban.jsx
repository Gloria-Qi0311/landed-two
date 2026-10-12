// Kanban view with drag-and-drop between stages (optimistic update on drop).
// When agents have found jobs, a Leads column comes first: dragging a lead
// into a stage adds it to the pipeline at that stage; ✕ dismisses it.
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
import { CompanyMark, PortalDot, Icon, stageColors } from './primitives';
import { STAGES } from '../data';
import { findDuplicateAppIds } from '../lib/duplicates';

// ────────────────────────────────────────────────────────────────────────
// Pure card markup (shared between sortable card + DragOverlay preview).
// Extracted so the floating overlay can render identical visuals.
// ────────────────────────────────────────────────────────────────────────
function CardContent({ app, comp, c, isDuplicate }) {
  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <CompanyMark company={comp} size={24} />
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--fg)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{comp.name}</div>
          <div style={{ fontSize: 10.5, color: 'var(--fg-muted)' }}>{comp.loc}</div>
        </div>
        <PortalDot companyId={comp.id} />
      </div>
      <div style={{ fontSize: 12.5, color: 'var(--fg)', fontWeight: 500, lineHeight: 1.3 }}>{app.role}</div>
      {isDuplicate && (
        <div
          title="Same company + role exists on another application — possible duplicate from a second portal."
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
function DraggableCard({ app, comp, c, onOpen, isDuplicate }) {
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
        padding: 10,
        cursor: isDragging ? 'grabbing' : 'grab',
        display: 'flex', flexDirection: 'column', gap: 8,
        boxShadow: '0 1px 0 rgba(0,0,0,0.02)',
        opacity: isDragging ? 0.35 : 1,
        // Hide the source while DragOverlay renders the floating preview
        visibility: isDragging ? 'hidden' : 'visible',
      }}
      className="kanban-card"
    >
      <CardContent app={app} comp={comp} c={c} isDuplicate={isDuplicate} />
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
        {items.map(a => {
          const comp = getCompany(a.companyId);
          return <DraggableCard key={a.id} app={a} comp={comp} c={c} onOpen={onOpen} isDuplicate={duplicateIds.has(a.id)} />;
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

function LeadCardContent({ lead, onDismiss }) {
  const agents = [...new Set(lead.sources.map((s) => PROVIDER_LABELS[s.provider] ?? s.provider ?? 'agent'))];
  const stop = (e) => e.stopPropagation();
  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <CompanyMark company={{ name: lead.company_name, hue: hueOf(lead.company_key || lead.company_name), logo: lead.company_name.slice(0, 2).toUpperCase() }} size={24} />
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--fg)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{lead.company_name}</div>
          <div style={{ fontSize: 10.5, color: 'var(--fg-muted)' }}>{lead.location || ''}</div>
        </div>
        {lead.job_url && (
          <a href={lead.job_url} target="_blank" rel="noopener noreferrer" title="Open job posting" onPointerDown={stop} onClick={stop}
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
      <div style={{ fontSize: 12.5, color: 'var(--fg)', fontWeight: 500, lineHeight: 1.3 }}>{lead.title}</div>
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

function DraggableLeadCard({ lead, onDismiss }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: LEAD_PREFIX + lead.id });
  return (
    <div ref={setNodeRef} {...attributes} {...listeners} className="kanban-card"
      title={lead.description || undefined}
      style={{ ...leadCardStyle, cursor: isDragging ? 'grabbing' : 'grab', visibility: isDragging ? 'hidden' : 'visible' }}>
      <LeadCardContent lead={lead} onDismiss={onDismiss} />
    </div>
  );
}

function LeadsColumn({ leads, onDismiss }) {
  return (
    <div style={{
      minWidth: 280, width: 280, flexShrink: 0, background: 'transparent', borderRadius: 10,
      border: '1px dashed var(--border-strong)', display: 'flex', flexDirection: 'column', maxHeight: '100%',
    }}>
      <div style={{ padding: '10px 12px 8px', borderBottom: '0.5px dashed var(--border)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Icon name="wand" size={12} />
          <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--fg)' }}>Leads</span>
          <span style={{ marginLeft: 'auto', fontSize: 11, fontVariantNumeric: 'tabular-nums', color: 'var(--fg-muted)', background: 'var(--surface)', padding: '1px 7px', borderRadius: 8, border: '0.5px solid var(--border)' }}>{leads.length}</span>
        </div>
        <div style={{ fontSize: 10.5, color: 'var(--fg-muted)', marginTop: 3 }}>Found by your agents — drag into a stage to add it</div>
      </div>
      <div style={{ padding: 8, display: 'flex', flexDirection: 'column', gap: 6, overflowY: 'auto', flex: 1 }}>
        {leads.map((l) => <DraggableLeadCard key={l.id} lead={l} onDismiss={onDismiss} />)}
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────
// KanbanView — wraps everything in DndContext. handleDragEnd resolves the
// active card + over column and calls onMoveCard for optimistic update.
// ────────────────────────────────────────────────────────────────────────
export const KanbanView = ({ apps, companies, onOpen, onMoveCard, leads = [], onAddLead, onDismissLead }) => {
  const [activeId, setActiveId] = useState(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor),
  );

  const pipelineStages = STAGES.filter(s => !['ghosted'].includes(s.id));
  const getCompany = (id) => companies.find(c => c.id === id);

  // Group apps by (companyId, normalized role) — same key on 2+ apps means
  // the user has applied for the same role at the same company via two
  // different portals. We surface a "Possible duplicate" badge per spec.md §8 #1.
  const duplicateIds = useMemo(() => findDuplicateAppIds(apps), [apps]);

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
    if (card && card.stage !== newStage && onMoveCard) {
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
        {leads.length > 0 && <LeadsColumn leads={leads} onDismiss={onDismissLead} />}
        {pipelineStages.map(stage => (
          <DroppableColumn
            key={stage.id}
            stage={stage}
            items={apps.filter(a => a.stage === stage.id)}
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
