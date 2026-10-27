const $ = (id) => document.getElementById(id);
const token = document.querySelector("meta[name=wqn-token]").content;
const state = {
  ref: "HEAD",
  git: null,
  cloud: null,
  history: [],
  decisions: {},
  prs: [],
  plan: null,
  logs: "",
  busy: false,
  host: "aliyun",
};
const titles = {
  overview: [
    "这次发布，带上了什么？",
    "把准备发布的代码，与云端真正运行的版本放在一起。",
  ],
  branches: [
    "核对本次发布差异",
    "按候选提交检查内容，保留补丁来源与本次暂缓原因。",
  ],
  history: [
    "每次上线，都有来路",
    "云端保存镜像关联、配置快照、执行结果与回退记录。",
  ],
  images: [
    "把镜像与代码对上",
    "通过云端发布记录关联版本，按需核验 ACR 中的镜像内容。",
  ],
  env: ["配置也有自己的版本", "更新运行环境前，先确认目标程序支持这些变量。"],
  logs: ["沿着时间，找到问题", "通过 SSH 拉取日志，并与部署和配置变更对照。"],
};
const kinds = {
  deploy: "发布镜像",
  env: "更新环境",
  rollback: "恢复部署",
  build: "构建与推送",
  baseline: "现场基线",
};
const statuses = {
  planned: "等待执行",
  no_changes: "无需更新",
  queued: "已排队",
  running: "执行中",
  building: "构建中",
  pushed: "已推送",
  verified: "验证通过",
  failed: "失败",
  rolled_back: "失败后已恢复",
  needs_attention: "恢复待处理",
  unknown: "待核实",
  completed: "任务结束",
};
function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}
function date(value, full = false) {
  if (!value) return "时间未知";
  const d = new Date(value);
  if (!Number.isFinite(d.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    ...(full ? { year: "numeric" } : {}),
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(d);
}
function short(value, n = 12) {
  return value ? value.replace(/^sha256:/, "").slice(0, n) : "未记录";
}
function badge(status) {
  return el(
    "span",
    "badge " +
      (status === "verified" || status === true
        ? "good"
        : ["failed", "needs_attention"].includes(status)
          ? "bad"
          : "warn"),
    status === true ? "运行中" : statuses[status] || status,
  );
}
function notice(message, error = false) {
  $("notice").hidden = !message;
  $("notice").className = error ? "error" : "";
  $("notice").textContent = message || "";
  if ($("plan-dialog").open) {
    $("plan-error").hidden = !error || !message;
    $("plan-error").textContent = message || "";
  }
}
async function api(path, body) {
  const options = { headers: { "X-WQN-Token": token } };
  if (body !== undefined) {
    options.method = "POST";
    options.headers["Content-Type"] = "application/json";
    options.body = JSON.stringify(body);
  }
  const response = await fetch(path, options);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "请求失败");
  return data;
}
async function action(button, task) {
  const original = button.textContent;
  button.disabled = true;
  try {
    notice("");
    return await task();
  } catch (error) {
    notice(error.message, true);
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
}
function view(name) {
  document
    .querySelectorAll(".view")
    .forEach((n) => n.classList.toggle("active", n.id === "view-" + name));
  document.querySelectorAll(".nav").forEach((n) => {
    n.classList.toggle("active", n.dataset.view === name);
    if (n.dataset.view === name) n.setAttribute("aria-current", "page");
    else n.removeAttribute("aria-current");
  });
  $("page-title").textContent = titles[name][0];
  $("page-description").textContent = titles[name][1];
}
function commitRow(c, branch = state.ref) {
  const li = el("li");
  const button = el("button", "commit-button");
  const head = el("div", "commit-head");
  head.append(
    el("code", "", c.sha.slice(0, 8)),
    el("span", "", date(c.commit_time)),
  );
  const title = el("div", "commit-title", c.subject);
  if (c.parents?.length > 1) title.append(el("span", "merge-tag", "合并"));
  button.append(head, title);
  button.addEventListener("click", () => showCommit(c.sha, branch));
  li.append(button);
  return li;
}
async function showCommit(sha, ref) {
  try {
    const data = await api(
      "/api/context?sha=" +
        encodeURIComponent(sha) +
        "&ref=" +
        encodeURIComponent(ref),
    );
    $("detail-title").textContent = "提交与附近的工作";
    $("detail-body").replaceChildren();
    const list = el("ol", "timeline");
    data.before.forEach((c) => list.append(commitRow(c, ref)));
    const target = el("div", "target-commit");
    target.append(el("strong", "", data.target.subject));
    target.append(
      el("p", "", "SHA：" + data.target.sha),
      el("p", "", "作者时间：" + date(data.target.author_time, true)),
      el("p", "", "提交时间：" + date(data.target.commit_time, true)),
    );
    $("detail-body").append(list, target);
    const after = el("ol", "timeline");
    data.after.forEach((c) => after.append(commitRow(c, ref)));
    $("detail-body").append(after);
    if (data.target.parents.length > 1) {
      $("detail-body").append(el("p", "subtle", "合并的父提交："));
      data.target.parents.forEach((parent) => {
        const b = el("button", "button quiet", parent.slice(0, 12));
        b.addEventListener("click", () => showCommit(parent, ref));
        $("detail-body").append(b);
      });
    }
    if (!$("detail-dialog").open) $("detail-dialog").showModal();
  } catch (error) {
    notice(error.message, true);
  }
}
function reviewCommit(c, ref) {
  const li = commitRow(c, c.variants?.find((v) => v.sha === c.sha)?.ref || ref);
  const labels = {
    unmatched: "内容尚未匹配",
    postimages_match: "所涉文件内容一致",
    reverse_patch_matches: "反向补丁检查通过",
  };
  li.append(
    el(
      "p",
      "commit-evidence",
      (c.category === "runtime" ? "程序内容 · 候选：" : "候选：") +
        labels[c.coverage] +
        (c.release_coverage
          ? " · 发布基线：" + labels[c.release_coverage]
          : ""),
    ),
  );
  if (c.workspace_paths?.length)
    li.append(
      el(
        "p",
        "commit-evidence",
        "当前工作区有 " +
          c.workspace_paths.length +
          " 个相关未提交文件；不会进入此候选的构建。",
      ),
    );
  const evidence = el("details", "commit-files");
  evidence.append(
    el("summary", "", c.paths.length + " 个涉及文件 · 查看补丁来源"),
  );
  const paths = el("ul");
  c.paths.forEach((p) => paths.append(el("li", "", p)));
  evidence.append(paths);
  (c.variants || []).forEach((v) => {
    const button = el(
      "button",
      "button quiet provenance",
      short(v.sha) + " · " + v.branch,
    );
    button.addEventListener("click", () => showCommit(v.sha, v.ref));
    evidence.append(button);
  });
  li.append(evidence);
  return li;
}
function reviewCard(o, review, open = false) {
  const card = el("details", "omission");
  card.open = open;
  const summary = el("summary");
  const decision = state.decisions[o.fingerprint];
  summary.append(
    el("strong", "", o.branch),
    badge(
      review
        ? decision
          ? "已暂缓"
          : o.missing_count + " 个程序补丁待核对"
        : "参考",
    ),
  );
  const body = el("div", "omission-body");
  const meta = el("div", "omission-meta");
  meta.append(
    el("span", "", "最近提交 " + date(o.commit_time, true)),
    el("code", "", short(o.sha)),
  );
  if (o.equivalent_count)
    meta.append(el("span", "", o.equivalent_count + " 项等价提交已排除"));
  body.append(meta);
  if (o.reason) body.append(el("p", "subtle", o.reason));
  if (o.aliases?.length > 1)
    body.append(
      el("p", "subtle provenance", "补丁来源：" + o.aliases.join("、")),
    );
  (o.tips || []).forEach((tip) =>
    body.append(
      el(
        "p",
        "subtle provenance",
        tip.name +
          " @ " +
          short(tip.sha) +
          " · " +
          date(tip.commit_time) +
          (tip.candidate_relation === "ancestor"
            ? " · 已在候选历史中"
            : tip.candidate_relation === "equivalent"
              ? " · 等价提交已匹配"
              : ""),
      ),
    ),
  );
  state.prs
    .filter((p) =>
      o.aliases?.some(
        (a) => a === p.headRefName || a === "origin/" + p.headRefName,
      ),
    )
    .forEach((p) => {
      const note = el("p", "pr-note");
      const a = el(
        "a",
        "",
        "PR #" +
          p.number +
          " · " +
          (p.state === "MERGED" ? "已合并 " + date(p.mergedAt) : p.state),
      );
      a.href = p.url;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      note.append(a);
      if (p.state === "MERGED") {
        note.append(
          document.createTextNode(
            "；合并时分支头 " + short(p.headRefOid) + "。",
          ),
        );
        const followups = (p.ref_checks || []).filter(
          (c) =>
            c.relationship === "followup" &&
            o.tips?.some((t) => t.ref === c.ref),
        );
        followups.forEach((c) =>
          note.append(
            document.createTextNode(
              " " +
                c.ref.replace(/^refs\/(heads|remotes)\//, "") +
                " 在该头之后有 " +
                c.followup_count +
                " 个非合并提交。",
            ),
          ),
        );
        note.append(document.createTextNode(" PR 状态不代替候选内容核对。"));
      }
      body.append(note);
    });
  const list = el("ol", "timeline");
  [...(o.missing || [])]
    .reverse()
    .forEach((c) => list.append(reviewCommit(c, o.ref)));
  body.append(list);
  if (o.merge_commits?.length) {
    const merges = el("details", "related-changes");
    merges.append(
      el(
        "summary",
        "",
        o.merge_commits.length + " 个合并提交 · 冲突解决内容需人工核对",
      ),
    );
    const items = el("ol", "timeline");
    o.merge_commits.forEach((c) => items.append(commitRow(c, o.ref)));
    merges.append(items);
    body.append(merges);
  }
  if (review && o.related?.length) {
    const related = el("details", "related-changes");
    related.append(
      el(
        "summary",
        "",
        o.related.length + " 个工具、配置或已匹配补丁 · 不计入程序改动核对",
      ),
    );
    const items = el("ol", "timeline");
    [...o.related]
      .reverse()
      .forEach((c) => items.append(reviewCommit(c, o.ref)));
    related.append(items);
    body.append(related);
  }
  if (decision) {
    const history = decision.reason_history || [decision];
    const seen = new Set();
    history.forEach((d) => {
      const key = JSON.stringify([d.reason, d.time, d.branch]);
      if (!seen.has(key))
        body.append(
          el(
            "p",
            "subtle",
            "暂缓原因：" +
              d.reason +
              (d.time ? " · " + date(d.time) : "") +
              (d.branch ? " · " + d.branch : ""),
          ),
        );
      seen.add(key);
    });
  }
  if (review) {
    const row = el("div", "defer-row");
    const input = el("input");
    input.placeholder = "本次暂缓原因";
    input.setAttribute("aria-label", o.branch + " 的暂缓原因");
    const button = el(
      "button",
      "button quiet",
      decision ? "更新暂缓原因" : "记录暂缓",
    );
    button.addEventListener("click", () =>
      action(button, async () => {
        if (!input.value.trim()) throw new Error("请填写暂缓原因");
        state.decisions = await api("/api/defer", {
          ref: state.ref,
          fingerprint: o.fingerprint,
          reason: input.value.trim(),
        });
        renderGit();
        notice("已在云端保存暂缓原因；同一程序补丁的不同提交共用核对记录。");
      }),
    );
    row.append(input, button);
    body.append(row);
  }
  card.append(summary, body);
  return card;
}
function renderGit() {
  const data = state.git;
  if (!data) return;
  $("candidate-sha").textContent = short(data.candidate.sha);
  $("candidate-time").textContent = date(data.candidate.commit_time);
  $("candidate-subject").textContent = data.candidate.subject;
  $("candidate-commits").replaceChildren(
    ...data.commits.slice(0, 6).map((c) => commitRow(c)),
  );
  const selected = $("candidate-ref").value || state.ref;
  $("candidate-ref").replaceChildren(
    new Option(
      "当前分支 · " + (state.ref === "HEAD" ? data.candidate.branch : "HEAD"),
      "HEAD",
    ),
  );
  data.branches.forEach((b) =>
    $("candidate-ref").append(
      new Option(b.name + " · " + date(b.commit_time), b.ref),
    ),
  );
  $("candidate-ref").value = selected;
  if (!$("candidate-ref").value) $("candidate-ref").value = "HEAD";
  const active = data.omissions;
  const unresolved = active.filter((o) => !state.decisions[o.fingerprint]);
  $("omission-count").textContent = String(unresolved.length);
  $("review-title").textContent = unresolved.length
    ? unresolved.length + " 组程序改动需要核对候选内容"
    : "本次扫描没有新的待核对程序补丁";
  $("review-description").textContent =
    "已合并相同补丁的分支来源；" +
    active.filter((o) => state.decisions[o.fingerprint]).length +
    " 组已有暂缓原因。工具、配置和参考引用单独显示。";
  $("git-freshness").textContent =
    "扫描于 " +
    date(data.checked_at) +
    " · 远端引用更新于 " +
    date(data.remote_refs_updated_at);
  $("git-baselines").replaceChildren();
  [
    ["本次候选", data.candidate],
    ["远端发布基线（缓存）", data.release_baseline],
  ].forEach(([label, c]) => {
    const row = el("div");
    row.append(
      el("strong", "", label),
      el("p", "provenance", c ? c.branch : "未找到远端 Release 引用"),
    );
    if (c)
      row.append(
        el("code", "", short(c.sha)),
        el("span", "subtle", " · " + date(c.commit_time, true)),
      );
    $("git-baselines").append(row);
  });
  const dirty = data.worktrees.filter((w) => w.change_count);
  $("worktree-summary").textContent =
    data.worktrees.length +
    " 个工作区 · " +
    dirty.length +
    " 个有未提交改动 · " +
    data.stash_count +
    " 个 stash";
  $("worktrees").replaceChildren(
    ...dirty.slice(0, 8).map((w) => {
      const row = el("div", "worktree");
      const text = el("div");
      text.append(
        el("strong", "", w.branch || "游离提交"),
        el("small", "", w.path),
      );
      row.append(text, badge(w.change_count + " 项改动"));
      return row;
    }),
  );
  if (!dirty.length)
    $("worktrees").append(el("p", "subtle", "工作区均无未提交改动。"));
  $("omissions").replaceChildren();
  data.omissions.forEach((o, index) =>
    $("omissions").append(reviewCard(o, true, index < 2)),
  );
  if (!data.omissions.length)
    $("omissions").append(
      empty(
        "没有待核对的程序补丁",
        "这表示已扫描范围内未发现未匹配的程序改动；不代表已经发布或通过功能验收。",
      ),
    );
  $("reference-summary").textContent =
    "参考差异 · " + (data.references || []).length + " 组（不要求暂缓）";
  $("reference-list").replaceChildren(
    ...(data.references || []).map((o) => reviewCard(o, false)),
  );
  const visibleReasons = new Set(
    data.omissions.flatMap((o) => [
      o.fingerprint,
      ...(o.legacy_fingerprints || []),
    ]),
  );
  const previous = Object.entries(state.decisions).filter(
    ([key]) => !visibleReasons.has(key),
  );
  if (previous.length) {
    const archive = el("details", "omission");
    archive.append(
      el("summary", "", "此前记录的暂缓原因 · " + previous.length + " 项"),
    );
    const body = el("div", "omission-body");
    body.append(
      el(
        "p",
        "subtle",
        "扫描范围或候选内容变化后，原记录仍保留；以下原因不计入当前待核对项。",
      ),
    );
    previous.forEach(([, d]) =>
      body.append(
        el(
          "p",
          "provenance",
          (d.branch || "历史补丁") + " · " + date(d.time) + " · " + d.reason,
        ),
      ),
    );
    archive.append(body);
    $("reference-list").append(archive);
  }
  if (data.shallow || data.refs_checked < data.refs_total)
    notice("分支检查不完整；请补齐 Git 历史或检查扫描范围后发布。", true);
}
function empty(title, description) {
  const n = el("div", "empty");
  n.append(el("strong", "", title), el("p", "", description));
  return n;
}
function renderCloud() {
  const data = state.cloud;
  if (!data) return;
  $("cloud-services").replaceChildren();
  data.services.forEach((s) => {
    const section = el("div", "service");
    const head = el("div", "service-head");
    head.append(
      el("strong", "", s.service === "app" ? "App" : "Realtime"),
      badge(s.running ? true : "已停止"),
    );
    section.append(head);
    const dl = el("dl");
    const values = [
      ["镜像版本", s.image_ref],
      [
        "源码提交",
        s.image.revision
          ? short(s.image.revision)
          : s.image.revision_hint
            ? s.image.revision_hint + "（由 tag 推断）"
            : "历史镜像未标记",
      ],
      ["镜像内容", short(s.image.image_id, 16)],
      ["启动时间", date(s.started_at, true)],
      ["健康状态", s.health || "无 Docker 健康检查"],
      [
        "执行适配",
        s.adapter?.supported === false
          ? "当前拓扑需要适配"
          : "现有服务参数可处理",
      ],
      [
        "记录对照",
        {
          matches: "与上次记录一致",
          changed: "现网已变化，请重新核对",
          untracked: "尚未建立云端基线",
          unverified: "历史快照未核实",
        }[s.drift?.status] || "等待核验",
      ],
      [
        "运行环境",
        s.env_keys.length + " 个变量 · 重启 " + s.restart_count + " 次",
      ],
    ];
    values.forEach(([label, value]) =>
      dl.append(el("dt", "", label), el("dd", "", value)),
    );
    section.append(dl);
    $("cloud-services").append(section);
  });
  if (!data.services.length)
    $("cloud-services").append(
      empty("未找到受管容器", "请核对 SSH 目标和服务名称。"),
    );
  $("cloud-updated").textContent =
    "核验于 " + date(data.checked_at, true) + " · SSH 读取";
  $("connection").textContent = state.host + " 已连接";
  $("connection").className = "connection connected";
}
async function refreshCloud() {
  try {
    state.cloud = await api("/api/cloud");
    renderCloud();
  } catch (error) {
    $("connection").textContent = "连接未核实";
    $("connection").className = "connection error";
    $("cloud-services").replaceChildren(
      empty("暂时无法读取云端", error.message),
    );
    throw error;
  }
}
async function refreshHistory() {
  const data = await api("/api/history");
  state.history = data.operations;
  $("history").replaceChildren();
  data.operations.forEach((o) => {
    const row = el("div", "history-row");
    row.append(el("div", "history-date", date(o.created_at, true)));
    const info = el("div");
    const title = el("div", "history-title", kinds[o.kind] || o.kind);
    title.append(badge(o.status));
    info.append(
      title,
      el(
        "p",
        "history-meta",
        o.services.join("、") +
          " · " +
          (o.source.branch || "未记录来源") +
          " @ " +
          short(o.source.sha),
      ),
      el(
        "p",
        "history-meta",
        "操作 " +
          short(o.id) +
          " · " +
          Object.values(o.images)
            .map((i) => i.ref || short(i.image_id))
            .join(" / "),
      ),
    );
    const actions = el("div", "history-actions");
    const detail = el("button", "text-button", "执行详情");
    detail.addEventListener("click", () => showOperation(o.id));
    actions.append(detail);
    if (o.status === "verified") {
      const restore = el("button", "text-button", "恢复到此状态");
      restore.addEventListener("click", () =>
        action(restore, async () =>
          showPlan(
            await api("/api/plan/rollback", {
              target_id: o.id,
              services: o.services,
            }),
          ),
        ),
      );
      actions.append(restore);
    }
    row.append(info, actions);
    $("history").append(row);
  });
  if (!data.operations.length)
    $("history").append(
      empty(
        "还没有云端操作记录",
        "今后的发布与环境更新会自动留档。已有镜像和容器不会被推断为完整部署历史。",
      ),
    );
  renderImages();
}
function renderImages() {
  const seen = new Set();
  $("images").replaceChildren();
  state.history.forEach((o) =>
    Object.entries(o.images).forEach(([service, image]) => {
      const identity = image.digest || image.image_id || image.ref;
      if (!identity || seen.has(identity)) return;
      seen.add(identity);
      const row = el("div", "history-row");
      row.append(
        el("div", "history-date", "记录于 " + date(o.created_at, true)),
      );
      const info = el("div");
      const title = el(
        "div",
        "history-title",
        service === "app" ? "App 镜像" : "Realtime 镜像",
      );
      if (
        state.cloud?.services.some((s) => s.image.image_id === image.image_id)
      )
        title.append(badge("现网使用"));
      info.append(
        title,
        el("p", "history-meta", image.ref || "历史版本未记录引用"),
        el(
          "p",
          "history-meta",
          image.digest || image.digests?.[0] || "digest 尚未记录",
        ),
        el(
          "p",
          "history-meta",
          "来源：" + (o.source.branch || "未知") + " @ " + short(o.source.sha),
        ),
      );
      const probe = el("button", "text-button", "核验 ACR");
      probe.addEventListener("click", () =>
        action(probe, async () => {
          const result = await api("/api/image/probe", { id: o.id, service });
          notice(
            result.available
              ? result.matches === false
                ? "镜像内容与记录不符，需先处理版本引用。"
                : "ACR 镜像可读取，核验于 " +
                  date(result.checked_at) +
                  (result.matches === null
                    ? "；历史记录缺少 digest 对照。"
                    : "，内容与记录一致。")
              : "ACR 可用性未核实，请检查云端仓库登录和网络。",
            !result.available || result.matches === false,
          );
        }),
      );
      row.append(info, probe);
      $("images").append(row);
    }),
  );
  if (!seen.size)
    $("images").append(
      empty(
        "还没有关联的镜像",
        "保存当前基线或完成一次发布后，这里会列出对应版本。",
      ),
    );
}
async function showOperation(id) {
  try {
    const o = await api("/api/operation?id=" + encodeURIComponent(id));
    $("detail-title").textContent =
      (kinds[o.kind] || o.kind) + " · " + (statuses[o.status] || o.status);
    $("detail-body").replaceChildren(el("p", "", "操作 ID：" + o.id));
    o.events.forEach((e) =>
      $("detail-body").append(
        el(
          "p",
          "",
          date(e.time) +
            "  " +
            e.step +
            "  " +
            e.status +
            (e.detail ? "\n" + e.detail : ""),
        ),
      ),
    );
    if (o.error) $("detail-body").append(el("p", "pr-note", o.error));
    if (o.log) $("detail-body").append(el("pre", "", o.log));
    if (!$("detail-dialog").open) $("detail-dialog").showModal();
  } catch (error) {
    notice(error.message, true);
  }
}
function showPlan(plan) {
  $("plan-error").hidden = true;
  state.plan = plan;
  $("plan-title").textContent =
    plan.kind === "release"
      ? "发布所选提交"
      : plan.kind === "env"
        ? "更新 App 环境变量"
        : "恢复到历史部署";
  $("plan-summary").replaceChildren(
    el("p", "", "计划 ID：" + plan.id),
    el("p", "", "服务：" + plan.services.join("、")),
  );
  if (plan.source?.sha)
    $("plan-summary").append(
      el(
        "p",
        "",
        "配置 / 源码来源：" +
          (plan.source.branch || "") +
          " @ " +
          short(plan.source.sha),
      ),
    );
  if (plan.kind === "release" && plan.source.untracked_count)
    $("plan-summary").append(
      el(
        "p",
        "",
        "各工作区共有 " +
          plan.source.untracked_count +
          " 项未提交改动。本次固定构建所选 SHA，不会包含未提交文件。",
      ),
    );
  if (plan.policy_revision)
    $("plan-summary").append(
      el(
        "p",
        "",
        "运行版本配置规则：" +
          short(plan.policy_revision) +
          (plan.policy_evidence === "image_tag_inference"
            ? "（由历史 tag 推断）"
            : ""),
      ),
    );
  if (plan.no_deploy)
    $("plan-summary").append(
      el("p", "", "本次仅构建并推送到 ACR，不更新运行容器。"),
    );
  if (plan.kind === "env")
    $("plan-summary").append(
      el("p", "", "使用当前镜像重建 App。构建时配置需要重新发布镜像。"),
    );
  if (plan.kind === "rollback")
    $("plan-summary").append(
      el(
        "p",
        "",
        "恢复目标：" + short(plan.target_id) + "。数据库不会自动降级。",
      ),
    );
  $("plan-changes").replaceChildren();
  (plan.changes || []).forEach((c) => {
    const row = el("div", "change");
    row.append(
      el("span", "", { add: "新增", change: "修改", remove: "移除" }[c.change]),
      el("code", "", c.key),
      el("span", "subtle", c.service),
    );
    $("plan-changes").append(row);
  });
  if (!(plan.changes || []).length && plan.kind !== "release")
    $("plan-changes").append(
      el("p", "subtle", "没有变量差异；镜像或运行参数仍需核对。"),
    );
  $("defer-field").hidden = plan.kind !== "release" || !plan.omissions?.length;
  $("defer-reason").value = "";
  $("compatibility-field").hidden = plan.kind !== "rollback";
  $("compatibility-reviewed").checked = false;
  $("apply-plan").textContent =
    plan.kind === "release"
      ? "开始构建与发布"
      : plan.kind === "env"
        ? "更新并核验"
        : "执行恢复";
  $("apply-plan").disabled = plan.status === "no_changes";
  if (plan.status === "no_changes") $("apply-plan").textContent = "无需更新";
  if (!$("plan-dialog").open) $("plan-dialog").showModal();
}
async function trackJob(job) {
  $("job-panel").hidden = false;
  $("job-id").textContent = "本地任务：" + job.id;
  for (;;) {
    const data = await api("/api/job?id=" + encodeURIComponent(job.id));
    $("job-status").textContent =
      statuses[data.progress] || statuses[data.status] || data.status;
    $("job-id").textContent =
      "任务：" +
      job.id +
      (data.operation_id ? " · 云端操作：" + data.operation_id : "");
    const output = [...data.lines];
    if (data.result?.events)
      output.push(
        ...data.result.events.map(
          (e) => date(e.time) + "  " + e.step + "  " + e.status,
        ),
      );
    if (data.error) output.push(data.error);
    if (data.result?.error) output.push(data.result.error);
    $("job-output").textContent = output.join("\n") || "等待云端执行结果…";
    if (["completed", "failed"].includes(data.status)) {
      const result = data.result;
      const ok = result && ["verified", "pushed"].includes(result.status);
      $("job-status").textContent = ok
        ? statuses[result.status]
        : data.error || statuses[result?.status] || "待核实";
      notice(
        ok
          ? "操作已完成并取得结果。"
          : "操作未验证成功，请查看云端记录和当前服务状态。",
        !ok,
      );
      await Promise.allSettled([refreshCloud(), refreshHistory()]);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
}
function filterLogs() {
  const key = $("log-search").value.toLowerCase();
  $("log-output").textContent =
    state.logs
      .split("\n")
      .filter((line) => !key || line.toLowerCase().includes(key))
      .join("\n") || "没有匹配的日志。";
}
async function readLogs() {
  const source = $("log-source").value;
  const data = await api(
    "/api/logs?source=" +
      encodeURIComponent(source) +
      "&since=" +
      encodeURIComponent($("log-since").value),
  );
  state.logs = data.text;
  filterLogs();
  $("log-info").textContent =
    "采集于 " +
    date(data.checked_at, true) +
    " · " +
    source +
    (source.startsWith("nginx") || source === "docker-daemon"
      ? " · 系统日志展示最近 300 行"
      : " · 最近 300 行");
}
document
  .querySelectorAll(".nav")
  .forEach((n) => n.addEventListener("click", () => view(n.dataset.view)));
$("candidate-ref").addEventListener("change", () =>
  action($("candidate-ref"), async () => {
    state.ref = $("candidate-ref").value;
    state.prs = [];
    state.decisions = {};
    state.git = await api("/api/git?ref=" + encodeURIComponent(state.ref));
    renderGit();
    state.decisions = await api(
      "/api/decisions?ref=" + encodeURIComponent(state.ref),
    );
    renderGit();
  }),
);
$("open-branches").addEventListener("click", () => view("branches"));
$("refresh-cloud").addEventListener("click", () =>
  action($("refresh-cloud"), refreshCloud),
);
$("refresh-history").addEventListener("click", () =>
  action($("refresh-history"), refreshHistory),
);
$("refresh-images").addEventListener("click", () =>
  action($("refresh-images"), refreshHistory),
);
$("capture-baseline").addEventListener("click", () =>
  action($("capture-baseline"), async () => {
    await api("/api/capture", {});
    await refreshHistory();
    notice("已保存云端现场基线；采集时间不会被标记为历史部署时间。");
  }),
);
$("refresh-all").addEventListener("click", () =>
  action($("refresh-all"), async () => {
    state.git = await api("/api/git?ref=" + encodeURIComponent(state.ref));
    renderGit();
    const results = await Promise.allSettled([
      refreshCloud(),
      refreshHistory(),
      api("/api/decisions?ref=" + encodeURIComponent(state.ref)).then((d) => {
        state.decisions = d;
        renderGit();
      }),
    ]);
    const error = results.find((r) => r.status === "rejected");
    if (error) throw error.reason;
  }),
);
$("fetch-refs").addEventListener("click", () =>
  action($("fetch-refs"), async () => {
    state.git = await api("/api/refresh-git", { ref: state.ref });
    renderGit();
  }),
);
$("refresh-prs").addEventListener("click", () =>
  action($("refresh-prs"), async () => {
    const data = await api("/api/prs?ref=" + encodeURIComponent(state.ref));
    state.prs = data.pull_requests;
    renderGit();
    notice(
      "PR 状态来自 " + data.repository + " · 核对于 " + date(data.checked_at),
    );
  }),
);
$("release-plan").addEventListener("click", () =>
  action($("release-plan"), async () =>
    showPlan(
      await api("/api/plan/release", {
        ref: state.ref,
        skip_realtime: $("skip-realtime").checked,
        no_deploy: $("no-deploy").checked,
      }),
    ),
  ),
);
$("env-plan").addEventListener("click", () =>
  action($("env-plan"), async () => {
    const plan = await api("/api/plan/env", { ref: state.ref });
    $("env-preview").replaceChildren(
      el("strong", "", plan.changes.length + " 项配置差异"),
      el("p", "subtle", "仅显示变量名与变化类型；执行后核验实际容器环境。"),
    );
    showPlan(plan);
  }),
);
$("cancel-plan").addEventListener("click", () => $("plan-dialog").close());
$("apply-plan").addEventListener("click", () =>
  action($("apply-plan"), async () => {
    if (state.busy) throw new Error("已有操作正在执行，请先查询其结果");
    if (state.plan.kind === "rollback" && !$("compatibility-reviewed").checked)
      throw new Error("请先核对数据库与共享配置兼容性");
    if (
      state.plan.kind === "release" &&
      state.plan.omissions?.length &&
      !$("defer-reason").value.trim()
    )
      throw new Error("请填写本次暂缓其他分支的原因，或返回逐项核对");
    const job = await api("/api/apply", {
      id: state.plan.id,
      defer_reason: $("defer-reason").value.trim() || null,
      compatibility_reviewed: $("compatibility-reviewed").checked,
    });
    $("plan-dialog").close();
    state.busy = true;
    try {
      await trackJob(job);
    } finally {
      state.busy = false;
    }
  }),
);
$("read-logs").addEventListener("click", () =>
  action($("read-logs"), readLogs),
);
$("log-search").addEventListener("input", filterLogs);
$("download-logs").addEventListener("click", () => {
  const url = URL.createObjectURL(
    new Blob([$("log-output").textContent], {
      type: "text/plain;charset=utf-8",
    }),
  );
  const a = el("a");
  a.href = url;
  a.download = "wqn-" + $("log-source").value + "-logs.txt";
  a.click();
  URL.revokeObjectURL(url);
});
$("close-job").addEventListener("click", () => {
  $("job-panel").hidden = true;
});
setInterval(() => {
  if ($("follow-logs").checked && !$("read-logs").disabled)
    action($("read-logs"), readLogs);
}, 5000);
(async () => {
  try {
    const config = await api("/api/config");
    state.host = config.host;
    $("repo-label").textContent = config.repo;
    $("host-label").textContent = "SSH · " + config.host;
    state.git = await api("/api/git");
    renderGit();
  } catch (error) {
    notice(error.message, true);
  }
  const results = await Promise.allSettled([
    refreshCloud(),
    refreshHistory(),
    api("/api/decisions?ref=" + encodeURIComponent(state.ref)).then((d) => {
      state.decisions = d;
      renderGit();
    }),
  ]);
  const error = results.find((r) => r.status === "rejected");
  if (error) notice(error.reason.message, true);
})();
