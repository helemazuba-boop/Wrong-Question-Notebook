# WQN 授权加固修复方案（上游安全 PR #97 差距）

> 审计来源：上游 `mrmagic2020/Wrong-Question-Notebook` PR #97（commit `6a2941d`，2026-09-13 合入；
> 迁移 `20260911084312_harden_rpc_and_rls_authorization.sql`，424 行）
> 基线：`WQN @ release/note-baseline-prod 550596f`（66 个迁移）
> 日期：2026-09-28（**v3**：已实施。v2 = 并入独立审核结论；v3 = 加"实施记录"节）
> 执行约束：push 与部署由你本人执行；本方案只产出本地提交 + 测试，交付时给提交号与待部署清单。
> 生产口径：按你的确认，生产 = 这条迁移链（最新 SQL）。
> 本机限制：docker daemon 未起、只有 psql 客户端、无 initdb/postgres 服务端 ⇒ 方案里的 SQL **未经真机执行**，只能静态核对 + 测试脚本覆盖。
> 归档：审计 + 修复记录。快照入库为仓库根目录的 `authz-hardening-2026-09.md`；工作副本在 `/home/unknow/projects/doc/0928-authz-fix-plan.md`。

---

## 实施记录（2026-09-28）

**状态：三个本地提交已完成，等你 push + 部署。** 未 push、未部署、未烧录。

| 提交 | 内容 | 需要什么部署 |
| --- | --- | --- |
| `bef7fb6` | 迁移 `20260928000000_harden_rpc_and_rls_authorization.sql`（342 行）+ pgTAP `authorization-hardening.test.sql` | `deploy/supabase-push.sh` |
| `f230438` | `web/app/api/problems/route.ts` 的 subject 归属校验（D4）+ 两个单测 | 一次 web release |
| （文档那条） | `CHANGELOG.md` 的 `### Security` 段 + 本文件入库 | 无 |

### 与方案的差异（落地时的修正）

1. **"三条 `to public` 策略收窄为 `authenticated`" → 实际是两条。** 逐条核了基线定义：第三条 `to public` 是 `Users can update own attempts`，但 B6 决定 **drop** 而不是收窄；`attempts_problem_owner_read`（`for select to public`）不在本次范围（B 节没列它，pgTAP 里的 `policies_are` 断言也把它算在预期集合里）。迁移注释与 CHANGELOG 已按"两条"改写。
2. 其余与 §1.2 / §1.3 / §1.4 的 SQL 全文逐字一致（含 D1 的 `review_schedule` 钉 owner、D3 的 `to authenticated`）。

### 本机做过的验证

- **语法**：`pglast`（真 PostgreSQL 解析器绑定）解析迁移 18 条语句、测试 40 条语句——全部通过。
- **断言计数**：`plan(22)` 与断言调用数一致（7 `throws_ok` + 6 `lives_ok` + 5 `is` + 3 `is_empty` + 1 `policies_are` = 22）。
- **全限定核验**：三个 RPC 的函数体在 `set search_path = ''` 下只用 `public.*` 与 `auth.uid()`。
- **自检不会误伤（重点）**：迁移尾部两个 DO 块是对**整库**的断言，误报会让整个 push 回滚。对整个迁移链做了静态推演（脚本用 `pglast` 解析全链 67 个文件，跟踪 `CREATE [OR REPLACE] FUNCTION` / `ALTER FUNCTION` / `DROP FUNCTION` / `GRANT|REVOKE ... ON FUNCTION` 的最终状态，并建了 `create or replace` 保留 ACL、`drop`+`create` 重置 ACL 的语义模型）：
  - 最终状态 137 个函数、其中 **69 个 SECURITY DEFINER**（含 `private` schema）：
    **0 个**缺 `search_path`，**0 个**仍可被 PUBLIC 执行。
  - 依据：`20260719010000` 的 do-loop 给当时存在的全部定义者函数补过 `search_path` 并撤销了 PUBLIC 执行权；之后新建的每个都自带 `set search_path` 且显式 `revoke ... from public, anon, authenticated`；`20260827084903` 补齐了中间那批（它自己的注释就说"later CREATE OR REPLACE / DROP+CREATE migrations reintroduced ... the default PUBLIC EXECUTE privilege"）。
  - **这条推演的两个前提**：① 假设 `20260719010000` 的 do-loop 当年真的跑成功（迁移链已推到 head，成立）；② 生产库若有人在链外手工 `grant`，推演失效——那正是自检要在 dry-run 里抓的东西。
  - 六条策略名与基线定义一一对应（`problems_insert_policy` / `problems_update_policy` / `attempts_owner_all` / `review_owner_all` / `Users can insert own history` / `Users can update own categorisations`），`alter policy` 不会打空。
- **Web 门禁**：`npm run prepush`（`fix-all && check-all && test && build && check:client-bundle-secrets`）在 CI 占位 env 下全绿。

