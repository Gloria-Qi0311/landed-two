-- 0014 agent_conversations — chat history on the Agent page. One row per
-- conversation; its id is also the Claude Code session id on the user's
-- computer. Turns are stored as one jsonb array (packages/schema/src/
-- conversation.ts validates them).
--
-- Like every data table this holds Cloud data only; sync-off accounts keep
-- their conversations in the browser database.

create table agent_conversations (
  id uuid primary key,
  user_id uuid not null references users(id) on delete cascade,
  title text not null default 'New chat',
  turns jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, user_id)
);

create index agent_conversations_user_updated_idx on agent_conversations (user_id, updated_at desc);
