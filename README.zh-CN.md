# Wrong Question Notebook

<p align="center">
  <img src="./web/public/W_logo.svg" width="88" alt="WQN Logo" />
</p>

<p align="center">
  <strong>一个围绕错题、复习与长期学习证据构建的开源学习系统。</strong>
</p>

<p align="center">
  Web · MCP · AI · 学习数据 · 专用终端
</p>

<p align="center">
  简体中文 · <a href="./README.en.md">English</a>
</p>

---

## WQN 是什么？

Wrong Question Notebook，简称 **WQN**。

WQN 最初是一个用于整理和复习错题的 Web 应用，如今正在逐渐发展为一套完整的学习系统。

一道错题不只是需要保存的题目。

一次错误、一次订正、一次重新作答、一次延迟复习，都会留下关于学习状态的信息。

WQN 将这些信息视为：

> **学习证据。**

这些证据可以帮助回答：

* 我为什么会错？
* 这道题真正需要哪些知识？
* 我缺少的是知识，还是解题方法？
* 某类错误是否正在反复出现？
* 什么时候应该再次复习？
* 多次复习之后，学习状态发生了什么变化？

WQN 围绕一条长期学习链路构建：

```text
记录
 ↓
理解
 ↓
复习
 ↓
反馈
 ↓
积累
```

而 WQN 并不绑定于某一种交互方式。

目前，WQN 拥有三种主要入口：

```text
                         WQN
                          │
                   ┌──────┴──────┐
                   │  WQN Cloud  │
                   │             │
                   │ API · Data  │
                   │ AI · Sync   │
                   │ Insights    │
                   └──────┬──────┘
                          │
          ┌───────────────┼───────────────┐
          │               │               │
          ▼               ▼               ▼

       WQN Web          WQN MCP        WQN Note4

       图形界面          AI Agent        专用学习终端
       管理与复习        35 个工具         墨水屏
       Discovery        自然语言交互      离线学习
       Insights         外部客户端        Audio / Cache
```

Web、MCP 与 Note4 面向不同场景，但连接的是同一套 WQN 数据、学习状态与复习历史。

---

# WQN Web

WQN Web 是 WQN 完整的图形化学习与管理界面。

它适合浏览、整理和编辑大量学习内容，也是观察长期学习状态的主要入口。

目前包括：

* 错题与 Notebook 管理
* 兼容高考的题目模型
* 用户自由标签
* Problem Set
* Smart Set
* 结构化 Review Session
* AI 题目识别
* Statistics
* Insights
* Word Study
* Todo
* Discovery
* 用户与权限
* 设备管理
* 学习历史

对于需要大量浏览、编辑、筛选和可视化的任务，Web 仍然是最完整的操作环境。

但 Web 并不是 WQN 唯一的界面。

---

# WQN MCP

WQN 提供完整的 **Model Context Protocol（MCP）** 服务。

当前 WQN MCP 包含 **35 个工具**，已经覆盖 Web 中绝大多数核心操作。

这使 WQN 可以直接接入支持 MCP 的 AI 客户端，例如：

* Claude Desktop
* ChatGPT
* Qwen
* Kimi Work
* 以及其他兼容 MCP 的 Agent 与客户端

```text
Claude Desktop ─┐
ChatGPT ─────────┤
Qwen ────────────┼── MCP ──► WQN Cloud
Kimi Work ───────┤
Other Agents ────┘
```

通过 MCP，AI Agent 不只是能够“查询 WQN”。

它可以真正操作 WQN。

例如：

```text
“把这道题保存到数学 Notebook。”

“找出我最近做错的函数题。”

“给这些题加上合适的标签。”

“把这几道题整理成一个 Problem Set。”

“看看我最近有哪些题需要复习。”

“分析一下最近重复出现的错误。”

“帮我把今天的学习内容整理进 WQN。”
```

Agent 可以根据任务连续调用多个 WQN 工具，读取已有数据、创建内容、修改内容并继续完成后续工作。

MCP 覆盖的能力包括题目、Notebook、标签、Problem Set、学习记录以及其他 WQN 核心数据与操作。

这意味着：

> **WQN 的能力不再与 WQN 自己的 UI 绑定。**

