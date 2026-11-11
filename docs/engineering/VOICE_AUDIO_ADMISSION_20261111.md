# 音频入口边界与 60 秒开发线回移（2026-11-11）

## 已确认的问题

云端开发 `296de1b` 的音频契约和 relay PCM 上限仍为 20 秒；验证 `6380aa9` 已有
`dbf7aef` 的 60 秒支持。仅检查 route 源文件相同会遗漏它们引用的不同常量。
这批按当前调用链回移该提交的两个常量及其 HTTP/relay 测试，不回移 OAuth 等其他功能。

`/api/esp32/agent/transcribe` 在选择流式分支后，由 handler 直接
`req.arrayBuffer()`，绕过普通分支的实际音频最小/最大长度检查。
省略或低报 Content-Length 的超大 body、空 body 和短 body 都可以进入 ASR。
STD 的 v1/v2 路径虽有读后大小检查，仍先完整物化 body 才拒绝超限请求。
这些是本地实际 route / Request 的复现，不代表生产网关一定允许同样的 HTTP 报文。

旧实现运行针对性测试时 8 项失败：流式长度/停止读取 5 项，60 秒 HTTP/relay 3 项。
本轮证据保存在工作区 `doc/voice-audio-admission-20261111/`。
它们不能解释 11 月 10 日那次 4785 ms 首轮空转写；该问题的根因仍未确认。

## 修正

- 开发线与验证线统一为 60000 ms；PCM16 单声道 16 kHz 的 body 上限继续包含
  4096 字节容差，共 1924096 字节。
- 所有外部 Agent 转写和 STD 转写/对话的普通、流式路径使用同一逐块计数 reader。
  超限块在拼入内部缓冲前被拒绝，不依赖 Content-Length，内部缓冲容量最多为协议上限。
- 超限立即发起源取消并返回 413；源取消 Promise 不结束也不阻塞返回。
  请求取消或读取失败释放 reader，不把部分 PCM 送入提供商，返回 `invalid_audio` / 400。
  本批没有新增上传时间限制；慢上传仍依赖请求取消及现有基础设施策略。
- Agent 两种协议在分流前统一执行最小长度检查，短 body 返回 422。
  流式 handler 只接收路由已经读取、校验过的缓冲，避免重复读 body。
- 鉴权、速率限制和请求头快拒绝仍在读取前执行；成功事件、提供商选型、已有语音取消/
  deadline/fallback、学习写入和确认文本入口保持原行为。

测试新增长度拒绝后，未消费的模拟 fetch 响应会遗留给后续测试；已显式重置该测试文件的
fetch mock，避免错误地把测试隔离失败当作生产行为回归。

## 验证与交付边界

受影响测试包括实际 Agent/STD HTTP 路由、relay 60 秒边界、字节视图偏移与缓冲增长、
超限后不读后续块、源取消永不结束、上传取消/读失败、原有 ASR 诊断及语音生命周期。
最终通过数量、反向检查、TypeScript 和提交钩子结果以本轮收据为准。

```sh
cd web
npm run test -- lib/__tests__/agent-transcribe-streaming.test.ts lib/__tests__/batch-voice-relay.test.ts lib/__tests__/esp32-ai-audio-body.test.ts lib/__tests__/esp32-ai-transcribe-chat.test.ts lib/__tests__/voice-operation.test.ts lib/__tests__/voice-v2-cancellation.test.ts lib/__tests__/stepfun-asr.test.ts lib/__tests__/std-ai-pipeline.test.ts
npm run type-check
cd ..
sh -e web/.husky/pre-commit
```

使用合成音频和模拟提供商，不调用真实模型。没有部署、刷机、远端 CI 或设备验收，
也不改变已固定的 `val-20261109.4` 固件包。
本地 60 秒接收成功不证明真实模型识别质量或设备音频连续性。
