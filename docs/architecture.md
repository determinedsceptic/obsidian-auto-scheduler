# 项目架构

作者：Codex；日期：2026-10-01。根据 Alex 的 GitHub 同步请求整理。来源：spec.md、plan.md 与 Gantt Calendar commit a061309。实现版本由本文件所在 Git 提交确定。

采用 Gantt Calendar 的 Obsidian TypeScript 插件结构：src/main.ts 入口、根目录 manifest.json / versions.json / styles.css、esbuild 构建、独立测试和工具脚本。按当前功能规模拆分职责；将日历插件的 Markdown schema 作为兼容边界。

| 文件 | 职责 |
| --- | --- |
| src/main.ts | 插件生命周期、命令、设置和预览界面；公共 Obsidian Vault API 适配 |
| src/types.ts | 任务、时间块、设置、备份和诊断类型 |
| src/parser.ts | 明确估时任务及固定日程读取、字段验证 |
| src/calendar-format.ts | Tasks emoji / Dataview 日期、优先级与结构化隐藏元数据 |
| src/daily.ts | YYYY-MM-DD.md 的 Day planner 分区、手写占用与受管区保留 |
| src/time.ts | 本地时间、15 分钟网格、路径/设置验证、时间区间操作 |
| src/scheduler.ts | 确定性容量约束排程；不依赖 Obsidian |
| src/output.ts | 工作块读取、渲染、差异比较；保留管理区外内容 |
| src/transaction.ts | 只读预览快照、备份、比较写入、多文件失败恢复与撤销 |
| src/queue.ts | 顺序执行设置和写入操作 |

数据流：Markdown → 格式解析/输入校验 → 排程 → 输出渲染/读回校验 → 预览 → 输入快照检查 → 持久化备份 → Vault 比较写入。用户确认应用发生在预览界面；多文件写入没有跨文件原子性。

tests/ 测试纯逻辑与事务边界；scripts/smoke.mjs 验证构建产物在模拟宿主中的行为；scripts/gantt-interop.mjs 直接执行固定版本上游 parser/serializer；demo-vault/ 仅含合成示例；validation/ 保存验证记录。

Git 管理源码、锁文件、配置、设计及验证文档。node_modules/、main.js、dist/ 和本地测试库不入库。构建产物由 npm run package 生成，CI 模板配置 artifact（尚未启用）；本次同步不创建 Release 或版本标签。

运行时仅依赖 Obsidian；上游源码不是 vendored 依赖。不引入其 React、日历界面或飞书同步系统。本插件仍支持 Obsidian 桌面端 1.6.6+，Gantt 互操作的参考版本本身要求 1.13.0+。
