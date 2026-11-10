-- Landed two has no Agent chat (#2): the chat history table goes with it.
-- The connector still runs tasks; none of them read or write this table.
drop table if exists agent_conversations;