用户可以更换模型、更换 Agent、更换客户端，而不需要迁移自己的 WQN 数据。

```text
        Interaction Layer

 WQN Web
 Claude Desktop
 ChatGPT
 Qwen
 Kimi Work
 Other Agents
       │
       ▼
   API / MCP
       │
       ▼
    WQN Cloud
       │
       ▼
 Learning Data
```

**使用 WQN，但留在你熟悉的环境里。**

---

# WQN Note4

[WQN Note4](https://github.com/helemazuba-boop/wqn-zectrix-note4-firmware) 是 WQN 的专用墨水屏学习终端。

它基于 ESP32 与 4.2 英寸电子墨水屏，将部分 WQN 学习流程带到一个更加专注、低干扰，并且不依赖浏览器的环境中。

当前终端能力包括：

* 错题复习
* Word Study
* Todo
* 本地缓存
* 离线学习
* 设备同步
* 音频
* Voice AI

```text
WQN Cloud
    │
    │ Device API
    ▼
WQN Note4
    │
    ├── E-paper
    ├── Audio
    ├── Cache
    └── Offline Study
```

WQN Note4 并不尝试在 ESP32 上复制整个 WQN Web。

账号、权限、长期学习数据、复杂 AI 调用和数据处理仍由服务器承担。

终端负责更适合本地完成的部分：

* 校内学习
* 题目与学习内容显示
* 按键交互
* 音频
* 本地缓存
* 离线体验
* 专注复习

**使用 WQN，但就在老师眼皮底下。**

---

# 一个系统，三种入口

Web、MCP 与 Note4 并不是三个独立产品。

它们是同一个 WQN 的三种交互方式。

```text
                       WQN Cloud
                           │
             ┌─────────────┼─────────────┐
             │             │             │
             ▼             ▼             ▼
            Web           MCP          Note4
             │             │             │
             ▼             ▼             ▼
         人机界面       AI Agent       专用硬件
```

**Web** 适合：

> 浏览、编辑、管理和观察。

**MCP** 适合：

> 让 AI Agent 直接理解并操作学习数据。

**WQN Note4** 适合：

> 在低干扰环境中完成学习与复习。

三者最终汇入同一份学习历史。

一条通过 MCP 创建的题目，可以随后在 Web 中继续整理，并进入 Note4 的复习流程。

一次在 Note4 上完成的复习，也可以同步回 WQN Cloud，成为之后 Statistics、Insights 与学习调度的一部分。

客户端可以变化。

模型可以变化。

设备可以变化。

**学习数据保持连续。**

---



# 从题目管理到学习证据

保存题目只是 WQN 学习链路的起点。

如果一道题最终只留下：

```text
题目
答案
标签
```

那么真正有价值的大量信息仍然会丢失。

WQN 更关心：

```text
题目
+
作答
+
错误
+
订正
+
复习
+
用户反馈
+
长期变化
```

这些数据共同描述的是学习过程。

例如，同样一道题做错：

```text
情况 A
知识点完全不会

情况 B
知道知识点
但没有意识到应该在这里使用

情况 C
方法完全正确
但计算错误

情况 D
第一次不会
第二次已经能够独立完成
```

它们显然不是同一种学习状态。

因此 WQN 正在逐渐把 **Problem** 与 **Attempt** 分开看待：

> Problem 描述“这是一道什么题”。

> Attempt 描述“这一次我是怎么做的”。

长期复习的价值，来自后者的不断积累。

---

# Marks：描述一道题真正需要什么

一道题通常不会只对应一个知识点。

例如一道函数最值问题，可能同时涉及：

```text
Target
求参数范围

Required Knowledge
函数
单调性
不等式

Required Skill
参变分离
分类讨论
最值分析

User Labels
我没想到参变分离
计算错误
二次函数
```

WQN 当前正在围绕几个不同层次建立更加稳定的 Mark 结构。

## Target

描述题目最终要求完成什么。

## Required Knowledge

描述完成题目需要掌握哪些知识。

## Required Skill

描述完成题目需要哪些方法、策略和解题能力。

## User Labels

用户自己的自由标签。

机器可以帮助建立结构，但用户自己的判断不会因此被取代。

例如：

```text
我没想到参变分离
辅助线没想到
审题错误
计算又错了
老师讲过
```

这类信息未必适合作为标准知识点，却可能是最真实、最有价值的学习反馈。

因此 WQN 会同时保留：

> **机器可计算的结构**

和

> **用户自己的语言。**

---

# Attempt Evidence

题目结构告诉 WQN：

> 这道题需要什么。

实际作答则告诉 WQN：

> 这一次发生了什么。

一次 Attempt 可以留下类似这样的学习证据：

```text
知识点掌握，但未识别使用时机

能够完成参变分离，但分类讨论遗漏

方法正确，最终计算错误

查看提示后可以独立完成

第一次不会，第二次独立完成
```

当这些 Evidence 长期积累后，WQN 才有可能真正回答：

* 哪些知识点长期薄弱？
* 哪些 Skill 经常无法主动调用？
* 哪些错误只是偶发计算问题？
* 哪些问题经过复习正在改善？
* 下一次最值得复习什么？

这也是未来 Insights 与学习调度的基础。

---

# Review

题目可以进入结构化 Review Session。

复习过程可以记录：

* 当前题目
* 用户作答
* 正误结果
* 自我评价
* 答案与解析查看
* Session 状态
* 历史复习行为
* 设备侧复习进度

复习并不是简单地：

> “把旧题再做一遍。”

它更重要的作用是不断产生新的学习证据。

```text
Problem
   │
   ▼
Attempt
   │
   ▼
Evidence
   │
   ▼
Review
   │
   └──────────┐
              ▼
          New Attempt
              │
              ▼
        Updated Evidence
```

学习状态因此不是一个静态标签，而是一段不断变化的历史。

---

# Statistics & Insights

WQN 已经拥有 Statistics 和 Insights 相关能力，用于观察长期学习活动。

包括：

* 学习活动记录
* 连续学习情况
* 题目状态
* 累积进度
* Notebook 对比
* Review Session 数据
* 最近活动
* 学习趋势

Statistics 更擅长回答：

> **发生了什么？**

Insights 则正在向另一个方向发展：

> **为什么会发生？**

最终，Insights 不应该只是更多图表。

它应该能够结合：

```text
Problems
Attempts
Marks
User Labels
Review History
```

帮助用户理解自己的学习状态。

---

# AI

AI 在 WQN 中承担的是辅助角色。

当前 AI 可以参与：

* 图片题目识别
* 结构化内容提取
* 学习内容处理
* Voice AI
* Agent / MCP 工作流
* 未来的 Mark 辅助标注与 Insights

WQN 不把 AI 输出视为不可修改的事实。

对于学习系统而言：

> **用户反馈往往比机器判断更加重要。**

机器适合：

* 降低录入成本
* 提供候选结构
* 处理大量重复工作
* 从历史数据中寻找模式

而最终学习数据仍然应该允许用户检查、修正和覆盖。

---

# Discovery

WQN 包含公开 Problem Set 的 Discovery 系统。

它支持：

* Public / Unlisted 内容
* 全文搜索
* 分类筛选
* 创作者页面
* 收藏
* 浏览
* 点赞
* Copy
* 举报与内容管理

Discovery 的目标不仅是：

> 分享一套题。

它也是 WQN 内容生态的基础。

未来，不同用户整理的题目、Problem Set、学习资料与学习经验，可以在保留个人学习数据边界的前提下形成更加开放的内容网络。

---

# Word Study

WQN 还包含独立的 Word Study 学习链路。

云端负责：

* Word 数据
* Deck
* 学习状态
* Review Progress
* Session
* 数据同步

Web、MCP 和 Note4 可以围绕同一份 Word Study 数据提供不同的交互方式。

因此 Word Study 并不是 Note4 的本地附加功能。

它属于 WQN Cloud 的学习能力之一。

---

# Device Platform

WQN Cloud 包含面向物理学习设备的版本化 Device API 与正式数据契约。

目前相关基础设施已经覆盖：

* 设备配对
* 临时 Display Code
* Bootstrap
* 同步
* 设备身份认证
* Credential Provisioning
* Token Rotation
* 请求幂等
* Review Progress
* Note Study
* Word Study
* Voice AI

设备 Credential Provisioning 使用：

```text
P-256 ECDH
    ↓
HKDF
    ↓
AES-GCM
```

设备 Token 在服务器侧保存为 SHA-256 Digest，而不是直接保存明文 Token。

WQN 因此可以将 Note4 这样的物理设备视为正式客户端，而不是简单连接几个 HTTP API 的 ESP32 Demo。

---

# Voice AI

支持的设备可以通过 WQN Cloud 使用 Voice AI。

```text
Device
  │
  │ PCM Audio
  ▼
WQN Cloud
  │
  ├── Authentication
  ├── Audio Validation
  ├── ASR
  ├── AI Provider
  ├── LLM
  └── Streaming
        │
        ▼
      Device
```

服务器负责：

* 音频验证
* ASR
* AI Provider
* LLM 请求
* Streaming
* Thinking / Reasoning Event
* Authentication
* Rate Limit
* Body Size Limit
* Provider Error Handling

复杂 Provider 逻辑因此不会被塞进 ESP32。

设备只需要面对稳定的 WQN 协议。

---

# Cloud / Client 架构

WQN 将长期学习数据、服务能力与客户端交互明确分层。

```text
┌────────────────────────────────────────────────────┐
│                     WQN Cloud                      │
│                                                    │
│ Learning Data    Review State       AI Services   │
│      │                │                  │         │
│      ├──── API / MCP / Auth / Sync ──────┤         │
│      │                │                  │         │
│ PostgreSQL         Insights          ASR / LLM     │
│ Supabase           Scheduling        Providers     │
└─────────────────────────┬──────────────────────────┘
                          │
             ┌────────────┼────────────┐
             │            │            │
             ▼            ▼            ▼
          WQN Web      AI Agents     WQN Note4
          Browser         MCP          Device
```

服务器负责：

* 用户与权限
* 学习数据
* Problem / Attempt
* 复习状态
* AI Provider
* MCP
* Device API
* 数据同步
* 数据一致性
* Insights
* 长期学习历史

客户端负责提供适合不同环境的交互方式。

WQN 因此不要求某一个客户端成为整个系统的中心。

真正持续存在的是：

> **学习数据本身。**

---

# 当前能力

WQN 正在快速开发中。

当前已经存在的主要能力包括：

### 内容

* Notebook
* GaoKao 兼容 Problem
* Tag
* Rich Text
* LaTeX
* 图片与附件
* Problem Set
* Smart Set

### 学习

* Review Session
* Attempt
* Statistics
* Insights
* Word Study
* Todo

### AI

* AI Problem Extraction
* Voice AI
* Provider-backed AI Services
* MCP Agent 工作流

### 社区

* Discovery
* Public Problem Set
* Creator Profile
* 收藏
* 点赞
* Copy
* 举报与管理

### 客户端

* WQN Web
* WQN MCP
* WQN Note4

### 设备基础设施

* Device Control v3
* Note Study v1
* Word Study v1
* Pairing
* Bootstrap
* Sync
* Credential Provisioning
* Device Authentication
* Token Rotation

---

# 正在建设

WQN 正在从：

> **错题管理工具**

继续向：

> **学习系统**

演进。

目前主要方向包括：

* Canonical Mark 库
* Target
* Required Knowledge
* Required Skill
* 多 Mark 题目结构
* 保留自由 User Labels
* Attempt Evidence
* Evidence-driven Insights
* FSRS 复习调度
* 更完整的学习状态建模
* 题目图片处理与设备下发
* 更完善的离线能力
* Web / MCP / Note4 之间更统一的学习状态

其中部分功能仍处于设计或开发阶段。

**Roadmap 不代表已经实现。**

当前行为应以源码、正式 Contract 与 [`CHANGELOG.md`](./CHANGELOG.md) 为准。

---

# 技术栈

| 层            | 技术                               |
| ------------ | -------------------------------- |
| Runtime      | Node.js 24+                      |
| Framework    | Next.js 16                       |
| Language     | TypeScript                       |
| UI           | React / Tailwind CSS / shadcn/ui |
| Rich Text    | TipTap                           |
| Math         | KaTeX                            |
| Database     | PostgreSQL                       |
| Backend      | Supabase                         |
| Auth         | Supabase Auth                    |
| Storage      | Supabase Storage                 |
| Validation   | Zod                              |
| CAPTCHA      | Cloudflare Turnstile             |
| Charts       | Chart.js                         |
| Tables       | TanStack Table                   |
| Testing      | Vitest                           |
| Code Quality | ESLint / Prettier                |

WQN 的 AI、MCP 与设备服务仍在快速演进。

具体依赖版本与 Provider 配置请以：

* `web/package.json`
* `web/env.example`
* `CHANGELOG.md`

为准。

---

# 开始开发

## 环境要求

需要：

* Node.js 24+
* npm
* Docker
* Supabase CLI

## Clone

```bash
git clone https://github.com/helemazuba-boop/Wrong-Question-Notebook.git
cd Wrong-Question-Notebook/web
```

## 安装依赖

```bash
nvm use
npm install
```

## 启动本地 Supabase

```bash
npx supabase start
```

## 配置环境变量

```bash
cp env.example .env.local
```

根据需要填写对应服务的环境变量。

## 启动开发服务器

```bash
npm run dev
```

完整开发环境、数据库工作流、代码质量要求与贡献规范请阅读：

[`CONTRIBUTING.md`](./CONTRIBUTING.md)

---

# 仓库结构

```text
Wrong-Question-Notebook/
├── web/
│   ├── app/
│   │   ├── [locale]/          # Web 应用页面
│   │   └── api/               # Web / AI / Device API
│   │
│   ├── components/            # UI 与业务组件
│   ├── contracts/
│   │   ├── device-control-v3/
│   │   ├── note-study-v1/
│   │   └── word-study-v1/
│   │
│   ├── lib/                   # 核心逻辑
│   ├── messages/              # i18n
│   ├── public/                # 静态资源
│   ├── server/                # 服务端组件
│   └── supabase/              # 数据库与 Migration
│
├── deploy/                    # 部署资源
├── CHANGELOG.md
├── CONTRIBUTING.md
└── LICENSE
```

README 只负责介绍 WQN 作为一个系统。

更具体的实现细节、协议定义与工程约束应放在对应源码、Contract 和专项文档附近。

---

# 项目状态

WQN 正处于活跃开发阶段。

目前的很多设计仍然在真实学习流程中持续验证，因此：

* 数据模型仍可能演进
* MCP 工具仍可能增加或调整
* Device API 会继续版本化
* Mark 模型仍在建设
* Insights 会持续变化
* Review Scheduling 正在演进
* 部分模块仍然具有实验性质

重要实现变化请查看：

[`CHANGELOG.md`](./CHANGELOG.md)

---

# 参与开发

欢迎参与：

* Bug Fix
* 性能改进
* 文档
* MCP
* Device
* 数据同步
* 学习算法
* 题目处理
* UI / UX
* 明确且可验证的新功能

开始之前请阅读：

[`CONTRIBUTING.md`](./CONTRIBUTING.md)

对于涉及以下核心结构的较大修改：

* Problem Model
* Attempt
* Mark
* Insights
* Review Scheduling
* MCP
* Device Protocol

建议先讨论数据模型和行为边界，再进入实现。

---

# 上游项目与致谢

WQN 起源于：

[`mrmagic2020/Wrong-Question-Notebook`](https://github.com/mrmagic2020/Wrong-Question-Notebook)

原项目建立了 WQN 最早的 Web、Notebook、题目管理、Problem Set 与复习基础。

当前项目继续在此基础上发展，并逐渐扩展到：

* GaoKao 兼容题目模型
* MCP
* AI Agent 接入
* Attempt 与学习证据
* Insights
* Word Study
* 物理学习设备
* Device API
* 离线学习
* Voice AI
* 长期学习数据基础设施

感谢原项目及所有贡献者建立的基础。

---

# License

本项目基于 **GNU General Public License v3.0** 发布。

详见：

[`LICENSE`](./LICENSE)

---

<p align="center">
  <strong>错题不是学习过程的终点。</strong><br />
  <strong>它是下一次学习决策的证据。</strong>
</p>