### 没做 / 做不到的验证

- **pgTAP 没跑过真机**：本机没有 PostgreSQL 服务端，`supabase test db` 跑不了；测试文件只做了语法与计数核对。
- **B5 的 RLS 假设未在真机确认**：策略子查询是否按调用者身份评估 `problems` 的 RLS——理论上是，但这条决定"可见"语义是否成立。测试里已用两种情形（私有题 `42501`、公开题集通过）把它钉住，**跑一次 `supabase test db` 就能定论**；若不成立，按 §1.3 末尾的备选改成显式谓词版本（照抄 `problems_select_policy` 三分支）。
- 自检本身也只在本机静态推演过；真正的检验是 dry-run。

### 待你执行的部署

1. `./deploy/supabase-push.sh --dry-run-only` —— 看 migration list 与 dry-run（自检在 dry-run 的 apply 阶段就会生效，会明确报出是哪个函数/策略）。
2. `./deploy/supabase-push.sh` —— 真正 apply。
3. §5.2 的 pre-flight 五条查询（A–D 预期 0，E 预期非 0；先跑再推，A–D 非 0 就停下来人工处理）。
4. §5.3 的 post-flight 两条（`proconfig` 计数、四张表的策略全量）。
5. web 发布一次（D4 的 404 行为；不发布也不会坏，只是继续把 42501 报成 500）。
6. 下一轮：`supabase test db` 跑 `authorization-hardening.test.sql`；D7 的四条低危策略（SQL 已备在 §1.6）。

---

## 0. 结论与范围

### 0.1 上游修的两类问题 vs 我们的现状

| 类别 | 上游做法 | 我们的现状 | 本次动作 |
| --- | --- | --- | --- |
| A. SECURITY DEFINER RPC 信任调用方传入的 id（默认 `EXECUTE TO PUBLIC`） | 16 个收进 service_role；4 个加 `auth.uid()` 守卫 | `20260719010000` do-loop 全库 deny-by-default + 白名单；4 个统计 RPC 改 `security invoker`；`20260827084903:13-20` 补了 3 个 DROP+CREATE 丢权限的函数 | **已覆盖（更严），不动** |
| B. RLS 写策略只查 `user_id`，不查外键指向的行 | `ALTER POLICY ... WITH CHECK` 加外键归属 | 未做 | **本次修**（8 个对象，见 §0.2） |
| C. `error_categorisations` INSERT 策略 `to public with check(true)` | 改成 `TO service_role` | `20260905120000` 直接 `drop policy` | **已覆盖，不动** |

### 0.2 本次要修的对象（8 条，按"能不能零猜解打通"分两档）

**档 1：零猜解、纯 HTTP 可打通（真·活的）**

| # | 对象 | 定义位置 | 前置 | 后果 |
| --- | --- | --- | --- | --- |
| 6 | RLS `problems` INSERT / UPDATE 只查 user_id | `:3646` / `:3671` | `subject_id` **可枚举**（`problem_sets_select_policy` 放行 `sharing_level in ('public','limited')`，该表带 `subject_id` 列） | 把自己的题建/搬进受害者科目 |
| 3 | `get_subjects_with_metadata()` 主 join 与 due 子查询未钉 owner | `:1606` | 同上（`subject_id` 可枚举） | **污染型（完整性）**：受害者 `problem_count` / `last_activity` / `due_count` 被污染。函数 `where s.user_id = auth.uid()` 只返回调用者自己的科目，**不泄露内容**（原稿"泄露"二字删去） |
| 7 | RLS `attempts` 写入只查 user_id（新增） | `:3277` / `:3267` | `problem_id` **可枚举**（`problem_set_problems_select_policy` 的 public 分支；`problem_set_stats_anon_select_policy` 对 anon 全开） | 对任意公开题集里的题批量种 attempt，写进题主的题目历史 |

**档 2：需先获得受害者私有 UUID（授权缺陷 / 纵深防御，不是可直接打通的洞）**

| # | 对象 | 定义位置 | 前置 | 后果 |
| --- | --- | --- | --- | --- |
| 1 | `get_due_problems_for_subject(uuid,int)` join 未钉 `p.user_id` | `:1379` | 受害者**私有** `problem_id` | 读出整行 problems（含 content / correct_answer） |
| 2 | `get_due_problems_count()` 同缺陷 | `:1365` | 同上 | 泄露受害者 `subject_id` 与到期计数 |
| 4 | RLS `problem_status_history` INSERT 只查 user_id | `:3575` | 受害者私有 `problem_id` | 种行后，触发器 `ON CONFLICT (problem_id, changed_date)`（`:2035`）把受害者**当天真实状态变更**（`new_status`/`changed_at`）写进攻击者那条行 —— 攻击者自己读得到 ⇒ 除完整性外还是一个**状态变更读取缺口**（比原稿定级更重） |
| 5 | RLS `error_categorisations` UPDATE 只查 user_id | `:3316` | 受害者私有 `attempt_id` | 改指 attempt → `unique_attempt_categorisation`（`:645`）让受害者 AI 归类被跳过 |

