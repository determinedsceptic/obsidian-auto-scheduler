# Auto Scheduler

在 Obsidian 中为带预计用时的 Markdown 任务生成一周工作块。先预览，再应用；支持每日容量、固定日程、缓冲、锁定和最近一次撤销。

- 作者：Alex Hu（需求）、Codex（实现）
- 日期：2026-10-01；版本：0.1.0
- 支持范围：Obsidian 桌面端 1.6.6+；本地单用户
- 设计来源：`intend.md` → `spec.md` → `plan.md`
- 验证与审查：`validation/2026-10-01/`、`review.md`、`compatibility.md`
- Git 记录每个源码/配置/文档版本；验证结果中记录代码提交和 fixture 校验和
- 状态：本地开发版，产品效果尚未由实际使用验证

## 任务格式

默认扫描 `Tasks/` 的 Markdown 文件及子目录；可以在插件设置中改路径。只参与带 `as` 注释的复选框列表项，不修改源笔记。

```markdown
- [ ] 写实验分析 <!-- as id=analysis remaining=120 priority=4 due=2026-10-07 earliest=2026-10-01 split=true min=30 -->
- [ ] 整理材料 <!-- as id=materials remaining=60 priority=2 split=false -->
```

`id` 必须唯一，使用字母、数字、下划线或短横线。`remaining` 为分钟，`priority` 为 1–5（5 最高），两者必填。`due` 和 `earliest` 可省略，格式为日期或 `YYYY-MM-DDTHH:mm`；日期截止包含当天。`split` 默认 true，`min` 默认 30 分钟；用时和最小块必须为 15 的倍数，且 min 不超过 remaining。15 分钟任务需明确写 `min=15`。

完成源任务可以勾选复选框，插件不再安排它。普通任务、代码围栏中的示例不参与排程。保留原有 Tasks/Dataview 标签；排程约束以 `as` 字段为准，不自动猜测其他插件属性含义。

## 固定日程与工作时间

默认固定日程文件 `Scheduler/Fixed.md`：

```markdown
# 固定日程
- 2026-10-02 10:00-11:00 组会
```

文件不存在时按无固定日程处理，并在预览中提示。初版**只读取此文件的固定日程**，不会自动获取 Day Planner、Daily Notes、ICS 或其他日历中的事件。请把需要避开的时间记在此文件中。

默认周一到周五 09:00–12:00、14:00–18:00，每日容量 360 分钟；固定日程前后 15 分钟缓冲，每个工作块后 15 分钟缓冲。容量包含工作时段中的事件及缓冲并集。生成块会预留完整末尾缓冲，不跨工作时段和任务时间边界。均可在设置中调整，使用 15 分钟网格。

排程覆盖本地今天到第六天，今天只安排未来时间。采用优先级、截止、最早开始、ID 的确定性顺序，逐项选择最早可行时段；可能保留部分未安排量，不保证全局最优。包含夏令时跳变的周会拒绝排程。

## 预览、应用、锁定、撤销

1. 执行命令 **Auto Scheduler: 预览一周排程**，或点击日历按钮。
2. 检查新增/移除/保留项、逐日容量和未安排原因；可以展开实际写入内容。
3. 点击“应用排程”，写入默认 `Scheduler/Schedule.md`。管理区外文字保持原样，已有普通同名笔记会被拒绝接管。
4. 如需保留某工作块，将它的 `as-block` 注释改为 `locked=true`，再预览。
5. 执行 **Auto Scheduler: 撤销最近一次排程**。仅保留最近一次备份，可跨重启；输出被修改后拒绝自动覆盖。撤销新建输出时保留空管理文件，不删除文件。

预览后源笔记、固定日程、输出或设置改变，就需要重新预览。应用时有单文件原子核对和写后检查；Obsidian 不提供跨文件事务，写入期间源文件变化会显示警告。

手动拖动未锁定块后，下一次预览会替换它。锁定或勾选的本周工作块从源任务 remaining 中扣除；历史块保留且不扣本周量。更新 remaining 时注意这一约定，避免重复扣减。插件不会从执行时间自动估算 remaining。

写入失败时，备份仍在插件目录 `data.json` 的 `undo` 字段中（before/after/path）。先检查输出与备份，保存两者后再手动恢复；自动撤销只在输出精确等于 after 时运行。更换输出路径不迁移旧文件；撤销仍作用于记录的原路径。

## Day Planner

设置“输出格式”为 **Day Planner**：

```markdown
- [ ] 09:00 - 10:00 工作块：写实验分析 [[Tasks/Project]] [scheduled:: 2026-10-02] <!-- as-block id=b_analysis_1 task=analysis locked=false -->
```

工作块日期放在 scheduled 中，源任务业务截止不复制到输出。该模式参考 Day Planner 0.35.1 的公开格式。若 Day Planner 启用了过滤器，请允许专用输出文件/工作块；时间拖动后保留完整注释并锁定。勾选的是工作块，不会勾选源任务。

切换格式后，未锁定的本周块会采用新格式；锁定、勾选和历史块保留原始行，可能出现混合格式。独立文件中的普通列表不会被 Day Planner 当作 scheduled 任务读取。

详见 [compatibility.md](compatibility.md)。已做源码和格式测试，尚未完成两插件的实机互操作验收。

## 构建与本地试用

开发使用 Node 20/22 LTS 或 24+，npm。项目 `.npmrc` 固定 peer 解析策略，锁文件固定实际依赖。

```sh
npm ci --ignore-scripts
npm run typecheck
npm test
npm run demo
npm run smoke
npm run package
```

`dist/auto-scheduler/` 包含 `main.js`、`manifest.json`、`styles.css` 和本说明。先在一个独立测试库中，把前三个文件放到 `.obsidian/plugins/auto-scheduler/`，重载 Obsidian 后启用社区插件；把 `demo-vault/` 中的虚构 Tasks 和 Scheduler 文件复制到测试库。演示 fixture 固定于 2026-10-01；今天试用可以原样使用，以后需把日期移到试用周。安装到真实库由 Alex 决定。

`npm run demo` 只读虚构 fixture，输出到 `validation/2026-10-01/`，不会触碰真实笔记库。包含一天小样本、一周完整案例、1000 任务短时性能检查。`npm run dev` 监视源码并构建，不安装或启动插件。
