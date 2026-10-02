# AI Scheduler 与日程自动分配的区别

- 作者：Codex
- 日期：2026-10-02
- 本地设计基线：dba20e001331c28fd352eaf57a21b1d7fa4ded91；本次代码提交见 Git 历史
- 上游请求：Alex 要求检查 racstan/obsidian-ai-scheduler 是否已实现 Obsidian 上的 Reclaim
- 参考源码：racstan/obsidian-ai-scheduler，73b7ffa5ec6d9eeadb733ff5b2a3b1cc4365d2ef
- 状态：文档与核心类型/时间引擎核查；未安装或执行参考插件

## 查到的实现

该插件是 Claudian/Copilot 的定时执行层。Job 保存 prompt、contextPaths、执行模型、schedule、nextRunAt 和运行状态。TaskSchedule 支持一次、每日、每周、多规则、间隔、cron 及事件触发。engine 按 nextRunAt 找到到期作业；schedule 计算下一次触发时间。README 描述夜间笔记复盘、日间报告、启动补跑及 YAML 作业同步。

其 Job 类型与时间引擎没有预计工作用时、任务业务截止、任务优先级、忙闲区间、时间块拆分和容量约束分配。自然语言 planner 产生的是定时 AI 作业，而不是为人的待办寻找可行空闲时段。虽然后台 AI 可以被要求生成计划文本，源码核查不足以把它认定为具有 Reclaim 核心约束能力的排程器。

Reclaim 官方 Tasks 页面描述按会议、期限与可用时间安排任务，支持优先级、分割工作块和冲突自动重排。我们的插件已包含本地约束排程、固定占用、优先级/截止、分块和容量，以及此次添加的聊天直接落盘；仍由聊天/手动命令触发，不监听所有日历变化主动重排，也没有外部日历同步与习惯自动安排。因此当前实现也不是完整 Reclaim。

## 来源

- [参考 README](https://github.com/racstan/obsidian-ai-scheduler/blob/73b7ffa5ec6d9eeadb733ff5b2a3b1cc4365d2ef/README.md)
- [Job 与 TaskSchedule 类型](https://github.com/racstan/obsidian-ai-scheduler/blob/73b7ffa5ec6d9eeadb733ff5b2a3b1cc4365d2ef/src/types.ts)
- [到期作业引擎](https://github.com/racstan/obsidian-ai-scheduler/blob/73b7ffa5ec6d9eeadb733ff5b2a3b1cc4365d2ef/src/engine.ts)
- [触发时间计算](https://github.com/racstan/obsidian-ai-scheduler/blob/73b7ffa5ec6d9eeadb733ff5b2a3b1cc4365d2ef/src/schedule.ts)
- [Reclaim 官方 Tasks](https://reclaim.ai/features/tasks)
