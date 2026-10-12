# Observation 处理程序设计（v0.1，已实现）

> 状态：已实现。规则在 `packages/observation-processor`（纯函数 + 测试），浏览器里的运行和用户操作在 `apps/web/src/lib/inbox.ts`。
>
> **验收后的产品调整（2026-10-10）**：
> 1. 待投递清单不再是单独页面，改为 Applications 看板最左边的 **Leads** 列。拖进某个阶段列就加入投递，点 ✕ 就是忽略。
> 2. 去掉 Review 页面，**邮件更新默认自动生效**（第 5 节的保守策略改为"手动模式"，在 Agents 页面可以切换）。需要用户判断的少数情况放在 Applications 顶部的"Needs your input"，最近的自动更新可以展开查看并撤销。
>
> **用户自己电脑上的 agent（2026-10-11/12）**：搜岗位（`job_search`）和查邮箱（`email_check`）的结果也走这个处理程序。浏览器把每条结果包装成一条合成的 `job_discovered` / `application_status` observation，`connection_id` 为 `runtime:<电脑 id>`，id 为 `<任务 id>:<序号>`，所以去重、匹配、自动生效、撤销的规则都和外部 agent 完全一样（`ingestFoundJobs` / `ingestEmailFindings`）。邮件状态新增了 `assessment`（在线测评 / 笔试 / take-home，对应 `oa` 阶段）。
>
> **"你投了吗？"**：用户从 Landed 点开一个 Lead 或 Saved 状态投递的岗位链接后，会生成一条待确认建议（dedupe key 为 `click:lead:<id>` / `click:app:<id>`）。它不进"Needs your input"，而是在 Ask Agent 面板里问，按钮上有数字角标。回答"是"就把它加入或移到 Applied，回答"还没有"就关掉，下次再点开时再问。如果收到"已收到申请"的邮件，或者用户手动把它拖到后面的阶段，这个问题会自动关闭，并把对应的 Lead 关联到那条投递（`settleClickQuestions`）。

外部 Agent（Muse、Claude、Codex）通过 [Agent 协议](../apps/server/AGENT_PROTOCOL.md) 把 observation 交给 Landed。目前这些数据只是原样存着。处理程序负责把它们变成用户能直接用的两样东西：

1. **待投递清单**：Agent 找到的职位，去重后列出来，由用户决定投不投。
2. **状态更新**：从邮件里判断出的申请进展。有把握的直接生效，没把握的先放进确认队列，等用户确认。

总原则：**Agent 只陈述事实，Landed 来判断；判断不了的交给用户。宁可多问一次，也不要擅自改错。**

---

## 1. 在哪里运行

处理逻辑写成一个纯函数包 `packages/observation-processor`。它不读数据库也不发请求，输入是 observation 和现有数据，输出是"要做的改动"。

| 账号 | 何时运行 | 结果写到哪 |
|---|---|---|
| 没开云同步 | 浏览器从中转信箱取件之后 | 本机数据库 |
| 开了云同步 | 打开 Landed 时，处理云端 `pending` 状态的 observation | 通过 API 写回云端 |

这样只有一份实现，而且服务器永远不会读取没开同步账号的数据。等以后需要"关着网页也能处理"（比如推送通知），再在服务器上跑同一个包，只服务开了同步的账号。

处理必须**幂等**：同一条 observation 处理两次，结果完全一样。结果用 observation id 做键；两个标签页同时处理也不会产生重复。

---

## 2. 标准化

后面所有比较都基于标准化之后的值。

**公司名**
- 转小写，去掉标点和多余空格。
- 去掉法律后缀：inc、llc、ltd、corp、co、gmbh、plc、limited、corporation。
- 去掉开头的 "the"。
- 维护一份别名表，例如 `meta platforms → meta`、`alphabet → google`。先手写一小批常见的，以后用户手动合并公司时自动补进别名表。
- 例：`"The Acme Corp., Inc."` → `acme`。

**职位名**
- 转小写，去掉标点和括号里的内容。括号里通常是地点或职位编号，例如 `(Remote)`、`(R-12345)`。
- 展开常见缩写：sr→senior、jr→junior、eng→engineer、swe→software engineer、pm→product manager、mgr→manager。
- **保留级别词**（senior / staff / principal / II）。Senior PM 和 PM 是两个不同的职位。

