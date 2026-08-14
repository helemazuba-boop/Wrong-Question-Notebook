# Wrong Question Notebook

<p align="center">
  <img src="./web/public/W_logo.svg" width="88" alt="WQN Logo" />
</p>

<p align="center">
  <strong>An open-source learning system built around wrong questions, review, and long-term learning evidence.</strong>
</p>

<p align="center">
  Web · MCP · AI · Learning Data · Dedicated Device
</p>

<p align="center">
  <a href="./README.md">简体中文</a> · English
</p>

---

## What is WQN?

Wrong Question Notebook, or **WQN** for short.

WQN began as a Web application for organizing and reviewing wrong questions. It is now gradually evolving into a complete learning system.

A wrong question is more than something that needs to be saved.

Every mistake, correction, re-attempt, and delayed review leaves information about the learner's current state.

WQN treats this information as:

> **Learning Evidence.**

This evidence can help answer questions such as:

* Why did I get this wrong?
* What knowledge does this problem actually require?
* Am I missing knowledge, or am I missing a problem-solving method?
* Is a certain type of mistake recurring?
* When should I review this again?
* How has my learning state changed after multiple reviews?

WQN is built around a long-term learning loop:

```text
Record
  ↓
Understand
  ↓
Review
  ↓
Feedback
  ↓
Accumulate
```

WQN is not tied to any single form of interaction.

At present, WQN has three primary entry points:

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

       Graphical UI      AI Agent       Dedicated Study Device
       Manage & Review   35 Tools       E-paper
       Discovery         Natural Lang.  Offline Study
       Insights          External Apps  Audio / Cache
```

Web, MCP, and Note4 are designed for different contexts, but they all connect to the same WQN data, learning state, and review history.

---

# WQN Web

WQN Web is WQN's complete graphical learning and management interface.

It is designed for browsing, organizing, and editing large amounts of learning content, and it is also the primary interface for observing long-term learning state.

It currently includes:

* Wrong-question and Notebook management
* GaoKao-compatible Problem model
* Free-form user labels
* Problem Set
* Smart Set
* Structured Review Session
* AI Problem Extraction
* Statistics
* Insights
* Word Study
* Todo
* Discovery
* Users and permissions
* Device management
* Learning history
* Canonical Mark registry (Knowledge / Skill / Target)
* Objective Marking with Skill Retrieval (RAG)
* FSRS review scheduling with human-authority closure
* Attempt Evidence with Mistake / Correction
* Review Events and learning-state history
* Problem Image processing and device delivery

For tasks that involve extensive browsing, editing, filtering, and visualization, the Web remains the most complete operating environment.

But the Web is not WQN's only interface.

---

# WQN MCP

WQN provides a complete **Model Context Protocol (MCP)** service.

WQN MCP currently contains **36 tools**, covering most of the core operations available in the Web application.

This allows WQN to connect directly to AI clients that support MCP, including:

* Claude Desktop
* ChatGPT
* Qwen
* Kimi Work
* Other MCP-compatible Agents and clients

```text
Claude Desktop ─┐
ChatGPT ─────────┤
Qwen ────────────┼── MCP ──► WQN Cloud
Kimi Work ───────┤
Other Agents ────┘
```

Through MCP, an AI Agent can do more than simply "query WQN."

It can actually operate WQN.

For example:

```text
"Save this problem to my Math Notebook."

"Find the function problems I got wrong recently."

"Add appropriate labels to these problems."

"Organize these problems into a Problem Set."

"Show me what I need to review recently."

"Analyze the mistakes that have been recurring lately."

"Help me organize today's learning content into WQN."
```

An Agent can call multiple WQN tools in sequence according to the task, read existing data, create content, modify content, and continue with subsequent operations.

MCP covers Problems, Notebooks, labels, Problem Sets, learning records, and other core WQN data and operations.

This means:

> **WQN's capabilities are no longer tied to WQN's own UI.**

Users can switch models, Agents, and clients without migrating their WQN data.

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

**Use WQN without leaving the environment you already know.**

---

# WQN Note4

[WQN Note4](https://github.com/helemazuba-boop/wqn-zectrix-note4-firmware) is WQN's dedicated e-paper learning terminal.

Built around an ESP32 and a 4.2-inch e-paper display, it brings part of the WQN learning workflow into a more focused, low-distraction environment that does not depend on a browser.

Current device capabilities include:

* Wrong-question review (8 dedicated e-paper screens)
* Word Study
* Todo
* Note Study
* Local cache and offline-first storage
* Full bidirectional sync with WQN Cloud
* Device provisioning (SoftAP captive portal)
* Device authentication and token management
* Deep sleep with generation-tagged wake controller
* Audio and Voice AI (ASR + LLM streaming)
* Power management (sleep lease, USB/charger detection)
* Display service with versioned refresh intents

```text
WQN Cloud
    │
    │ Device API v3 (P-256 ECDH / HKDF / AES-GCM)
    ▼