**为什么档 2 需要私有 UUID（审核修正的关键点）**：
- 私有 `problem_id` / `attempt_id` **没有 RLS 读路径**：`attempts` 的读被 `attempts_owner_all`（own）与 `attempts_problem_owner_read`（题主读自己题上的 attempt）封住；`problems_select_policy` 的 public 分支只放行公开题集里的题。FK 只能当"已知 UUID 的存在性 oracle"，128 位猜不动。
- 所以档 2 的真实措辞是「**授权缺陷，需配合 UUID 泄露（分享链接、日志、导入导出、其它路径）才可利用；本轮修是纵深防御**」，不能写成"生产上可以直接打通"。

**前置条件（逐条核过）**：
- `review_schedule` 的 `review_owner_all` 为 `for all ... using/with check (user_id = auth.uid())`（`:3699`）⇒ 种排程行合法（档 2 #1/#2 的入口）；
- 相关表对 `authenticated` 的 insert/update 表级权限都在（`20260416062612` 的 grant 块），RLS 是唯一闸门；
- 三个 RPC 在 `20260719010000:64-66` 被显式 grant 给 `authenticated`；
- 全链 `alter policy` 语句数 = 0；唯一涉及这三张表的 `drop policy` 是 C 类那条 INSERT（已封）。

### 0.3 #7 的可用性核减（审核修正：危害比报告口径小）

- `get_uncategorised_attempts(p_user_id)` 有 `where a.user_id = p_user_id`（`:1662`）⇒ 攻击者种的 attempt **不会**进入受害者的 AI 归类/摘要链路（审核报告此处结论需修正）。
- 统计函数（`get_user_statistics` / `get_subject_breakdown`）只数 `problems`，不数 `attempts` ⇒ 统计页不受影响。
- `attempts_problem_owner_read`（题主可读自己题上的全部 attempt）当前**无应用读路径**：全部读点按 `user_id` 过滤（逐点核过，含 `lib/problem-review-service.ts:206-220` 的 `loadOwnedAttempt`）⇒ 现状不呈现给受害者，它是**潜在风险面**而非当前泄露。
- 结论：#7 的当前危害 = DB 级写入污染 + 潜在读路径风险；仍建议修（零猜解可达，且是唯一"跨账号写他人数据"的通道）。

### 0.4 明确不修（有意差异 + 显式接受的风险）

- `get_discovery_subject_counts()` 我们 grant 给 `anon, authenticated`（只暴露公开题集聚合计数，`20260719010000:70` 注释写明有意）。上游收进 service_role——要收紧可以，但非漏洞，本次不动。
- 依赖版本：ws 8.21.3 / dompurify 3.4.14 / vite 8.2.2 都比上游 bump 后新；仅 next 16.3.3 vs 16.3.4 差一个 patch，与本次无关。
- 上游 section 1 / 2 **不能照搬**（见 §1.5）。
- 同形态低危项（`problem_tag` / `tags` / `problem_set_problems` 的 insert/update 策略）本轮**显式接受风险**，SQL 备好在 §1.6，下一轮做。

---

## 1. 修复设计

### 1.1 迁移文件与提交划分

| 文件 | 内容 |
| --- | --- |
| `web/supabase/migrations/20260928000000_harden_rpc_and_rls_authorization.sql` | A 节（3 RPC）+ B 节（6 条策略：4 改 + attempts 2 条）+ 可选 C 节 + 尾部自检 DO 块（§1.7） |
| `web/supabase/tests/database/authorization-hardening.test.sql` | pgTAP 双账号功能断言（§3） |

- **单个迁移**：一个逻辑变更（授权加固），原子应用；只前滚，不改历史迁移。
- 若你希望 #7（attempts）可独立回退，就把 B5/B6 拆成第二个迁移文件；我倾向同文件独立节。

### 1.2 A 节：三个 RPC 钉 owner（SQL 全文）

写法约定：`set search_path = ''` + 函数体全限定。这是**全链主流**（117 处 `set search_path = ''`，列表式只有 1 处）。这三个函数目前是 do-loop 补的
`pg_catalog, public, auth, storage, extensions`；`CREATE OR REPLACE` 会替换原 SET 子句，**必须显式写上**，否则函数会退回未钉 path（§1.7 的自检会在 push 时炸）。

