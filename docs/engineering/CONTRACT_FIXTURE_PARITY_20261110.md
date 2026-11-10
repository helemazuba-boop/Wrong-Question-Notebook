# 契约 fixture 双向覆盖（2026-11-10）

补齐两仓独有的 19 个 JSON 样例：固件接收 10 个 Note 样例，云端接收 7 个 v3 错误样例与
2 个 Agent stream 样例。合入后两仓完整 contracts JSON 清单共 153 项，路径及字节一致。
不修改 schema、schema hash、生产编解码器、持久化或线上服务策略。

## 实际消费者与边界

- 固件 `test_note_contract_fixtures.py` 分类全部 11 个 Note fixture：请求按对应 request
  definition 校验，响应按对应 Data definition 校验；Note schema 本身只声明 definitions，
  不把无约束的 schema root 校验当作覆盖。完整 envelope 另由真实 C++ parser 与云端 Zod 验证。
- 实际 Note C++ 构建器/解析器加 ESP-IDF cJSON 完成 77 项。4 个构建结果继续做 Schema 校验，
  除生产声明的 capability 超集外，所有字段与 canonical request 相同。没有把输入 fixture
  直接回显当作生产输出。现用固件没有 legacy skip request builder；该样例只声明 Schema/云端覆盖。
- `mastery-projection.json` 被 Schema/云端 Zod 拒绝；当前 C++ parser 接受其已知阅读字段、
  忽略额外 status。测试明确保留这个观察，不声称三者完全等价，也不把它计作新运行时缺陷。
- 两个 Agent 流以原始 JSON 文件重放到完整生产 client/SSE/typed dispatch：缺失 data 的
  accepted/attached 不补成 {} 后再测试；轮次空 text/reasoning marker 也必须保留。
  完整 Agent client 回归共 263 项，含原有头读取/无进展/取消/资源清理路径。
- 云端 production v3 Zod validator 消费所有 8 个 error fixture，并断言 inventory；Agent
  AJV contract 消费新增 stream，额外验证 idle terminator 最后出现。既有 Note Zod fixture
  回归一同执行，3 个文件共 90 项、零失败。它们不代表模型、设备或真实后端验收。

新语义负对照：Note 不安全计数/丢失 items/忽略 request correlation 分别完成 77/75/77 项，
失败 2/1/5 项；Agent 丢空确认/空轮次 marker 完成 259/255 项，失败 6/7 项。原 Agent 头等待
和 wire budget 变异仍各有 4 项失败。只在完成测试、实际退出 1、且无编译/运行器/sanitizer
故障时接受负对照；本批 9/9 受影响门禁通过。

完整清单开发 227、验证 218 项，本批不以受影响门禁冒充完整执行。SDK/M8/profile17/UI 栈、
云端 type-check/仓库提交钩子及精确提交身份随本批证据记录；远端 CI 与物理验收仍待做。
固定设备候选仍为 val-20261109.4 / Git 7e0433ca；本批只改 fixture/测试/文档，不覆盖该包，
也不把滚动分支的新 SHA 冒充镜像内 Git。发布前仍需对应完整门禁与真实设备验收。