WQN Note4
    │
    ├── E-paper (400×300, 8 UI pages)
    ├── Audio (I2S / ES8311)
    ├── Power (deep sleep, wake controller)
    ├── Cache (SPIFFS, durable offline state)
    └── Voice AI (SSE streaming, Flash realtime)
```

WQN Note4 does not attempt to reproduce the entire WQN Web experience on an ESP32.

Accounts, permissions, long-term learning data, complex AI calls, and data processing remain on the server.

The device handles the parts that are better suited to local interaction:

* In-school study
* Displaying problems and learning content
* Button-based interaction
* Audio
* Local cache
* Offline experience
* Focused review

**Use WQN, even right under your teacher's eyes.**

---

# One System, Three Entry Points

Web, MCP, and Note4 are not three separate products.

They are three ways to interact with the same WQN system.

```text
                       WQN Cloud
                           │
             ┌─────────────┼─────────────┐
             │             │             │
             ▼             ▼             ▼
            Web           MCP          Note4
             │             │             │
             ▼             ▼             ▼
        Human UI       AI Agent     Dedicated Hardware
```

**Web** is best for:

> Browsing, editing, managing, and observing.

**MCP** is best for:

> Letting AI Agents directly understand and operate learning data.

**WQN Note4** is best for:

> Learning and reviewing in a low-distraction environment.

All three ultimately contribute to the same learning history.

A Problem created through MCP can later be organized in the Web application and then enter the Note4 review workflow.

A review completed on Note4 can also be synced back to WQN Cloud and become part of subsequent Statistics, Insights, and learning scheduling.

Clients can change.

Models can change.

Devices can change.

**Learning data remains continuous.**

---



# From Problem Management to Learning Evidence

Saving a Problem is only the beginning of the WQN learning workflow.

If a Problem ultimately contains only:

```text
Problem
Answer
Labels
```

then a large amount of genuinely valuable information is still lost.

WQN cares more about:

```text
Problem
+
Attempt
+
Mistake
+
Correction
+
Review
+
User Feedback
+
Long-term Change
```

Together, these data describe the learning process.

For example, two incorrect answers to the same Problem may represent very different situations:

```text
Case A
The underlying knowledge is not understood at all

Case B
The knowledge is understood
but the learner did not recognize that it should be used here

Case C
The method is completely correct
but the final calculation is wrong

Case D
The learner could not solve it the first time
but could complete it independently the second time
```

These clearly do not represent the same learning state.

WQN therefore increasingly treats **Problem** and **Attempt** as separate concepts:

> Problem describes "what kind of problem this is."

> Attempt describes "what happened when I tried it this time."

The value of long-term review comes from the continued accumulation of the latter.

---

# Marks: Describing What a Problem Actually Requires

A Problem usually does not correspond to only one knowledge point.

For example, a function-extrema problem may involve all of the following:

```text
Target
Find the range of a parameter

Required Knowledge
Functions
Monotonicity
Inequalities

Required Skill
Separation of parameters and variables
Case analysis
Extremum analysis

User Labels
I didn't think of separating the parameter
Calculation error
Quadratic functions
```

WQN is currently building a more stable Mark structure across several distinct layers.

## Target

Describes what the Problem ultimately requires the learner to accomplish.

## Required Knowledge

Describes the knowledge that must be understood in order to solve the Problem.

## Required Skill

Describes the methods, strategies, and problem-solving abilities required to complete the Problem.

## User Labels

The user's own free-form labels.

Machines can help create structure, but they do not replace the learner's own judgment.

For example:

```text
I didn't think of separating the parameter
I didn't think of drawing the auxiliary line
Misread the question
Made another calculation error
The teacher already explained this
```

This kind of information may not belong in a standardized knowledge taxonomy, but it can still be some of the most authentic and valuable learning feedback.

WQN therefore preserves both:

> **Machine-computable structure**

and

> **The user's own language.**

---

# Attempt Evidence

Problem structure tells WQN:

> What does this Problem require?

The actual Attempt tells WQN:

> What happened this time?

A single Attempt can leave learning evidence such as:

```text
Knowledge understood, but failed to recognize when to apply it

