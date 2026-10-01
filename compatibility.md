# 兼容性记录

- 作者：Codex
- 日期：2026-10-01
- 上游：Alex 指定仓库、spec.md §8
- 下游：src/output.ts、tests/compatibility.test.ts、README.md、review.md
- 接受历史：Alex 授权参考该仓库并尽量考虑兼容；本记录的实机结论尚未确认
- 参考代码 commit：`78672f68d2e96343c0875cd76dd4b7c442e31fd6`（Day Planner 0.35.1）
- 本项目版本：对应实现提交，见 Git 历史

| 对象 | 实现/依据 | 验证状态 |
| --- | --- | --- |
| Obsidian API | SDK 1.6.6；公开 Vault.read/process/create/createFolder；桌面端最低 1.6.6 | 最低 SDK 类型检查；另在最初的 1.13.1 SDK 上通过源码类型检查 |
| 插件构建 | CJS main.js；仅 external 引用 obsidian；不调用 Node 文件 API | 构建通过；模拟宿主加载测试另见验证记录 |
| Day Planner 每日笔记 | 原插件可从带日期的 Daily Note 中解析列表时间 | 已核查源码；本项目不写每日笔记 |
| Day Planner 任意文件 | 复选框 + HH:mm - HH:mm + [scheduled:: YYYY-MM-DD] | 格式读回、日期隔离、拖动及勾选测试；无实机互操作结论 |
| Tasks / Dataview | 源任务字段保持原样；输出 scheduled 仅为块日期 | 不调用私有 API；非 as 元数据不参与排程约束 |
| 日历事件 | 只读显式 Fixed.md | 不读取第三方事件；用户需明确录入 |
| Markdown | LF/CRLF、缩进和有序任务、围栏、唯一 ID | 自动测试 |
| 其他输出区域 | 管理区外内容逐字保留；非专用文件拒绝接管 | 自动测试 |
| 并发修改 | Vault.process 核对输出；源输入复读和写后检查 | 模拟 Vault 测试；无跨文件原子事务 |
| 撤销 | data.json 中最近一次 before/after 快照，重启可恢复 | 模拟持久化/重启；输出变更拒绝覆盖 |
| 平台 | 插件目标 ES2020、桌面；开发测试由 Node 设置 TZ | 未验证移动端、真实 Windows/macOS Obsidian UI |
| 时区 | 本地日期运算；DST 跳变周拒绝 | 上海、纽约跳变/非跳变子进程测试 |

格式依据：[Day Planner README](https://github.com/ivan-lednev/obsidian-day-planner#how-to-use-it)、[任意文件索引代码](https://github.com/ivan-lednev/obsidian-day-planner/blob/78672f68d2e96343c0875cd76dd4b7c442e31fd6/src/service/index/extensions/obsidian-tasks-extension-service.ts)、[日期属性格式](https://github.com/ivan-lednev/obsidian-day-planner/blob/78672f68d2e96343c0875cd76dd4b7c442e31fd6/src/regexp.ts)。只参考格式，不复制实现代码或捆绑其依赖。

Day Planner 过滤器可能隐藏输出；拖动若破坏注释/格式会阻止重排；拖动后未锁定的块会被替换。切换格式只转换当前可重排块，保护块保留原行。源任务 remaining 是用户维护的数据；勾选块不代表整个任务完成，也不将业务 due 当作块结束。

## 真实宿主补充（2026-10-01）

macOS Obsidian 1.13.7（安装程序 1.7.7）已在独立 test 库通过加载、设置、预览/应用、重载撤销、锁定、并发输入/撤销保护和阅读视图显示。参见 validation/2026-10-01/native-ui/result.json。Day Planner 格式已由实际插件 UI 生成和显示，但测试库未安装 Day Planner，故仍不声称两插件实机互操作已通过。

## Gantt Calendar 1.6.2：2026-10-01

- 上游 commit：a06130967bd862a642416e10970ca4bf4cfc7e11；相邻仓库 `../obsidian-gantt-calendar` 为浅克隆。普通 git clone 的 github.com 连接反复超时，改用 GitHub API 下载固定提交归档及 commit 元数据；工作树 tree SHA 与原始 commit SHA 均精确匹配，`git fsck --full` 通过，origin/master 和 master 指向原提交。
- 日期：Dataview `[start:: YYYY-MM-DD HH:mm]`、`[scheduled:: ...]`、`[due:: ...]`。源约束亦支持对应 Tasks emoji。
- 全局过滤器默认 🎯；本插件可配置相同前缀。避免输出混合 emoji/Dataview，因为上游混合格式会选择 Tasks 解析。
- 结构化隐藏元数据 `%%[as:: ...]%%` / `%%[as-block:: ...]%%` 在上游解析及序列化中保留。源 guid 不复制到输出。
- `scripts/gantt-interop.mjs` 直接捆绑执行上游真实 parser/serializer，模拟最小 Obsidian host；验证默认过滤器、分钟精度、时间、ID、锁定和源元数据往返。结果见 `validation/2026-10-01/gantt-interop.json`。未运行完整 Gantt UI，不声称界面实测。
- 当前严格校验时钟与日期字段一致；Gantt 拖动后需同步 clock/start/scheduled/due，跨日还需移动至相应每日文件。循环任务不展开，自定义状态仅支持空白、x/X、-、/、!、?、n。输出工作块只支持空白、x/X。
- 运行时不依赖 Gantt Calendar，不调用其私有 API；仍支持单独运行和旧单文件输出。