**职位链接**
- host 转小写，去掉 `#` 片段，去掉跟踪参数（utm_*、gh_src、lever-source、source、ref）。
- 尽量提取 **ATS 职位键**，这是最可靠的去重依据：

| ATS | 链接形态 | 职位键 |
|---|---|---|
| Greenhouse | `boards.greenhouse.io/{co}/jobs/{id}`，或任意链接带 `gh_jid={id}` | `greenhouse:{id}`（职位 id 在整个 Greenhouse 全局唯一，所以招聘板和公司官网的链接能对上） |
| Lever | `jobs.lever.co/{co}/{uuid}` | `lever:{uuid}` |
| Ashby | `jobs.ashbyhq.com/{co}/{uuid}` | `ashby:{uuid}` |
| Workday | `…myworkdayjobs.com/…/job/…_{reqid}` | `workday:{tenant}:{reqid}`（编号只在公司内唯一） |

---

## 3. 职位去重（job_discovered → 待投递清单）

按顺序判断，命中第一条就停：

1. **ATS 职位键相同**：是同一个职位。如果两边都有 ATS 职位键但不相同，就是不同的职位（比如重新发布的同名职位），不再往下比较。
2. **标准化后的链接相同**：是同一个职位。
3. **公司相同 + 职位名相同 + 地点兼容**，并且 60 天内出现过：是同一个职位。地点兼容指同一城市，或者有一方是 Remote，或者有一方没写地点。
4. 都不满足：是一个新职位。

**合并规则**：来源取并集（记录哪些 Agent 找到过它）；首次发现时间取最早的；最近出现时间更新为最新的；原来缺的字段（链接、地点）可以补上，但**绝不覆盖用户改过的内容**。

**和已有投递的关系**：如果这个职位命中了某条已有的投递记录（规则同上），就标记为"已投递"并关联到那条记录，不出现在待投递清单里。

---

## 4. 状态匹配（application_status → 投递记录）

1. **找候选**：同一家公司（标准化后相同，或者在别名表里）的所有投递记录。
   - 注意：发件域名经常是 ATS 的（greenhouse-mail.io、hire.lever.co），不是公司的，所以以 Agent 给出的 `company` 为准。发件域名只作为辅助证据。
2. **在候选里挑一条**：

| 情况 | 结果 |
|---|---|
| 没有候选 | **未匹配**：进确认队列，建议"新增一条投递：Acme · PM（10/9 已投递）" |
| 只有 1 条 | 匹配这一条 |
| 有多条，`job_url` 的 ATS 职位键命中其中一条 | 匹配那一条 |
| 有多条，按职位名相似度排序 | 第一名 ≥ 0.6，并且比第二名高出至少 0.2：匹配第一名；否则**有歧义**，进确认队列，让用户选是哪一条 |

职位名相似度 = 标准化后按词计算的 Jaccard 相似度。

3. **把邮件状态翻译成投递阶段**：

| 邮件里的状态 | 建议的阶段 |
|---|---|
| `applied` | `applied` |
| `recruiter_response` | 不改阶段，只在活动记录里加一条"Recruiter 回复了" |
| `assessment`（在线测评 / 笔试 / take-home 邀请） | 当前是 saved / applied 时建议 `oa`；已经过了 OA 就只记活动 |
| `interview` | 当前是 saved / applied / oa 时建议 `phone`；当前是 phone 时建议 `onsite` |
| `rejected` | `rejected` |
| `offer` | `offer` |
| `other` | 只记活动 |

---

## 5. 什么时候自动生效，什么时候让用户确认

**默认（自动模式，`auto_apply_updates` 打开）**：只要满足下面三条就直接生效，并且都能撤销：
- 唯一匹配到一条投递；
- 置信度 ≥ 0.8，并且带邮件证据；
- 阶段往前走。

生效的内容包括阶段变化（含拒信和 Offer）。没匹配上的投递会直接新增；招聘方回复只记进活动记录。下面这些情况一律问用户：
- 匹配不唯一；
- 置信度低，或者没带证据；
- 要重新打开一个已经关闭的投递，比如被拒之后又收到了面试邀请。

**手动模式（开关关闭）**：就是下面这套最初的保守策略。

自动生效需要**同时满足**：
- 状态是 `applied`；
- 唯一匹配到一条投递记录，或者是"未匹配"但用户打开了"自动添加我投递的职位"选项；
- `confidence` ≥ 0.85；
- 带有证据（`message_id` 或 `sender_domain`）；
- 阶段是往前走的。