Can separate the parameter, but missed part of the case analysis

Method correct, final calculation incorrect

Can complete the problem independently after viewing a hint

Could not solve it the first time, completed it independently the second time
```

Only after this Evidence accumulates over time can WQN begin to answer questions such as:

* Which knowledge areas remain weak over the long term?
* Which Skills repeatedly fail to be activated when needed?
* Which mistakes are merely occasional calculation errors?
* Which Problems are improving through review?
* What is most worth reviewing next?

This is also the foundation for future Insights and learning scheduling.

---

# Review

Problems can enter structured Review Sessions.

The review process can record:

* The current Problem
* The user's Attempt
* Correct / incorrect result
* Self-assessment
* Whether the answer and explanation were viewed
* Session state
* Historical review behavior
* Device-side review progress

Review is not simply:

> "Do an old problem again."

Its more important role is to continuously generate new learning evidence.

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

Learning state is therefore not a static label, but a continuously changing history.

---

# Statistics & Insights

WQN already includes Statistics and Insights capabilities for observing long-term learning activity.

These include:

* Learning activity records
* Study streaks
* Problem states
* Cumulative progress
* Notebook comparisons
* Review Session data
* Recent activity
* Learning trends

Statistics is better at answering:

> **What happened?**

Insights is moving in another direction:

> **Why did it happen?**

Ultimately, Insights should not simply be more charts.

It should be able to combine:

```text
Problems
Attempts
Marks
User Labels
Review History
```

to help users understand their own learning state.

---

# AI

AI plays an assistive role in WQN.

AI can currently participate in:

* Image-based Problem recognition
* Structured content extraction
* Learning-content processing
* Voice AI
* Agent / MCP workflows
* Future Mark-assisted labeling and Insights

WQN does not treat AI output as an immutable fact.

For a learning system:

> **User feedback is often more important than machine judgment.**

Machines are well suited to:

* Reducing data-entry cost
* Providing candidate structures
* Handling large amounts of repetitive work
* Finding patterns in historical data

But the final learning data should still allow users to inspect, correct, and override machine-generated results.

---

# Discovery

WQN includes a Discovery system for public Problem Sets.

It supports:

* Public / Unlisted content
* Full-text search
* Category filters
* Creator pages
* Favorites
* Browsing
* Likes
* Copy
* Reporting and content moderation

The goal of Discovery is not merely:

> Sharing a set of problems.

It is also the foundation of WQN's content ecosystem.

In the future, Problems, Problem Sets, learning materials, and learning experiences organized by different users can form a more open content network while preserving the boundaries of each user's private learning data.

---

# Word Study

WQN also includes an independent Word Study learning workflow.

The cloud is responsible for:

* Word data
* Decks
* Learning state
* Review Progress
* Sessions
* Data synchronization

Web, MCP, and Note4 can provide different ways to interact with the same Word Study data.

Word Study is therefore not merely a local add-on feature of Note4.

It is one of the learning capabilities provided by WQN Cloud.

---

# Device Platform

WQN Cloud includes a versioned Device API and formal data contracts for physical learning devices.

The related infrastructure currently covers:

* Device pairing
* Temporary Display Code
* Bootstrap
* Synchronization
* Device identity authentication
* Credential Provisioning
* Token Rotation
* Request idempotency
* Review Progress
* Note Study
* Word Study
* Voice AI

Device Credential Provisioning uses:

```text
P-256 ECDH
    ↓
HKDF
    ↓
AES-GCM
```

Device Tokens are stored server-side as SHA-256 Digests rather than plaintext Tokens.

This allows WQN to treat physical devices such as Note4 as first-class clients, rather than as ESP32 demos that simply call a few HTTP APIs.

---

# Voice AI

Supported devices can use Voice AI through WQN Cloud.

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

The server is responsible for:

* Audio validation
* ASR
* AI Provider
* LLM requests
* Streaming
* Thinking / Reasoning Events
* Authentication
* Rate Limit
* Body Size Limit
* Provider Error Handling

Complex Provider logic therefore does not need to be embedded in the ESP32.

The device only needs to interact with a stable WQN protocol.

---

# Cloud / Client Architecture

WQN clearly separates long-term learning data, service capabilities, and client interaction.

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

The server is responsible for:

* Users and permissions
* Learning data
* Problem / Attempt
* Review state
* AI Provider
* MCP
* Device API
* Data synchronization
* Data consistency
* Insights
* Long-term learning history

Clients are responsible for providing interaction methods suited to different environments.

WQN therefore does not require any single client to become the center of the entire system.

What truly persists is:

> **The learning data itself.**

---

# Current Capabilities

WQN is under rapid development.

The major capabilities that currently exist include:

### Content

* Notebook
* GaoKao-compatible Problem
* Tag
* Rich Text
* LaTeX
* Images and attachments
* Problem Set
* Smart Set

### Learning

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
* MCP Agent workflows

### Community

* Discovery
* Public Problem Set
* Creator Profile
* Favorites
* Likes
* Copy
* Reporting and moderation

### Clients

* WQN Web
* WQN MCP
* WQN Note4

### Device Infrastructure

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

# Shared Learning System

WQN's core learning subsystems are now complete and in active use.

```text
WQN Web ◄────► WQN MCP ◄────► WQN Note4
      │             │               │
      └───────── WQN Cloud ──────────┘
              Learning Data