```sql
-- A1. 到期题目列表。review_schedule 是调用方可写的行（review_owner_all 只查
-- user_id），problems 这一侧必须钉到调用者。纵深防御：触发需先掌握受害者私有
-- problem_id（无 RLS 读路径可枚举）。
create or replace function public.get_due_problems_for_subject(
  p_subject_id uuid,
  p_limit integer default 20
)
returns setof public.problems
language sql
stable
security definer
set search_path = ''
as $function$
  select p.*
  from public.review_schedule rs
  join public.problems p
    on p.id = rs.problem_id
   and p.user_id = auth.uid()
  where rs.user_id = auth.uid()
    and p.subject_id = p_subject_id
    and rs.next_review_at <= now()
  order by rs.next_review_at asc
  limit p_limit;
$function$;

revoke all on function public.get_due_problems_for_subject(uuid, integer)
  from public, anon, authenticated;
grant execute on function public.get_due_problems_for_subject(uuid, integer)
  to authenticated, service_role;

-- A2. 到期计数（应用侧无调用方，PostgREST 对 authenticated 可见）。
create or replace function public.get_due_problems_count()
returns table(subject_id uuid, due_count bigint)
language sql
stable
security definer
set search_path = ''
as $function$
  select p.subject_id, count(*) as due_count
  from public.review_schedule rs
  join public.problems p
    on p.id = rs.problem_id
   and p.user_id = auth.uid()
  where rs.user_id = auth.uid()
    and rs.next_review_at <= now()
  group by p.subject_id;
$function$;

revoke all on function public.get_due_problems_count()
  from public, anon, authenticated;
grant execute on function public.get_due_problems_count()
  to authenticated, service_role;

-- A3. 科目列表 + 计数（档 1 的可达项：subject_id 可枚举）。两处 join 都钉：
-- 主 join 用 p.user_id = s.user_id（科目已按 s.user_id = auth.uid() 过滤，等价
-- 且更精确），due 子查询用 p2.user_id = auth.uid()。
create or replace function public.get_subjects_with_metadata()
returns table(
  id uuid, user_id uuid, name text, color text, icon text,
  created_at timestamp with time zone, problem_count bigint,
  last_activity timestamp with time zone, due_count bigint
)
language sql
stable
security definer
set search_path = ''
as $function$
  select
    s.id, s.user_id, s.name, s.color, s.icon, s.created_at,
    coalesce(count(p.id), 0)::bigint as problem_count,
    max(p.last_reviewed_date) as last_activity,
    coalesce(due.cnt, 0)::bigint as due_count
  from public.subjects s
  left join public.problems p
    on p.subject_id = s.id
   and p.user_id = s.user_id
  left join (
    select p2.subject_id, count(*)::bigint as cnt
    from public.review_schedule rs
    join public.problems p2
      on p2.id = rs.problem_id
     and p2.user_id = auth.uid()
    where rs.user_id = auth.uid()
      and rs.next_review_at <= now()
    group by p2.subject_id
  ) due on due.subject_id = s.id
  where s.user_id = auth.uid()
  group by s.id, s.user_id, s.name, s.color, s.icon, s.created_at, due.cnt
  order by s.created_at asc;
$function$;

revoke all on function public.get_subjects_with_metadata()
  from public, anon, authenticated;
grant execute on function public.get_subjects_with_metadata()
  to authenticated, service_role;
```

要点：
- `CREATE OR REPLACE` 保留原 ACL，但显式 revoke/grant 一遍与 deny-by-default 约定一致且幂等；
- `now()` / `count` / `coalesce` 在 `pg_catalog`（恒在搜索路径），无需限定；`auth.uid()` 与所有表名必须限定；
- **service_role 调这三个函数会返回空集**（`auth.uid()` 为 null）：应用侧 4 个调用点全是用户会话（`todos/page.tsx:26`、`subjects/page.tsx:39`、`api/subjects/route.ts:24`、`start-spaced/route.ts:142`），无回归；但这是"看起来像数据丢了"的坑，§3 加断言固化、§5 写进验收说明；
- 函数体若漏了限定符，迁移本身不报错、**运行时报错**——§3 必须真的调用这三个函数。

### 1.3 B 节：策略加固（SQL 全文）

统一动作：`to authenticated`（三条现为 `to public`，卫生项）+ `WITH CHECK` 加归属子查询。

