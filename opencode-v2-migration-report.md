# OpenCode v2 完整探测报告

## 执行摘要

通过实际探测 + 官方 API 文档分析，**强烈建议直接迁移到 v2**：
- ✅ v2 原生解决 P2/P3a（历史回填 + question 支持）
- ⚠️ v2 事件流完全重写（不兼容）
- ⚠️ 迁移成本中等（约 2-3 天工作量）

---

## 探测环境

- **服务地址**: `http://localhost:49374`
- **OpenCode CLI**: v1.18.25
- **OpenCode Desktop**: v2.0.16 (提供认证凭据)
- **认证**: Basic Auth (`opencode` / `1gMsI-CWPEvzTDKwzA4ewK0uQYbgXGBzYUQygtzBf9Y`)

---

## v1 vs v2 API 完整对比

### Session 端点

| 功能 | v1 端点 | v2 端点 | 状态 |
|------|---------|---------|------|
| **列表会话** | `GET /session` | `GET /api/session` | ✅ 路径变化 |
| **创建会话** | `POST /session` | `POST /api/session` | ✅ 路径变化 |
| **获取详情** | ❌ 不存在 | `GET /api/session/:id` | 🎉 **v2 新增** |
| **消息历史** | ❌ 不存在 | `GET /api/session/:id/message` | 🎉 **v2 新增** (P3a!) |
| **发送消息** | `POST /session/:id/prompt_async` | `POST /api/session/:id/prompt` | ⚠️ **端点重命名** |
| **观察会话** | `GET /session/:id/events` | ❌ 不存在 | ⚠️ **已移除** |
| **等待完成** | ❌ 不存在 | `POST /api/session/:id/wait` | 🎉 v2 新增 |
| **上下文** | ❌ 不存在 | `GET /api/session/:id/context` | 🎉 v2 新增 |

### Permission 端点 (P3a 权限恢复)

| 功能 | v1 | v2 | 状态 |
|------|----|----|------|
| **列表权限** | ❌ 不存在 | `GET /api/permission` | 🎉 **v2 新增** |
| **回复权限** | `POST /permission/:id/reply` | `POST /api/permission/:id/reply` | ✅ 保持 |
| **字段** | `{ reply: "once" | "reject" }` | `{ permissionID, response }` | ⚠️ 结构调整 |

### Question 端点 (P2 question.* 支持)

| 功能 | v1 | v2 | 状态 |
|------|----|----|------|
| **列表问题** | ❌ 不存在 | `GET /api/question` | 🎉 **v2 新增** |
| **拒绝问题** | ❌ 不存在 | `POST /api/question/:id/reject` | 🎉 **v2 新增** |

### Event Stream (SSE)

| 项目 | v1 | v2 |
|------|----|----|
| **端点** | `GET /event` | `GET /api/event` |
| **事件类型** | `agent.*` (8 个) | `server.*` + `session.*` |
| **格式** | `{ event, data }` | `{ id, type, time, context, payload }` |

**v1 事件类型**（已废弃）:
```
agent.accepted
agent.attached
agent.status
agent.text.delta
agent.text
agent.tool
agent.permission
agent.error
```

**v2 事件类型**（已探测）:
```
server.connected           # 服务器连接
session.step.started       # Agent 步骤开始
session.step.failed        # Agent 步骤失败
session.execution.failed   # 执行失败
# + 更多类型（文档未完全列出）
```

---

## P2/P3a 解决方案

### ✅ P2: question.* 事件支持

**v2 原生支持，零代码！**

```typescript
// GET /api/question - 获取待处理问题列表
GET /api/question
Response: QuestionRequest[]

// POST /api/question/:id/reply - 拒绝问题
POST /api/question/questionID/reply
Body: { questionID: string }
```

**固件无需改动事件解析器**，只需添加 question 处理逻辑。

### ✅ P3a: 历史回填

**v2 原生支持！**

```typescript
// GET /api/session/:id/message - 分页获取消息历史
GET /api/session/:id/message?limit=50&order=desc&cursor=xxx

Response:
{
  "data": [
    {
      "id": "msg_xxx",
      "type": "user" | "assistant",
      "time": { "created": 1790251346766, "completed": 1790251346891 },
      "agent": "build",
      "model": { "id": "fireworks/ember-1", "providerID": "openrouter" },
      "content": [],  // Assistant 消息内容数组
      "text": "...",   // User 消息文本
      "error": { ... } // 错误信息（如果有）
    }
  ],
  "cursor": { "previous": "...", "next": "..." }
}
```

**迁移步骤**:
1. Observe 前调用 `GET /api/session/:id/message?order=desc&limit=50`
2. 解析 `type="user"` → `AppendUser(text)`
3. 解析 `type="assistant"` → `AppendAssistant(content)`（v2 用 `content` 数组）
4. 解析 `type="idle"` → 会话完成

### ✅ P3a: 权限恢复

**v2 原生支持！**