```

## Canonical Mark Registry

WQN maintains a versioned Knowledge Registry containing the canonical definitions of all Knowledge and Skill marks.

* 76 canonical Skills across active subjects
* Profile-neutral retrieval documents (provider-independent)
* Immutable lock: source SHA, content SHA-256, schema version
* Mark stability guaranteed by the Registry, not by ad-hoc LLM output

## Skill Retrieval (RAG)

Skill retrieval selects the top-10 candidate Skills from the Registry for a given Problem, providing the LLM with a closed candidate space for objective marking.

* **Qwen profile** (`skill-rag-qwen37-v1`): Qwen3-Embedding-4B, 2560-dim float
* **Exact cosine top-10**: normalized matrix dot product, no approximation
* **Query allowlist**: Problem title, content, part prompts, and visible choices only — answer/solution/personal evidence are structurally excluded
* **Subject-scoped**: candidates are filtered to the Problem's subject

## Objective Marking

Given the retrieved candidate set, an LLM produces structured Mark assignments:

* `assignments[]` — selected Knowledge and Skill marks (from the current candidate set only)
* `skill_resolution` — `selected` | `no_applicable` | `unresolved`
* `unresolved[]` — reasons when the LLM cannot determine applicability

Objective Marking is additive: it never modifies existing Knowledge/Skill marks without explicit commit validation.

## Annotation Lifecycle

Each Problem Mark annotation run follows a durable claim–prepare–commit protocol:

* **Claim**: atomically claim pending annotations with a lease token
* **Prepare**: load context, run Skill retrieval, run Objective Marking
* **Commit**: CAS-style validation — stale lease, wrong profile fingerprint, or invalid candidate keys all reject the commit
* **Generation-tagged lease renewal**: each renewal RPC call rotates the `lease_token`, making old tokens invalid

## Batch Processing and Wake

A shared bounded batch worker powers both the cron route and the per-Problem annotation path:

* **Concurrency cap**: ≤5 concurrent claims per batch
* **Deadline budget**: configurable `deadlineMs` to bound total runtime
* **Claim limit**: capped at the database RPC maximum (50) to avoid overwhelming the worker
* **Cron route**: `GET /api/cron/problem-marks-annotate`, protected by `CRON_SECRET` Bearer auth
* **after() wake**: Problem create and objective-field PATCH both trigger a best-effort annotation wake via Next.js `after()`
* **Generation-tagged renewal**: long-running batches renew leases between steps; a stale renewal immediately stops the claim — the old worker can never commit

## FSRS Anti-corruption

FSRS scheduling is a pure function of the **human-final Rating stream** only.

* Identical Rating timelines → byte-identical FSRS cards and due dates, regardless of Marks
* `PreparedProjection` uses strict Zod — structurally rejects any Marks/RAG payload
* Dependency guard: `lib/fsrs/**` must never import `problem-marks`, `retrieval`, `rag`, `attribution`, or `radar`

---

WQN is continuing to evolve, with active development in several areas:

* FSRS parameter optimization and per-subject calibration
* NVIDIA embedding profile (2048-dim) as an alternative to Qwen
* Note Study reading loop and retention scheduling
* Word Study full lifecycle completion
* Additional MCP tools for cross-domain workflows
* Insights depth (causal attribution, learning-state trajectories)

---

# Tech Stack

| Layer        | Technology                         |
| ------------ | ---------------------------------- |
| Runtime      | Node.js 24+                        |
| Framework    | Next.js 16                         |
| Language     | TypeScript                         |
| UI           | React / Tailwind CSS / shadcn/ui   |
| Rich Text    | TipTap                             |
| Math         | KaTeX                              |
| Database     | PostgreSQL                         |
| Backend      | Supabase                           |
| Auth         | Supabase Auth                      |
| Storage      | Supabase Storage                   |
| Validation   | Zod                                |
| CAPTCHA      | Cloudflare Turnstile               |
| Charts       | Chart.js                           |
| Tables       | TanStack Table                     |
| Testing      | Vitest                             |
| Code Quality | ESLint / Prettier                  |

WQN's AI, MCP, and device services are still evolving rapidly.

For exact dependency versions and Provider configuration, refer to:

* `web/package.json`
* `web/env.example`
* `CHANGELOG.md`

---

# Getting Started

## Requirements

You will need:

* Node.js 24+
* npm
* Docker
* Supabase CLI

## Clone

```bash
git clone https://github.com/helemazuba-boop/Wrong-Question-Notebook.git
cd Wrong-Question-Notebook/web
```

## Install Dependencies

```bash
nvm use
npm install
```

## Start Local Supabase

```bash
npx supabase start
```

## Configure Environment Variables

```bash
cp env.example .env.local
```

Fill in the environment variables required by the services you intend to use.

## Start the Development Server

```bash
npm run dev
```

For the complete development environment, database workflow, code-quality requirements, and contribution guidelines, see:

[`CONTRIBUTING.md`](./CONTRIBUTING.md)

---

# Repository Structure

```text
Wrong-Question-Notebook/
├── web/
│   ├── app/
│   │   ├── [locale]/          # Web application pages
│   │   └── api/               # Web / AI / Device API
│   │
│   ├── components/            # UI and business components
│   ├── contracts/
│   │   ├── device-control-v3/
│   │   ├── note-study-v1/
│   │   └── word-study-v1/
│   │
│   ├── lib/                   # Core logic
│   ├── messages/              # i18n
│   ├── public/                # Static assets
│   ├── server/                # Server-side components
│   └── supabase/              # Database and migrations
│
├── deploy/                    # Deployment resources
├── CHANGELOG.md
├── CONTRIBUTING.md
└── LICENSE
```

The README is responsible only for introducing WQN as a system.

More specific implementation details, protocol definitions, and engineering constraints should live near the corresponding source code, Contracts, and dedicated documentation.

---

# Project Status

WQN's core learning subsystems — Mark registry, Skill retrieval, Objective Marking, FSRS review scheduling, annotation lifecycle, Device Control v3, and the WQN Note4 firmware — are all implemented and connected.

Active development continues in:

* FSRS parameter optimization and per-subject calibration
* NVIDIA embedding profile (2048-dim) as an alternative to Qwen
* Note Study reading loop and retention scheduling
* Word Study full lifecycle completion
* Additional MCP tools for cross-domain workflows
* Insights depth (causal attribution, learning-state trajectories)

The data model continues to evolve as real learning workflows validate design decisions. The Device API will continue to be versioned. Some modules remain experimental.

For important implementation changes, see:

[`CHANGELOG.md`](./CHANGELOG.md)

---

# Contributing

Contributions are welcome in areas such as:

* Bug fixes
* Performance improvements
* Documentation
* MCP
* Device
* Data synchronization
* Learning algorithms
* Problem processing
* UI / UX
* Clear and verifiable new features

Before getting started, please read:

[`CONTRIBUTING.md`](./CONTRIBUTING.md)

For larger changes involving any of the following core structures:

* Problem Model
* Attempt
* Mark
* Insights
* Review Scheduling
* MCP
* Device Protocol

it is recommended to discuss the data model and behavioral boundaries before moving into implementation.

---

# Upstream Project & Acknowledgements

WQN originated from:

[`mrmagic2020/Wrong-Question-Notebook`](https://github.com/mrmagic2020/Wrong-Question-Notebook)

The original project established WQN's earliest Web application, Notebook, Problem management, Problem Set, and review foundations.

The current project continues to build on that foundation and has gradually expanded into:

* GaoKao-compatible Problem model
* MCP
* AI Agent integration
* Attempt and learning evidence
* Insights
* Word Study
* Physical learning devices
* Device API
* Offline learning
* Voice AI
* Long-term learning data infrastructure

Thanks to the original project and all contributors for establishing the foundation.

---

# License

This project is released under the **GNU General Public License v3.0**.

See:

[`LICENSE`](./LICENSE)

---

<p align="center">
  <strong>A wrong question is not the end of the learning process.</strong><br />
  <strong>It is evidence for the next learning decision.</strong>
</p>