```sql
-- B1. problem_status_history：应用从不直接写（行只由 SECURITY DEFINER 触发器
-- track_problem_status_change() 产生，绕过 RLS）。不钉归属时，攻击者在受害者
-- 题目上种的行会被触发器 upsert 劫持（受害者当天真实状态变更落进攻击者行）。
alter policy "Users can insert own history" on public.problem_status_history
  to authenticated
  with check (
    user_id = (select auth.uid())
    and exists (
      select 1 from public.problems p
      where p.id = problem_status_history.problem_id
        and p.user_id = (select auth.uid())
    )
  );

-- B2. error_categorisations UPDATE：三个 NOT NULL 外键（attempt_id / problem_id
-- / subject_id）一起校验，不能只钉 attempt_id。应用侧 override 路由只改分类
-- 字段、按 id + user_id 过滤，不受影响。
alter policy "Users can update own categorisations" on public.error_categorisations
  to authenticated
  with check (
    user_id = (select auth.uid())
    and exists (select 1 from public.attempts a
                where a.id = error_categorisations.attempt_id
                  and a.user_id = (select auth.uid()))
    and exists (select 1 from public.problems p
                where p.id = error_categorisations.problem_id
                  and p.user_id = (select auth.uid()))
    and exists (select 1 from public.subjects s
                where s.id = error_categorisations.subject_id
                  and s.user_id = (select auth.uid()))
  );

-- B3/B4. problems INSERT / UPDATE：subject_id 是未校验的外键（档 1 可达）。
-- 应用所有写点都只指向自己的科目（§2.1）。
alter policy problems_insert_policy on public.problems
  with check (
    user_id = (select auth.uid())
    and exists (select 1 from public.subjects s
                where s.id = problems.subject_id
                  and s.user_id = (select auth.uid()))
  );

alter policy problems_update_policy on public.problems
  with check (
    user_id = (select auth.uid())
    and exists (select 1 from public.subjects s
                where s.id = problems.subject_id
                  and s.user_id = (select auth.uid()))
  );

-- B5. attempts 写入（#7）：要求指向"调用者可见的题目"。子查询在策略表达式里
-- 以当前用户执行 ⇒ problems 的 RLS 照常生效，因此这条既堵住"对看不见的题
-- 种 attempt"，又保留共享题集练习这一合法的跨账号写入
-- （problem-sets/[id]/review 非 owner 路径 + /api/problems/[id]/attempt 的
-- service 读题、用户会话写 attempt）。
alter policy attempts_owner_all on public.attempts
  with check (
    user_id = (select auth.uid())
    and exists (
      select 1 from public.problems p
      where p.id = attempts.problem_id
    )
  );

-- B6. 删除冗余且更弱的 UPDATE 策略：permissive 策略之间是 OR 关系，留着它
-- （to public + 仅 user_id）会绕过 B5 的 WITH CHECK。attempts_owner_all
-- （for all, to authenticated）已覆盖 UPDATE；anon 因 auth.uid() 为 null 本就
-- 写不进。若你偏好最小改动，也可改成同样的 WITH CHECK 而保留。
drop policy "Users can update own attempts" on public.attempts;
```

**B5 有一个必须在测试里显式验证的假设**：策略表达式里的子查询是否按调用者的 RLS 评估 `problems`。
- 若成立（预期）：私有题目的种入被拒（`42501`），公开题集通过；
- 若不成立（子查询绕过 RLS）：这条退化成"题目存在即可"，必须换成显式谓词版本（照抄 `problems_select_policy` 的三个分支：own OR public set OR limited share）。
- §3 的正向用例必须同时断言这两种情形，别只测"通过"。

### 1.4 可选 C 节：`review_schedule` 写入也钉 owner（超出上游，建议采纳）

A 节把读口堵死后，"种排程行"本身仍合法，还能造成：攻击者自己的 UI/设备计数被污染（`/api/esp32/v3/sync` due 列表）、MCP due 工具返回 `problems: null` 的空行。**不会**泄露内容（所有消费方按 `user_id` 过滤或经 RLS）。

```sql
-- 可选 C：所有用户会话写入点（problem-creation-service:635、ingestion-workspace:621）
-- 都指向自己刚建的题目；其余写入者（FSRS projector、设备路由、app/api/problems 的
-- upsert）走 service_role，绕过 RLS 不受影响。
alter policy review_owner_all on public.review_schedule
  with check (
    user_id = (select auth.uid())
    and exists (
      select 1 from public.problems p
      where p.id = review_schedule.problem_id
        and p.user_id = (select auth.uid())
    )
  );
```

### 1.5 明确不搬的上游段落（照抄会出错/回退）

| 上游段落 | 为什么不搬 |
| --- | --- |
| section 1：16 个 `REVOKE/GRANT ... TO service_role` | 已由 `20260719010000` do-loop + `20260827084903:13-20` 覆盖；部分函数我们不存在/签名不同，重复执行只是 churn |
| section 2：4 个统计 RPC 改回 `SECURITY DEFINER` + `auth.uid()` 守卫 | 我们是 `SECURITY INVOKER`（`20260719010000:51-54`），照搬等于**把已修的问题改回去** |
| section 4 中 `error_categorisations` INSERT 的 `ALTER POLICY ... TO service_role` | 策略已被 `20260905120000` drop，照抄报"策略不存在" |
| section 1 中 `get_discovery_subject_counts` 收 service_role | 有意差异（§0.4） |

### 1.6 同形态低危项：本轮显式接受（下一轮再做）

以下四条策略都是"只查 user_id + 外键裸奔"，危害低一档（元数据级污染，不碰内容），但同属本次加固的形态。本轮**不改**，理由：需要逐个核对 14 个用户会话写点（`problem_tag` 3 / `tags` 6 / `problem_set_problems` 5）的归属语义，改动面比收益大。SQL 备好，下一轮单独提交：

