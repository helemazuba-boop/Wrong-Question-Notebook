# WQN 报告复核与单元测试覆盖

审核日期：2026-10-12。审核对象：用户提供的附录 A–F。

代码基线：`release/note-baseline-prod`，`15d04408f2782168d369ff2289c66bcda3bb1785`；历史比较起点：`9153d93`。

本次仅新增审核文档和测试。用户明确要求权限修复另开 PR，因此本文发现的功能、安全和数据库缺陷均未修复。

## 证据与验证边界

- 检查了当前源码、迁移、路由、导航、翻译文件、Git 历史及静态导入关系。
- GitHub issue / PR 状态通过连接器在审核当天重新查询，未把旧报告的数量视为当前状态。
- 社区受限分享、停用账号与配额故障行为通过当前函数和模拟依赖离线复现，没有访问真实用户数据或调用 AI 提供商。
- 本机没有可用 Docker 数据库，未执行真实 PostgreSQL 权限测试，也未核验生产数据库是否存在仓库外的列权限或触发器。
- 单元测试中的 Supabase 查询是模拟对象；查询范围断言不能替代 PostgreSQL RLS、事务和级联删除测试。
- API 路由测试隔离 `withSecurity`，验证业务处理器的认证、授权、输入、写入和错误行为；限流及请求中间件由已有独立测试覆盖。

## 优先处理的发现

| 编号   | 优先级 | 结论                                                     | 证据及影响                                                                                                                                                                                      |
| ------ | ------ | -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AUD-01 | P0     | 仓库迁移存在自行提权路径，报告遗漏                       | `authenticated` 有 `user_profiles` 整表 UPDATE 权限；更新策略仅要求 `id = auth.uid()`，没有保护 `user_role`。后台授权直接读取该列。按这些定义部署时，普通用户可修改自身角色。生产状态尚未核验。 |
| AUD-02 | P1     | 受限分享的复习入口绕过分享名单，已离线复现               | `problem_sets` 的 SELECT 策略向所有登录用户暴露 `limited` 元数据；复习页面对登录用户不调用 `checkProblemSetAccess()`，随后使用 service client 取题。未获授权者仍能读取题目。                    |
| AUD-03 | P1     | “停用账号”未接入通用鉴权，已离线复现                     | 管理员操作仅更新 `user_profiles.is_active`；`requireUser()` 与 JWT principal 验证不读取该字段，也未找到 Auth 封禁调用。有效 JWT 的持有人仍被通用鉴权接受。                                      |
| AUD-04 | P1     | 实际配额风险在 digest 补分类的异常放行，已离线复现       | 配额返回 `allowed:false` 时不调用 AI；配额 RPC 抛错时却递增 `allowedCount` 并继续调用 AI。报告所指的 GET 接口绕过配额不成立。                                                                   |
| AUD-05 | P1     | `admin` 角色与后台准入不一致，报告成立                   | proxy 接受 `admin` / `super_admin`，后台 layout 与 11 个 admin route 仅接受 `super_admin`；seed 管理员却是 `admin`。未找到受控的首次 super-admin 引导流程。                                     |
| AUD-06 | P1     | 举报提交后缺少产品内处理闭环，报告成立                   | 应用代码只向 `problem_set_reports` insert，没有审核队列、状态更新或处理结果反馈。不能据此断言运营人员从未通过数据库处理。                                                                       |
| AUD-07 | P1     | 待办提醒的时间字段未连接投递路径，报告成立               | 字段可保存，页面显示“提醒”；四个 cron 不读取它，前端和 Android 未发现待办通知调度。注册验证邮件与 Android 下载通知不属于待办提醒。                                                              |
| AUD-08 | P2     | 普通用户缺少全量导出和账号自助删除，报告基本成立         | profile API 没有这两种能力；管理员 `deleteUser()` 已存在，不能称为整个系统完全没有账号删除。新模块数据和对象存储清理完整性尚未验收。仅凭源码不能判定法律合规结论。                              |
| AUD-09 | P2     | 新用户引导与当前使用方式不一致，报告成立但修复建议需调整 | 清单仍只有科目、题目、复习三步；书架又会自动创建预设科目，第一步不再代表用户主动组织内容。应按用户选择的错题、笔记或单词场景引导，不要求所有用户完成全部模块。                                  |
| AUD-10 | P2     | 新模块英文界面缺失，报告成立                             | `Notebooks`、`Insights`、`Notes`、`Todos`、`Words` 五个顶层 namespace 在两套消息中均不存在。多个页面没有使用翻译函数，大量中文直接进入 UI。                                                     |
| AUD-11 | P2     | “删除”与“移出错题本”混用，已确认                         | 错题本批量按钮及移动端写“删除”，实际只删关联；桌面单题菜单写“移出题集”。科目全部题目仍保留被移出的题目是当前数据语义，并非此时发生了真正的删除。                                                |
| AUD-12 | P2     | 老模块测试覆盖不足，报告方向成立，绝对零测试表述不准确   | copy / copy-problem 已有 route 测试；科目相关数据库授权和映射也有测试，但不等于科目、标签 CRUD 已覆盖。此次补充见后文。                                                                         |
| AUD-13 | P2     | Insights 状态接口吞掉读取错误，新增测试暴露              | 读取 `insight_digests` 时仅解构 `data`；数据库错误且 `data=null` 时返回 `status:'none'`，将故障呈现为没有历史报告。                                                                             |

