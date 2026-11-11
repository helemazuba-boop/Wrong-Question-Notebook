# 首轮空转写：关联与字段诊断（2026-11-11）

## 现场证据与边界

`serial-COM7-261110-131159-325-28828.log` 中，请求
`77d7ecc1156db6f0` 使用新建 WS，出现 `delta=0 done=1(0chars)`，最终为
`ESP_ERR_INVALID_RESPONSE`；随后两个复用 WS 的请求成功。
三轮 codec 均为 warm/reused，日志没有覆盖睡眠进入或唤醒，也未记录音频队列溢出、
序列缺口或发送失败。首轮停止录音至转写返回为 749 ms。

旧的 `0chars` 无法区分 `done.text` 缺失、空字符串或错误类型。设备样本数与
FINAL 序号一致不等于服务端完整接收，也不能证明音频可辨识。
目前缺少同轮服务端 PCM 统计及精确 BIN/ELF 身份，睡眠、录音和提供商根因均未确认。
现场证据封存在 `doc/std-first-record-after-idle-20261110/`，本轮记录在工作区
`doc/asr-empty-diagnostics-20261111/`；这些本地证据不代表部署或实机验收。

## 改动

- ASR-only 路由将已有 `ready.turn_id` 传入实际 ASR 调用；通用语音流水线也传入自己的
  turn ID。既有提供商 `requestId` 保持原义，新增日志字段为 `voiceTurnId`。
- 仅记录 1–64 个 ASCII 字母、数字、下划线或连字符组成的关联 ID；其他值省略。
  该字段仅用于日志，不参与鉴权、重试、幂等或提供商请求体。
- 既有空转写错误日志新增 `textFields`，记录最近一次 delta/done 的字段形状及
  done 各形状计数，区分未观察、字段缺失、空字符串、字符串、null、数组、对象、
  数字和布尔值。新增字段不记录转写内容、音频内容或密钥。
- 原有 PCM 统计、提供商会话 ID、事件计数及错误分类继续保留。

这是一项诊断缺口修复。未改变提供商选择、ADC、音频重放、FINAL 重试或空结果的
`no_speech` / `asr_failed` 分类；已接收的学习事实不会因本改动重放。

## 本地验证

运行以下受影响测试，并执行 TypeScript、仓库 pre-commit（ESLint 与全量格式检查）：

```sh
cd web
npm run test -- lib/__tests__/stepfun-asr.test.ts lib/__tests__/agent-transcribe-streaming.test.ts lib/__tests__/std-ai-pipeline.test.ts lib/__tests__/voice-operation.test.ts
npm run type-check
cd ..
sh -e web/.husky/pre-commit
```

测试覆盖：实际 ASR-only HTTP 路由将设备 ID 送至空结果日志；提供商 ID 不串入设备事件；
空值/缺失/错误类型分辨；不合适的关联 ID 被省略；日志新增字段不泄露测试文本或密钥；
空 done 保留已有 delta；确认文本入口、成功、错误、取消、共享 deadline 和 fallback 行为。
使用合成 PCM 和模拟提供商，没有调用真实模型。最终结果及提交来源见本轮证据收据。

云端验证线从 `958dd09` 集成，保留已有 OAuth 提交 `9329181`、`5e123a1`、`958dd09`；
开发线来源为 `8b77c15`。本批不改变固件或既有实机包。

## 下一步所需证据

获得部署授权并部署后，用同一 `voiceTurnId` 对齐 relay 的 `server_final_received`
与 StepFun 空结果日志。首轮设备 76560 个单声道 PCM16 样本对应 153120 字节、4785 ms；
将实际服务端字节数、时长、RMS、DC、削波率和零样本率与设备日志比较。
需要覆盖可确认的睡眠/唤醒、首轮新 WS、随后复用 WS，并绑定设备实际镜像身份。
字节数一致仍不能单独证明音频可辨识。未获得这些证据前，不能宣称偶发问题已解决。
