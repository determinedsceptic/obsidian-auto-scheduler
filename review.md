# 初版实现审查

- 作者：Codex
- 日期：2026-10-01
- 审查源码 commit：`f716db1c493769d5ef415c2668eb35e85b716cf6`
- 上游：intend.md、spec.md、plan.md、src/、tests/、incident.md
- 下游：validation/2026-10-01/、README.md、本地试用包
- 接受历史：Alex 授权开发；本审查记录自动验证及单独源码复查，不替代 Alex 的实际使用评价与发布决策

## 检查结果

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| 干净安装 | npm ci --ignore-scripts 成功 | validation/2026-10-01/install.txt |
| 最低 SDK | Obsidian 1.6.6，strict TypeScript 检查通过 | package-lock.json、typecheck.txt |
| 自动测试 | 7 个文件、96 项测试通过 | tests-final.txt |
| 不变量 | 20 组固定种子样本检查时长守恒、网格、时段、容量、重复运行一致性 | tests/scheduler.test.ts |
| 一天小样本 | 3 个块；不满足 earliest 或连续区间的任务保留未安排 | demo-result.json smallSample |
| 完整一周 | 12 个块，额外工作剩余 1710 分钟；无越界、冲突或容量超额 | demo-result.json week、demo-plain.md |
| 格式适配 | 普通/Day Planner 输出可读回；scheduled 与 due 分离，勾选和拖动格式保留 | compatibility.test.ts、output.test.ts |
| 构建与宿主模拟 | CJS 加载；预览只读；公开 Vault 创建/原子核对；默认和自定义路径的重启撤销通过 | smoke.txt、scripts/smoke.mjs |
| 并发保护 | 源新增/删除/修改、输出变化、设置变化、备份失败、写失败均有检查 | tests/transaction.test.ts |
| 撤销保护 | 快照不匹配拒绝覆盖；新文件撤销不删除；源笔记不修改 | tests/transaction.test.ts、smoke.txt |
| 时区 | 上海与纽约非跳变周可排程；春秋 DST 跳变周拒绝 | tests/timezone.test.ts |
| 开发依赖审计 | 0 项报告漏洞 | audit.json |

## 复查与反例

首轮测试错误预期、TypeScript ESM/CJS 执行问题保留原始失败记录；没有删除失败测试。单独复查额外检查午夜结束、自定义输出路径重启撤销、不可拆分任务多个锁定块，以及快速设置输入的丢弃风险，修正后有回归检查，详见 incident.md。

默认固定文件缺失会按无事件处理，UI 明示警告。未知任务 ID、重复 ID、非法元数据、非法管理区、锁定冲突和锁定量超出 remaining 阻止应用，不通过忽略错误获得成功结果。已有超额占用保留，本日不新增；这些负面案例独立于正常演示。

样本为虚构数据，无真实研究结果、个人日记或账号。源码、锁文件和 fixture 均在 Git；结果记录提交、时钟、时区、配置和输入 SHA-256。算法没有随机性；不变量测试采用确定种子。1000 任务约 12.18ms 为本机单次性能检查，仅表示该样本没有界面级长时计算，不外推跨机器性能。

## 尚未验证和已知边界

- 未在真实 Obsidian UI 或与 Day Planner 同时运行的库中验收。模拟宿主与格式测试不证明实际索引、过滤器和拖动交互无问题。
- 只读取显式固定文件，不自动读取 Daily Notes、Day Planner 或远程日历事件；使用前需确认固定日程完整。
- 贪心优先级排序不保证全局最优，没有证据证明比手动排程更省时间。未来实际使用比较由 Alex 定义和判断。
- Obsidian 只提供单文件 process，不保证源文件与输出的跨文件事务；复读至写入之间的并发窗口靠写后诊断，不作原子保证。
- 只有一个持久化撤销记录。写入失败或用户改过输出时可能需根据 data.json 手动恢复；撤销恢复后若状态清理保存失败，需检查输出和备份，不重复覆盖。
- 源任务 ID 和 remaining 由用户维护；本周保护块扣减 remaining，历史块不扣减。勾选工作块不代表任务整体完成，手动更新 remaining 需避免重复扣减。
- 格式切换保护原始锁定/勾选/历史行；混合格式可能让 Day Planner 不显示普通历史行。未验证移动端、Gantt Calendar、ICS 或多用户协作。

源码和本地试用包可供审查；重要合并、真实库安装和外部发布没有执行。