### 关键代码位置

- AUD-01：[整表 UPDATE grant](../web/supabase/migrations/20260416062612_remote_schema.sql#L3199)、[own-row 更新策略](../web/supabase/migrations/20260416062612_remote_schema.sql#L3861)、[后台角色判定](../web/lib/user-management.ts#L116)。`/api/profile` 的 DTO 白名单不能保护绕开 Web API 的直接 PostgREST 更新。
- AUD-02：[limited 元数据 RLS](../web/supabase/migrations/20260416062612_remote_schema.sql#L3557)、[复习入口](<../web/app/[locale]/(app)/problem-sets/[id]/review/page.tsx#L240>)、[非 owner 使用 service client](<../web/app/[locale]/(app)/problem-sets/[id]/review/page.tsx#L100>)、[正常访问检查](../web/lib/problem-set-utils.ts#L56)。`isReadOnly` 仅限制编辑，不是读取授权。
- AUD-03：[停用写入](../web/lib/user-management.ts#L233)、[通用鉴权](../web/lib/supabase/requireUser.ts#L5)、[JWT principal](../web/lib/supabase/auth-principal.ts#L13)。
- AUD-04：[配额异常放行](../web/lib/digest-generator.ts#L470)、[配额 RPC 错误处理](../web/lib/usage-quota.ts#L55)。
- AUD-05：[proxy 角色范围](../web/proxy.ts#L88)、[后台 layout](<../web/app/[locale]/(app)/admin/layout.tsx#L24>)、[seed](../web/supabase/seed.sql#L82)。
- AUD-06：[举报写入](../web/app/api/problem-sets/[id]/report/route.ts#L97)。
- AUD-07：[提醒显示](<../web/app/[locale]/(app)/todos/todos-page-client.tsx#L333>)、[提醒保存](../web/lib/todos.ts#L464)。
- AUD-08：[profile API](../web/app/api/profile/route.ts)、[管理员删除](../web/lib/user-management.ts#L828)。
- AUD-09：[引导清单](../web/components/onboarding/onboarding-checklist.tsx#L29)、[引导状态](../web/app/api/onboarding/status/route.ts#L63)、[预设科目](../web/lib/subject-presets.ts#L92)。
- AUD-10：[书架中文标题与描述](<../web/app/[locale]/(app)/subjects/subjects-page-client.tsx#L363>)、[i18n 检查脚本](../web/scripts/i18n-status.js)。
- AUD-11：[关联删除](../web/app/api/problem-sets/[id]/problems/route.ts#L357)、[批量按钮](../web/components/problems/compact-search-filter.tsx#L416)、[移动端绑定](<../web/app/[locale]/(app)/problem-sets/[id]/problem-set-problems-table.tsx#L302>)。
- AUD-13：[状态读取](../web/app/api/insights/status/route.ts#L21)。

## 对原报告其他判断的逐项修正

| 原报告条目                                      | 复核结论                                                                                                                                                                                             |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C.1 社区闭环全部由 `b871b6d` 完成，此后一次未动 | 发现页、创作者页及 social-actions-bar 的分叉后提交数确为 0；整个 `api/problem-sets` 则有 7 个提交，copy 等入口被修改。基本分享链路存在，但 AUD-02 与 AUD-06 使“完整闭环”表述过强。                   |
| C.2-2 分享面只覆盖题集                          | 用户发布、发现和限定人员分享主要限于题集，成立。系统词库可被多人读取；Note / Word 的 AI access 不等同于人与人公开分享。                                                                              |
| C.2-3 完全没有单题公开链接                      | 误报。`/problem-sets/{id}/review?problemId={problemId}` 能在公开题集内定位单题，允许匿名只读访问。本次新增正向测试。缺少的是脱离题集、独立设置公开范围的单题发布能力。                               |
| C.2-4 没有关注、评论、私信、站内通知            | 未发现用户社交关系或通知中心，属于尚未开发的产品能力。MCP `notifications/initialized` 和设备 agent messages 不是这些能力。没有明确产品承诺时不自动列为故障。                                         |
| C.2-5 没有站外传播、没有任何导出                | 表述过强。已有复制公开链接、题目打印和 Android 原生打印桥接；未发现系统原生分享、分享海报等增强能力。打印不等于全量账号数据导出。                                                                    |
| C.2-6 0 提交说明投入停滞                        | 指定目录 0 提交成立，但不足以证明无人维护或全部社区能力从未维护。提交日期和数量也不能证明功能正确或错误。                                                                                            |
| C.2-7 营销“分享访问链接”与实现不符              | 作为“题集分享”并非误导：公开 / 限定邮箱分享与复制链接确实存在。“分享文档链接”还位于对比表的其他产品列，不是 WQN 的能力声明。若泛指笔记等全部内容才存在范围不清。                                     |
| C.2-8 open issues 数量及路线图                  | 原数量过时且混用了 issue 与 PR。当天检索：fork 0 个 open issue、5 个 open PR（依赖升级）；upstream 1 个 open issue（注册故障）、1 个 open PR（依赖升级）。未找到社区需求，不能推出不存在内部路线图。 |
| D.1 五类新增模块都应加入引导                    | 引导覆盖不足成立；强制把所有模块塞入一个清单属于产品方案，不是唯一修复。                                                                                                                             |
| D.2 17 个零入边文件                             | 原文未完整列出 17 个文件；逐个核验其列出的 11 个 TS/TSX 文件均无静态消费者。未引用文案不是文件。不能据此确认精确数量 17。                                                                            |
| D.2 错误分类 GET 绕过 AI 配额                   | 误报。GET 仅查询既有 `error_categorisations`；实际补分类入口在 digest-generator，正常情况下检查配额。异常放行问题是 AUD-04。                                                                         |
| D.3 冻结但还能用                                | subjects / tags / onboarding / usage 仍有调用；Insights 有 generate、after、status、cron 的代码链路。仅检查链路不能宣告生产可用，AUD-04 与 AUD-13 是实际反例。                                       |
| D.3 statistics 页面跑在组件前面                 | 新旧代码并存成立；页面最近提交 `88d80b7` 是认证调用变更，不能仅用最后提交日期证明当日新增业务能力，也不能证明旧组件不兼容。                                                                          |
| D.4 copy / report / like 全部零测试             | 原先 like、report 缺少直接 route 测试；copy、copy-problem 已有 `problem-marks-copy-*-route.test.ts`。本 PR 补充互动测试，不声称 mock 测试覆盖数据库并发计数。                                        |
| E.2 所有特权取数都使用 service client           | 后台准入主要仅限 super-admin 成立；“全部取数”过强，例如 `searchUsers()`、`getUserProfile()` 仍使用普通 client，具体函数需分别检查。                                                                  |
| E.3 数据库完全没有 admin 概念                   | 没有基于 admin 的跨用户 RLS 放行，成立；数据库确实储存角色并在统计函数中计算 admin。更严重的是角色列的更新权限问题 AUD-01。                                                                          |
| E.3 配额和限流一视同仁                          | 未发现角色豁免。这本身可以是合理策略；管理员拥有配额覆盖配置能力，也不代表所有管理员自动无限配额。                                                                                                   |
| E.3 前端零角色条件渲染                          | 字面误报：后台 role badge 和用户详情存在角色条件渲染。主应用导航没有 admin 入口的判断成立。                                                                                                          |
| E.4 角色工具仅有测试消费者                      | 在审核基线的应用及测试导入图中，`isCurrentUserAdmin`、`isAdminRole`、`isModeratorRole` 均未找到消费者；`getEffectiveRole` 这个函数名不存在。本 PR 为现有角色工具补测试。                             |
| E.5 运行时只有 user 与 super-admin 两档         | 就后台授权能力而言基本成立，不能扩展为整个数据层安全正确；AUD-01、AUD-03 尚未解决。                                                                                                                  |
| F.1 完整且一致的树状层级                        | 外键关系存在，但不是严格树：题目属于科目，可被多个错题本收录；词库的科目可为空。删除科目对笔记本使用 CASCADE、对词库使用 SET NULL，对待办关联也使用 SET NULL，生命周期不一致。                       |
| F.2 扁平书架本身就是核心问题                    | 这是设计判断。当前页面明确写“科目只用于筛选和整理”，以本为中心的书架可以保留。应修复归属与操作语义，并为科目全部题目视图标明收录关系。                                                               |
| F.3 术语冲突                                    | 成立：错题本、题集、笔记本、空白笔记混用，含复制单题按钮的“加入笔记本”。应制定术语表并统一操作结果说明。                                                                                             |
| F.4 缺少独立列表导航                            | `/problem-sets` 有列表；`/notebooks` 根页面当前不存在，仅有 notebook 详情及阅读页，不能直接新增一个指向根路径的导航项。书架创建和打开 notebook 都能进入详情；“只能手输 URL”表述过强。                |
| F.4 没有面包屑必须替代 `from`                   | 未发现面包屑。`from` 保存进入来源与面包屑表达内容层级是不同职责，可并存；不能按路由路径把科目和错题本都推断为唯一父容器。                                                                            |
| F.5 i18n 断层                                   | 成立。现有检查返回两套消息 1758 个 key 完全一致、无缺 key，仍未检测页面硬编码中文；字典对齐通过不等于页面翻译完成。                                                                                  |

### 静态未引用清理候选

本次核验的 11 个文件：

- `web/components/ui/{async-button,form-dialog,skeleton,color-picker,icon-picker}.tsx`
- `web/app/[locale]/(app)/subjects/subject-row.tsx`
- `web/components/subjects/review-due-button.tsx`
- `web/lib/hooks/useSubjectForm.ts`
- `web/lib/storage/move.ts`
- `web/lib/supabase/middleware.ts`
- `web/lib/categorise-error.ts`

扫描包括静态导入、重导出、字面量动态导入和测试 mock。计算型动态导入、仓库外消费者和框架自动入口不在此口径内；清理前仍需确认。此次不删除这些文件。

## A / B 统计校准

以下均是新增测试前的审核基线，不是本 PR 合入后的文件数量。

| 指标                                                 | 当前核验                                                                                                  |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `git diff --name-status --find-renames 9153d93 HEAD` | 新增 787、修改 153、删除 15、重命名 1                                                                     |
| 不识别重命名的路径差                                 | 新增 788、删除 16；problem-form 的移动不能算真实删除                                                      |
| 分叉点文件逐字节未改                                 | 219，原报告成立                                                                                           |
| 分叉后提交总数                                       | 329，原报告 277 已过时                                                                                    |
| 分叉后新增 Web TS/TSX 路径                           | 435；原报告 450 未在本口径复现                                                                            |
| 新 Web TS/TSX 对原有文件的依赖记录                   | 527；含类型导入、重导出、字面量动态导入和测试 mock，与原报告 432 不同，不能当成同口径比较                 |
| `web/contracts` 文件                                 | 100，原报告成立；有 5 份 `.schema.json`，不是 6 份。problem-ingestion-v1 目录目前是 README 和两份提示文档 |
| 顶层 `web/lib/__tests__/*.test.*`                    | 130 个测试文件，原报告 143 与该口径不一致                                                                 |
| Web 全部 TS 单测和 E2E spec                          | 137，加 realtime-proxy 的 1 个测试文件为 138；另有 16 份数据库测试 SQL                                    |
| `web/lib/__tests__` 分叉后提交                       | 109                                                                                                       |
| 迁移文件 / 分叉后迁移提交                            | 72 个文件 / 55 个提交；文件数与提交数须分别列出                                                           |

“新业务依赖已有 UI、Supabase、日志、限流等基础模块”这一方向成立。复用旧模块不是缺陷，零提交也不是功能故障的证据。

## 本 PR 新增的测试

| 测试                                    | 覆盖的行为                                                                         |
| --------------------------------------- | ---------------------------------------------------------------------------------- |
| `onboarding-routes.test.ts`             | 匿名拒绝、空账号、首题所属科目、查询失败、完成时间的归属与保留                     |
| `subjects-tags-routes.test.ts`          | 科目与标签创建、读取、更新、删除、内容限制、用户过滤、失败不失效缓存               |
| `problem-set-social-routes.test.ts`     | 点赞、收藏、举报、浏览；匿名与未授权请求、原子切换结果、重复举报、浏览去重身份     |
| `problem-set-membership-routes.test.ts` | 移除仅解除本内关联，owner 验证、输入拒绝、写入失败不报成功                         |
| `admin-users-routes.test.ts`            | 用户列表、详情、角色变更和删除；普通账号拒绝、自身角色保护、super-admin 删除保护   |
| `user-role-permissions.test.ts`         | 四档角色辅助函数、真实后台角色 predicate、匿名及无 profile 情况                    |
| `announcement-route.test.ts`            | 公告返回、无公告、数据库故障时页面降级                                             |
| `insights-routes.test.ts`               | 状态轮询、过期失败、并发冲突、冷却、数据不足、202 与后台执行顺序、失败落库         |
| `digest-categorisation.test.ts`         | 无积压、配额耗尽、正常扣配额、输出解析、单次提供商失败、故障配额路径               |
| `problem-set-review-access.test.ts`     | 公开、私有、受限访问规则；匿名单题深链接及受限复习的已知越权                       |
| `require-user-status.test.ts`           | JWT 身份、无效 token、停用状态的已知鉴权缺口                                       |
| `cookie-consent-provider.test.ts`       | Context 必须存在、SSR 无默认同意、公开接受/拒绝动作、必要 cookie 保留、HTTPS flags |

### 已知缺陷测试的含义

下列四个需求以 Vitest `it.fails` 记录，当前期望的安全 / 故障行为会断言失败：

- AUD-02：没有分享授权的登录用户应无法读取受限题集复习内容。
- AUD-03：账号被停用后，有效 JWT 也应被通用鉴权拒绝。
- AUD-04：配额后端不可用时，不应继续消耗 AI 调用。
- AUD-13：数据库读取失败不应被展示为没有 Insights 历史。

`it.fails` 表示已知缺陷的可执行复现，不表示需求已通过。修复后必须移除 `.fails` 并将这些测试变为普通正向回归断言，否则 Vitest 会报“预期失败却通过”。P0 角色列保护需在后续权限修复 PR 中增加真正的 PostgreSQL / PostgREST 测试，本 PR 未用源码字符串检查冒充数据库验收。

Cookie 测试通过 SSR 捕获公开 Context 动作，验证实际 cookie 写入函数；没有覆盖挂载后的 cookie 恢复、浏览器交互和跨文档持久化。新增能力（通知、账号自助导出、举报处理）没有实现，因此不存在可以用单元测试补齐的执行路径。

## 后续修复顺序与验收

1. 权限修复 PR：保护角色及停用列，补受限复习的统一授权，落实停用策略；同时增加跨用户 PostgreSQL / PostgREST 测试。不能只修 Web 表单或隐藏按钮。
2. 操作语义：统一“移出本错题本”与“删除题目”，标明题目收录位置，验证移动端、批量操作及刷新后的结果。
3. 服务故障：明确 AI 配额故障策略，修 Insights 读取失败，验证后台任务与轮询状态一致。
4. 承诺未兑现的功能：先补举报处理及提醒投递闭环，再安排自助删除 / 全量导出。
5. 产品体验：统一术语、按用户学习场景引导、补英文文案和浏览器测试；书架、科目聚合和返回来源分别承担自己的职责。

## 实时 GitHub 查询快照

fork open PR：[#80](https://github.com/helemazuba-boop/Wrong-Question-Notebook/pull/80)、[#83](https://github.com/helemazuba-boop/Wrong-Question-Notebook/pull/83)、[#84](https://github.com/helemazuba-boop/Wrong-Question-Notebook/pull/84)、[#85](https://github.com/helemazuba-boop/Wrong-Question-Notebook/pull/85)、[#86](https://github.com/helemazuba-boop/Wrong-Question-Notebook/pull/86)。fork open issue 查询为空。

upstream open issue：[#86 注册故障](https://github.com/mrmagic2020/Wrong-Question-Notebook/issues/86)；open PR：[#99](https://github.com/mrmagic2020/Wrong-Question-Notebook/pull/99)。此快照会随仓库状态变化，本 PR 本身不在审核时快照内。

## 验证结果

- 新增 12 个测试文件、113 个用例：109 个通过、4 个预期失败；四项缺陷仍开放。
- `npm run test`：142 个测试文件通过，1 个原有数据库集成文件跳过；1450 个用例通过、4 个预期失败。
- 跳过的是 `fsrs-projector-database.test.ts`，未配置 `FSRS_TEST_SUPABASE_URL` / `FSRS_TEST_SUPABASE_SERVICE_ROLE_KEY`；此结果不算数据库验收通过。
- `npm run type-check`、`npm run format:check`、`git diff --check`、仓库禁止路径检查通过。首次 ESLint 在新增 cookie 测试发现一项 `react/no-children-prop` 错误，已改用 `createElement` 的 children 参数并通过该文件复查；完整 lint 和格式检查由提交钩子再次执行。
- 没有变更生产代码、数据库迁移、依赖或 CI 策略；未执行浏览器 E2E、真实数据库权限与设备验收。

上述基线统计不随新增测试重新计算。