**永远不会自动执行**：
- 阶段往回退，比如从 onsite 退回 applied。这种只记一条活动。
- `rejected` 和 `offer`。误判的代价太大：把一个还在进行中的投递标成被拒，用户会很难受。等积累了足够多的真实准确率数据，再考虑对高置信度的情况放开。

所有自动或手动生效的改动都写进活动记录，附带证据（邮件主题、发件方、收件时间），并且可以撤销。

---

## 6. 冲突处理

- **同一封邮件被多个 Agent 报告**：按 `evidence.message_id` 去重，只产生一条建议。
- **同一条投递有多封邮件、状态不同**：按 `evidence.received_at` 排序，以最新的为准。但终态（rejected / offer）比更早的中间状态优先。
- **Agent 之间结论矛盾**，比如一个说 interview、一个说 rejected，而且来自不同邮件：两条都进确认队列，并排展示证据，由用户判断。

---

## 7. sync_error

不影响投递记录。显示在 Agents 页面对应连接的"健康状态"里，比如"Gmail 授权已过期，2 小时前"。同一个 Agent 连续报错时只显示最新一条。

---

## 8. 数据模型新增

本地（Dexie 新版本）和云端（新 migration）同时增加，并加进备份格式（`SNAPSHOT_TABLES`）。规则见 `CLAUDE.md`。

**`job_leads`**（待投递清单）
- `id`、`fingerprint`：ATS 职位键，没有的话用"公司 + 职位名 + 地点"的哈希。云端对 `(user_id, fingerprint)` 加唯一约束，配合 upsert。
- `company_name`、`company_id?`、`title`、`job_url?`、`location?`、`description?`
- `sources`：哪些 Agent 连接、哪些 observation 报告过它
- `status`：`new` | `saved`（已转成投递记录）| `dismissed` | `already_applied`
- `application_id?`、`first_seen_at`、`last_seen_at`

**`status_suggestions`**（确认队列）
- `id`、`observation_ids[]`、`application_id?`（未匹配时为空）、`candidate_ids[]`（有歧义时的候选）
- `proposed_stage?`、`kind`：`stage_change` | `new_application` | `ambiguous` | `note`
- `confidence`、`evidence`（来自 observation）
- `state`：`pending` | `accepted` | `rejected` | `auto_applied`

**`agent_observations` 增加** `processing_result`（jsonb）：处理结果指向哪个职位、哪条建议或哪条投递，方便调试和撤销。

---

## 9. 界面

- **待投递**（新页面，或者放在 Applications 上方）：按发现时间列出状态为 `new` 的职位，显示来源 Agent。操作有"加入投递（Saved）""已投递（Applied）""忽略"。
- **确认队列**：侧边栏显示一个数字角标。每条建议展示证据（邮件主题、发件方、时间、Agent 的置信度），操作有"接受""拒绝"；有歧义的会让用户在候选投递里选一条。
- **投递详情抽屉**：活动记录里能看到"由 Muse 根据邮件更新：Interview invitation（10/9）"，并可以撤销。

---

## 10. 需要你定的问题（已按建议决定）

1. **待投递清单是单独一张表，还是直接创建 Saved 状态的投递记录？**
   我建议单独一张表。Agent 一次可能找到几十个职位，直接塞进投递流水线会把看板淹没。用户点"加入投递"之后才变成真正的投递记录。
2. **自动生效的范围**：第一版只自动处理"已投递"，其余都需要确认。这个保守程度可以吗？
3. **邮件里出现了你没记录过的投递**（比如在别处投的职位收到了确认邮件）：是只放进确认队列建议新增，还是提供一个"自动添加"的选项？我建议默认只建议，开关放在设置里。

---

## 11. 实现顺序

1. `packages/observation-processor`：标准化、ATS 链接解析、去重、匹配、决策，全部是纯函数。用 vitest 测试，测试数据用一批真实的 Greenhouse / Lever / Workday 链接和邮件样例。
2. 两张新表和 migration，加入备份格式。
3. 在浏览器里跑处理程序：本地账号在取件之后处理；云端账号在打开页面时处理 `pending` 的 observation。
4. 待投递页面和确认队列界面。
5. 用真实的 Muse 数据（部署之后）检查去重和匹配的准确率，再决定要不要放开自动生效的范围。