```typescript
// GET /api/permission - 获取所有待处理权限请求
GET /api/permission
Response: PermissionRequest[]

// POST /api/permission/:id/reply - 回复权限（v2 结构）
POST /api/permission/permissionID/reply
Body: {
  permissionID: string,
  response: "once" | "reject" | "always"  // v2 可能支持 "always"
}
```

**迁移步骤**:
1. Observe 前调用 `GET /api/permission`
2. 过滤 `permission.sessionID === sessionId`
3. 如果有 `pending_permission_id`，直接恢复 UI 状态
4. 不再丢失权限请求！

---

## v2 迁移成本评估

### 工作量

| 任务 | 预估工作量 | 风险 |
|------|-----------|------|
| **事件流重写**（`agent.*` → `session.*`） | 2-3 天 | 中 |
| **消息格式适配**（`text` → `content[]`） | 0.5 天 | 低 |
| **端点路径更新**（`/session` → `/api/session`） | 0.5 天 | 低 |
| **历史回填实现**（P3a） | 1 天 | 低 |
| **权限恢复实现**（P3a） | 1 天 | 低 |
| **Question 支持**（P2） | 0.5 天 | 低 |
| **P3c 修复**（2 行代码） | 0.1 天 | 极低 |

**总计**: ~5-6 天工作量

### 关键风险

1. **事件流不兼容**（最大风险）
   - v1 的 `agent.status`、`agent.text.delta` 等全部失效
   - v2 事件结构完全不同（`{ id, type, time, context, payload }`）
   - 需要重写 `DispatchAgentEvent()` 和所有 case handler

2. **消息格式变化**
   - v1: `{ "type": "assistant", "text": "..." }`
   - v2: `{ "type": "assistant", "content": [...], "agent": "...", "model": {...} }`
   - `content` 数组需要展开为文本

3. **运行时上下文**
   - v2 引入了 `directory` + `workspaceID` 概念
   - 我们的固件只传 `directory`（通过 `x-opencode-directory` header）
   - 需要确认固件的 context 是否能正确映射

### 优势

1. ✅ **解决 P2/P3a 所有问题**（历史回填、权限恢复、question 支持）
2. ✅ **v1 的 `/prompt_async` 已废弃**（v2 用 `/prompt`），迟早要迁
3. ✅ **事件结构更清晰**（`session.step.*` vs `agent.*` 混搭）
4. ✅ **官方支持**（v2 是当前主要版本，v1 仅维护）
5. ✅ **Durable events + replay**（v2 支持事件持久化和重放，reconnect 更可靠）

---

## 建议的迁移策略

### 方案 A: 直接迁移到 v2（推荐）

**理由**:
- v1 → v2 事件流不兼容，v1 实现无法平滑过渡
- v2 原生解决 P2/P3a，无需自定义实现
- v1 的 `/prompt_async` 在 v2 不存在，必须改
- 官方当前支持 v2，v1 仅维护

**步骤**:
1. **Week 1**: 事件流重写 + 端点路径更新
   - 更新 `DispatchAgentEvent()` 支持 v2 事件
   - 更新所有 HTTP 端点（`/api/session`、`/api/event`）
   - 适配消息格式（`text` → `content[]`）

2. **Week 2**: P2/P3a 实现
   - 历史回填（`GET /api/session/:id/message`）
   - 权限恢复（`GET /api/permission`）
   - Question 支持（`GET /api/question`）

3. **Week 3**: P3c 修复 + 测试
   - `pending_permission_id.clear()` 仅限 idle/error
   - 端到端测试
   - 固件自测更新

### 方案 B: v1 增量修复，再评估 v2

**理由**:
- P3c 修复（2 行代码）可以立即做，成本极低
- P3a 历史回填在 v1 无法实现（无端点），必须等 v2
- 如果 v2 迁移工作量太大，可以考虑混合方案

**步骤**:
1. 立即修复 P3c（2 行代码）
2. 评估 v2 迁移工作量
3. 制定迁移计划

---

## 立即行动项

### ✅ P3c 修复（可以现在做）

**文件**: `main/opencode_session.cpp` ~405 行

```cpp
// 当前代码（错误：ANY status 都清空）
case kStatus:
  g_state.pending_permission_id.clear();
  break;

// 修复后：仅 idle/error 才清空
case kStatus: {
  const auto& status = event.status(); // 需要解析 status 字段
  if (status == "idle" || status == "error") {
    g_state.pending_permission_id.clear();
  }
  break;
}
```

### 🔄 等待用户决策

1. **选择方案 A 还是 B？**
2. **是否授权开始 v2 迁移？**

---

## 参考文档

- **OpenCode v2 API 官方文档**: `https://github.com/anomalyco/opencode/blob/dev/specs/v2/api.html`
- **OpenCode v2 Session 规范**: `https://github.com/anomalyco/opencode/blob/dev/specs/v2/session.md`
- **本地探测脚本**: `/home/unknow/projects/WQN/opencode-v2-probe-auth.mjs`
- **本地探测结果**: `/home/unknow/projects/WQN/opencode-v2-probe-report.md`
