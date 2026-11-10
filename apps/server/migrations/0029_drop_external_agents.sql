-- Landed two runs agents only on the user's own computer (apps/daemon).
-- External agents (an HTTP key), cloud agents (MCP + OAuth) and personal
-- agents applying for the user are gone (#3), and with them the observation
-- relay that only they fed. Their tables go too; nothing else references them.
drop table if exists agent_apply_tasks;
drop table if exists agent_task_runs;
drop table if exists agent_briefings;
drop table if exists oauth_codes;
drop table if exists agent_observations;
drop table if exists agent_connections;
drop table if exists oauth_clients;