```sql
alter policy problem_tag_insert_policy on public.problem_tag
  with check (user_id = (select auth.uid())
    and exists (select 1 from public.problems p
                where p.id = problem_tag.problem_id and p.user_id = (select auth.uid()))
    and exists (select 1 from public.tags t
                where t.id = problem_tag.tag_id and t.user_id = (select auth.uid())));

alter policy problem_tag_update_policy on public.problem_tag
  with check (/* 同上 */);

alter policy tags_insert_policy on public.tags
  with check (user_id = (select auth.uid())
    and exists (select 1 from public.subjects s
                where s.id = tags.subject_id and s.user_id = (select auth.uid())));

-- 最高危的一条：可把攻击者自己的题塞进受害者的题集（受害者能看到）。
alter policy problem_set_problems_insert_policy on public.problem_set_problems
  with check (user_id = (select auth.uid())
    and exists (select 1 from public.problem_sets ps
                where ps.id = problem_set_problems.problem_set_id
                  and ps.user_id = (select auth.uid()))
    and exists (select 1 from public.problems p
                where p.id = problem_set_problems.problem_id
                  and p.user_id = (select auth.uid())));
```

### 1.7 迁移尾部自检 DO 块（防回退，push 时即失败）

照抄 `20260719010000:79-108` 的模式（同一作者、同一目的），放进新迁移尾部：任何 SECURITY DEFINER 函数未钉 `search_path` 或仍可被 PUBLIC 执行，`supabase db push` 当场 `raise exception`。这比"上线后用 pgTAP 才发现"早一步。

```sql
do $$
begin
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prosecdef
      and not exists (
        select 1 from unnest(coalesce(p.proconfig, array[]::text[])) setting
        where setting like 'search_path=%'
      )
  ) then
    raise exception 'SECURITY DEFINER function without fixed search_path';
  end if;

  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
    where n.nspname = 'public' and p.prosecdef
      and acl.grantee = 0 and acl.privilege_type = 'EXECUTE'
  ) then
    raise exception 'SECURITY DEFINER function executable by PUBLIC';
  end if;
end
$$;
```

（可选再加一段策略自检：断言 §1.3 涉及策略的 `pg_policies.with_check` 都含 `EXISTS`。）

### 1.8 两条关键语义说明

1. **permissive 策略是 OR 关系**：同一命令（如 UPDATE）上有多条 permissive 策略时，任一条通过即放行。所以"只 ALTER 其中一条"可能被另一条绕过 —— B6 的存在就是为此（`Users can update own attempts` 必须删或同步收紧）。
2. **`ALTER POLICY` 只改指定子句**：`USING`、策略名、其它角色保持原样；B1/B2 加 `to authenticated` 是本次唯一的角色收紧。

---

## 2. 影响面核对（逐写点，已全量过一遍）

### 2.1 `problems` 的用户会话写点

| 写点 | 客户端 | subject 归属 | 加固后 |
| --- | --- | --- | --- |
| `app/api/problems/route.ts:455`（POST 创建） | 用户会话 | **无显式校验**（依赖 UI 只给自家科目） | 攻击性请求 500（RLS 拒绝）；建议补 app 层校验（§4） |
| `app/api/problem-sets/[id]/copy/route.ts:315` | 用户会话 | 显式校验（`:128-142`） | 通过 |
| `app/api/problem-sets/[id]/copy-problem/route.ts:294` | 用户会话 | 显式校验（`:194-207`） | 通过 |
| `lib/problem-creation-service.ts:884`（MCP 路径） | 用户会话 | `resolveSubject` 校验（`:195-256`） | 通过 |
| `lib/problem-ingestion-workspace-service.ts:583` | 用户会话 | ingestion 行按 `user_id` 载入（`:141-143`），科目在创建时校验（`:289-299`） | 通过 |
| `problems/[id]/route.ts:145`（PATCH，可含 `subject_id`） | 用户会话 | 按 `id + user_id` 过滤；只可能选自家科目 | 通过 |
| `problems/[id]/assets/route.ts:67`、`problems/[id]/status/route.ts:61` | 用户会话 | 只改 assets / status | 通过 |

### 2.2 `attempts` 的用户会话写点（#7 相关）

| 写点 | 客户端 | 目标题目 | 加固后 |
| --- | --- | --- | --- |
| `app/api/attempts/route.ts:119` | 用户会话 | 先用用户会话读题（`:100-108`）⇒ 必然可见 | 通过 |
| `app/api/problems/[id]/attempt/route.ts:128` | 用户会话（读题用 service，见 `:62-71` 注释：共享题集可自动批改） | 共享题集的题（公开/limited）⇒ 可见 | **通过**（B5 用"可见"而非"拥有"，正是为了保住这条） |
| `app/api/esp32/review-complete/route.ts:202` | **service client**（`:124`） | 绕过 RLS | 通过 |
| `app/api/attempts/[id]/route.ts:54`（PATCH own） | 用户会话 | 只改 confidence/cause/reflection/selected_status | 通过（极端边界：题目后来变成不可见时改 attempt 会失败，但该 attempt 在 UI 上也不可见，实际不可达） |

