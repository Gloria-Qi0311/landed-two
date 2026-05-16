// Kanban view with drag-and-drop between stages (optimistic update on drop).
import React, { useState } from 'react';
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

// ────────────────────────────────────────────────────────────────────────
// Pure card markup (shared between sortable card + DragOverlay preview).
// Extracted so the floating overlay can render identical visuals.
// ────────────────────────────────────────────────────────────────────────
function CardContent({ app, comp, c }) {
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
function DraggableCard({ app, comp, c, onOpen }) {
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
      <CardContent app={app} comp={comp} c={c} />
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────
// Droppable column. Highlights its border/background when an active drag
// is hovering over it.
// ────────────────────────────────────────────────────────────────────────
function DroppableColumn({ stage, items, c, getCompany, onOpen }) {
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
          return <DraggableCard key={a.id} app={a} comp={comp} c={c} onOpen={onOpen} />;
        })}
        {items.length === 0 && (
          <div style={{ fontSize: 11, color: 'var(--fg-muted)', textAlign: 'center', padding: 16, border: '1px dashed var(--border)', borderRadius: 6 }}>empty</div>
        )}
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────
// KanbanView — wraps everything in DndContext. handleDragEnd resolves the
// active card + over column and calls onMoveCard for optimistic update.
// ────────────────────────────────────────────────────────────────────────
export const KanbanView = ({ apps, companies, onOpen, onMoveCard }) => {
  const [activeId, setActiveId] = useState(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor),
  );

  const pipelineStages = STAGES.filter(s => !['ghosted'].includes(s.id));
  const getCompany = (id) => companies.find(c => c.id === id);

  const handleDragEnd = ({ active, over }) => {
    setActiveId(null);
    if (!over) return;
    const cardId = active.id;
    const newStage = over.id;
    const card = apps.find(a => a.id === cardId);
    if (card && card.stage !== newStage && onMoveCard) {
      onMoveCard(cardId, newStage);
    }
  };

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
        {pipelineStages.map(stage => (
          <DroppableColumn
            key={stage.id}
            stage={stage}
            items={apps.filter(a => a.stage === stage.id)}
            c={stageColors[stage.id]}
            getCompany={getCompany}
            onOpen={onOpen}
          />
        ))}
      </div>
      <DragOverlay dropAnimation={null}>
        {activeApp ? (
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
            <CardContent app={activeApp} comp={getCompany(activeApp.companyId)} c={activeStageColors} />
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
};