### 2.3 其余三张表

| 表 | 用户会话写点 | 结论 |
| --- | --- | --- |
| `problem_status_history` | **无**（只有 definer 触发器） | WITH CHECK 无副作用 |
| `error_categorisations` | `app/api/ai/categorise-error/[id]/route.ts:89/170`（override，只改分类字段） | 通过；`lib/categorise-error.ts`、`lib/digest-generator.ts` 走 service_role |
| `review_schedule` | `problem-creation-service.ts:635`、`ingestion-workspace-service.ts:621`（均指向自己刚建的题） | 可选 C 不影响 |

### 2.4 存量违规行

`WITH CHECK` 只约束新写入。上线前用 §5.2 的 pre-flight 计数（#1-#6 相关预期为 0；**attempts 那条预期非 0**，共享题集练习是合法写入，只作了解）。

---

## 3. 测试方案

新文件 `web/supabase/tests/database/authorization-hardening.test.sql`，pgTAP：

1. **结构**：`select plan(N)` 的 N 必须与断言数**严格一致**（pg_prove 会因 plan mismatch 直接判失败）；结尾 `select * from finish();`；整文件包在 `begin; ... rollback;`。
2. **双账号构造**：沿用现有写法 `insert into auth.users (id, email)`（范例 `problem-ingestion-workspace.test.sql:51`）+ `set local role authenticated` + `select set_config('request.jwt.claims', '{"sub":"...","role":"authenticated"}', true)`（范例 `knowledge-marks.test.sql:376`；最小只需 `sub` + `role`）。
3. **RLS 拒绝写法**：复用现成范例 `throws_ok($$ ... $$, '42501', null, '...')`（`knowledge-marks.test.sql:408-414`、`problem-initial-idea-context.test.sql:414/427`），不要另发明写法。
4. **正向（攻击者，期望被拒）**
   - `insert into public.problem_status_history` 指向受害者题目 → `42501`；
   - `insert into public.problems (subject_id=受害者科目)` → `42501`；`update` 自己的题把 `subject_id` 改指受害者科目 → `42501`；
   - `update public.error_categorisations` 把 `attempt_id` / `problem_id` / `subject_id` 分别改指受害者的行 → `42501`；
   - `insert into public.attempts` 指向**不可见的私有题** → `42501`（**这条同时验证 B5 的 RLS 假设**）；
   - `rpc/get_due_problems_for_subject(受害者科目)` / `rpc/get_due_problems_count()` → 0 行；`rpc/get_subjects_with_metadata()` → `problem_count` 不含受害者的题；
   - 采纳可选 C 时：`insert into public.review_schedule` 指向受害者题目 → `42501`。
5. **反向（合法路径回归）**
   - 攻击者对自己的 subject / problem / attempt / review_schedule / categorisation 做同样操作 → 全部成功；
   - **共享题集练习**：受害者把题集设为 `sharing_level='public'`，攻击者 `insert into public.attempts` 指向该题 → **成功**（B5 的"可见"语义）；
   - 三个 RPC 用攻击者自己的数据调用 → 返回自己的行（同时覆盖 `search_path = ''` 下的全限定函数体）；
   - **service_role 合法路径**：`set local role service_role` 后调三个 RPC → 返回**空集**（`auth.uid()` 为 null），把 §1.2 的说明固化成断言；
   - service_role 直接写 `problems` / `attempts`（绕过 RLS）→ 成功。
6. **目录断言（防回退）**
   - 三个函数 `proconfig` 含钉死的 `search_path`；
   - `pg_policies.with_check` 含 `EXISTS` 子句；`attempts` 上不存在名为 `Users can update own attempts` 的策略（采纳 B6）。

运行方式：`supabase start` + `supabase test db`（需要 Docker）。本机此刻跑不了（docker daemon 未起）。CI 目前不跑 DB 测试（`Web CI` 三 job 只跑 type-check/lint/format/vitest/build；`Deploy Scripts` 只跑 bash 测试）；把 `supabase test db` 塞进 CI 需要 Docker-in-runner，本次不做。

---

## 4. 可选伴随改动（app 层，需要 web 发布）

- `app/api/problems/route.ts` POST：加 subject 归属校验（`subjects.select('id').eq('id', subject_id).eq('user_id', user.id)`），让"往别人科目建题"返回 **403/404** 而不是 RLS 触发的 500。
- 评估结论：`/api/problems/[id]/attempt` 的"共享题集可批改"是**产品特性**，不在 app 层放开成 service 写入（B5 已用"可见"语义保住它）。

---

## 5. 上线与验证

### 5.1 推送（你执行）

```
./deploy/supabase-push.sh --dry-run-only    # migration list + dry-run（§1.7 的自检会在真正 apply 时生效）
./deploy/supabase-push.sh
```

### 5.2 Pre-flight（推之前，生产库只读）

```sql
-- A. 题目挂到别人的科目（#6，预期 0）
select count(*) from public.problems p
join public.subjects s on s.id = p.subject_id
where s.user_id <> p.user_id;

-- B. 排程指向别人的题目（#1/#2 的入口，预期 0）
select count(*) from public.review_schedule rs
join public.problems p on p.id = rs.problem_id
where p.user_id <> rs.user_id;

-- C. 状态历史指向别人的题目（#4，预期 0）
select count(*) from public.problem_status_history h
join public.problems p on p.id = h.problem_id
where p.user_id <> h.user_id;

-- D. 归类指向别人的 attempt（#5，预期 0）
select count(*) from public.error_categorisations ec
join public.attempts a on a.id = ec.attempt_id
where a.user_id <> ec.user_id;

-- E. attempt 指向别人的题目（#7）：**预期非 0**（共享题集练习是合法写入），
--    只作规模了解；若数量异常大，先按 problem/user 聚合看是否像批量种入。
select count(*) from public.attempts a
join public.problems p on p.id = a.problem_id
where p.user_id <> a.user_id;

-- F. problem_tag / tags / problem_set_problems 的跨账号行（§1.6，下一轮的输入）
select count(*) from public.problem_tag pt
join public.problems p on p.id = pt.problem_id
where p.user_id <> pt.user_id;
```

### 5.3 Post-flight（推之后）

```sql
select p.proname, p.proconfig
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('get_due_problems_for_subject','get_due_problems_count','get_subjects_with_metadata');

select tablename, policyname, cmd, roles, qual, with_check
from pg_policies
where schemaname = 'public'
  and tablename in ('problems','problem_status_history','error_categorisations','attempts')
order by tablename, policyname;
```

再加一条端到端：两个测试账号按 §3 的正向清单走 PostgREST（写入用例只在本地栈跑，别在生产跑）。
验收说明里写明：**service_role 调这三个 RPC 会返回空集**（正常现象，不是数据丢失）。

### 5.4 回滚

不需要（这是修漏洞）。万一某条策略误伤合法路径（§2 已逐点核对为"通过"），用一条新迁移 `ALTER POLICY` 回原表达式即可，别改历史迁移。注意：恢复旧函数体时**必须保留 `set search_path = ''`**（否则 §1.7 的自检会在下次 push 时拒绝），只去掉归属钉。

---

## 6. 决策点（需你拍板）

| # | 决策 | 推荐 |
| --- | --- | --- |
| D1 | 可选 C：`review_schedule` 写入也钉 owner | **采纳**（写入者已全量核对；采纳后 §3 正向期望改为 `42501`） |
| D2 | `get_due_problems_count()` 保留 `authenticated` grant（钉 join 后无害，上游也保留） | 采纳（最小改动） |
| D3 | `problem_status_history` INSERT：`WITH CHECK` + `to authenticated`（上游做法）vs 直接 drop 策略 | `WITH CHECK` + `to authenticated`（保留将来导入历史的口子） |
| D4 | app 层补 `POST /api/problems` 的 subject 归属校验 | **采纳**（独立提交，web 需发布一次） |
| D5 | 存量违规行清理 | 先跑 §5.2；A–D 为 0 不清理，非 0 人工处理；E 项预期非 0，不作违规 |
| D6 | attempts 缺口（#7）本次同迁移修？用"可见"语义还是"严格归属"语义？ | **本次修**；用**"可见"**（严格归属会打断共享题集练习这一既有特性，需要 app 改走 service 写入，收益不值） |
| D7 | `problem_tag` / `tags` / `problem_set_problems`（§1.6） | 本轮**显式接受风险**，下一轮单独提交 |

---

## 7. 交付物清单（待批准后产出）

| # | 产物 | 说明 |
| --- | --- | --- |
| 1 | `web/supabase/migrations/20260928000000_harden_rpc_and_rls_authorization.sql` | A 节（3 RPC）+ B 节（6 条策略）+ 可选 C 节 + 尾部自检 |
| 2 | `web/supabase/tests/database/authorization-hardening.test.sql` | §3 全部断言（含 B5 的 RLS 假设验证、service_role 空集固化） |
| 3 | `CHANGELOG.md` 的 `### Security` 段 | `.claude/CLAUDE.md:55-62` 要求；DB 加固一条（+ D4 的 web 改动一条） |
| 4 | （D4 采纳时）`app/api/problems/route.ts` 改动 + 单测 | 独立提交 |
| 5 | 提交号 + 待部署清单 | 生产库 push 走 `deploy/supabase-push.sh`；D4 采纳时 web 走 release |
| 6 | 方案文档入库 | 现在在 `/home/unknow/projects/doc/`（WQN 仓库外）；建议实现时随提交带进仓库（或写进 commit message）以便追溯 |
