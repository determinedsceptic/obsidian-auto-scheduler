# Auto Scheduler

在 Obsidian 中为带预计用时的 Markdown 任务生成一周工作块。AI 对话直接排程，手动命令先预览再应用；支持每日容量、固定日程、缓冲、锁定和最近一次撤销。

- 作者：Alex Hu（需求）、Codex（实现）
- 日期：2026-10-02；版本：0.3.2
- 支持范围：Obsidian 桌面端 1.6.6+；本地单用户
- 设计来源：`intend.md` → `spec.md` → `plan.md`
- 验证与审查：`validation/2026-10-01/`、`review.md`、`compatibility.md`
- Git 记录每个源码/配置/文档版本；验证结果中记录代码提交和 fixture 校验和
- 状态：本地开发版，产品效果尚未由实际使用验证

## AI 对话创建任务

1. 在左侧点击日历图标，或运行 **Auto Scheduler: 打开 AI 任务助手**，打开右侧对话面板。
2. 默认设置为 **Responses**、`https://api.openai.com/v1`、`gpt-6-luna`。点击侧栏 **配置服务商 / API 令牌**，在服务商对话框输入令牌并保存。也可在设置 → Auto Scheduler → BYOK 添加多个服务商。
3. 输入“我有两门课要复习，每门预计2小时，很重要，帮我安排一下”，点击发送（或 Cmd/Ctrl+Enter）。缺少用时等必要信息时模型会追问。
4. 模型调用 `create_tasks`，插件校验并直接应用本地排程，不弹出一周预览。AI 回答列出实际写入的日期、起止时间及未安排的剩余用时。
5. 任务记录到 `每日笔记目录/YYYY-MM-DD.md` 的 `# Day planner` 下，自动打开最早安排的日期笔记；跨多天时可点击回答中的日期链接。AI 流程启用每日纯列表。重新安排用“预览一周排程”；恢复用“撤销最近一次排程”。校验失败不写入，完全无可安排时间时不创建新任务；部分写入失败明确提示检查和撤销。

```markdown
# Day planner
- [ ] 14:00 - 16:00 ⏫ 课程1复习
```

AI 任务及未安排量的来源保存在插件 `data.json` 的 `aiTasks` 中，和跟踪/撤销数据一起备份。用时为 15 分钟倍数；重要默认优先级4；具体时间由原排程器安排，模型不能指定文件路径或覆盖笔记。本次排程包含已有手写源任务及 AI 任务。已完成工作块从 AI 总用时中扣除，包括过去日期的勾选；未勾选的过期工作会重新安排。每次只保留最近一次撤销记录。

**BYOK 配置**：参考 [Copilot 的服务商配置流程](https://github.com/logancyang/obsidian-copilot/blob/master/docs/settings.md)，通过 **添加服务商** 选择 OpenAI、Anthropic、Gemini、OpenRouter、DeepSeek、Ollama、LM Studio 或自定义模板。配置显示名称、协议、API 根地址、令牌及多个模型；在设置 → Auto Scheduler → 对话模型选择服务商和模型。侧栏顶部仅保留“配置服务商/API令牌”。编辑模型列表也在服务商对话框中完成；移除服务商会先显示确认，不影响笔记或 AI 任务。

**测试与模型发现**：点击“测试连接并发现模型”执行 GET /models，勾选需要的模型；列表过长可搜索。也可每行手动填写一个准确模型 ID。部分服务不提供模型列表，网络暂时失败仍可保存离线配置；明确返回鉴权拒绝时需更正令牌。发现列表成功不表示该模型支持函数工具调用，需要实际对话验收。模型目录可能包含不适用于聊天的模型，插件不会自动选择发现结果。

**协议**：OpenAI 默认使用 Responses（默认 gpt-6-luna）；兼容网关、OpenRouter、DeepSeek 及本地服务使用 Chat Completions；Anthropic 使用 Messages，Gemini 使用 generateContent。只支持可调用 create_tasks 工具的聊天模型，不包含 Copilot 的 Agent、索引、订阅代理或 Codex CLI 登录。默认模型及 GPT-6 Chat Completions 的 reasoning_effort=none 限制参考 [GPT-6 Luna 官方文档](https://developers.openai.com/api/docs/models/gpt-6-luna)。

**令牌保存**：Obsidian 1.11.4+ 且提供 SecretStorage 时，令牌保存到本机 Obsidian Keychain；旧宿主降级为会话内存，重载后需重新输入。设置页会显示当前方式。令牌不写入 data.json、Markdown、日志或 Git。每个服务商独立保存；更换地址或协议不会复用原令牌，需重新输入。密码框不展示已保存的令牌；留空在地址/协议未变时保留。取消不保存；清除令牌只在点击保存时执行，需要令牌的服务商仍需有效令牌或移除该服务商。本机 Keychain 不随笔记同步到其他设备，迁移后需在新设备配置令牌。

对话仅存内存。请求发送对话及日期、工作日/时段/容量，不发送笔记正文、文件路径或已有任务。使用 Obsidian requestUrl，不依赖浏览器 CORS，当前版本等待完整回复，未实现流式输出。HTTPS（本机 localhost/127.0.0.1 可用 HTTP）；超时不自动重试。供应商可能保留自己的请求记录，请按其政策使用。Codex 账户登录与 API 令牌/计费独立。

升级 0.2.0 时旧地址/模型迁移为“已有 LLM 配置”，AI 任务、跟踪与撤销保留。旧版会话令牌需重新配置。不完整的旧表单回退默认服务商，可重新编辑。

当前命令：**打开 AI 任务助手**、**预览一周排程**、**清理每日排程格式**、**撤销最近一次排程**。任务目录不存在时可只使用 AI 任务；已有目录仍会扫描手写任务。

每日任务显示重要性：🔺 最高（5）、⏫ 重要（4）、🔼 普通（3）、🔽 较低（2）、⏬ 最低（1）。排程先按重要性降序、再按截止日期分配可用时间；笔记中的任务按时间顺序显示。旧受管列表运行“清理每日排程格式”可去掉“工作块：”并更新重要性，时间和完成状态保持不变。

## 任务格式

默认扫描 `Tasks/` 的 Markdown 文件及子目录；可以在插件设置中改路径。只参与带 `as` 注释的复选框列表项，不修改源笔记。

```markdown
- [ ] 写实验分析 <!-- as id=analysis remaining=120 priority=4 due=2026-10-07 earliest=2026-10-01 split=true min=30 -->
- [ ] 整理材料 <!-- as id=materials remaining=60 priority=2 split=false -->
```

`id` 必须唯一，使用字母、数字、下划线或短横线。`remaining` 为分钟，`priority` 为 1–5（5 最高），remaining 必填；priority 可省略，使用日历字段或默认 3。`due` 和 `earliest` 可省略，格式为日期或 `YYYY-MM-DDTHH:mm`；日期截止包含当天。`split` 默认 true，`min` 默认 30 分钟；用时和最小块必须为 15 的倍数，且 min 不超过 remaining。15 分钟任务需明确写 `min=15`。

完成源任务可以勾选复选框，插件不再安排它。普通任务、代码围栏中的示例不参与排程。保留原有 Tasks/Dataview 标签；显式 `as` 约束优先；省略时读取 Tasks emoji 或 Dataview 的 priority/due/start/scheduled。medium 和 normal 均映射为 3，high 为 4，highest 为 5，low 为 2，lowest 为 1。`[-]` 表示取消，不再排程；`[/]` 表示进行中，仍参与排程。

## 固定日程与工作时间

默认固定日程文件 `Scheduler/Fixed.md`：

```markdown
# 固定日程
- 2026-10-02 10:00-11:00 组会
```

文件不存在时按无固定日程处理，并在预览中提示。单文件模式读取此文件；每日模式还读取每日笔记 Day planner 下管理区外的手写时间范围，以及具有完整开始/结束日期时间的 Gantt 任务。不获取 ICS 或外部日历事件。

默认周一到周五 09:00–12:00、14:00–18:00，每日容量 360 分钟；固定日程前后 15 分钟缓冲，每个工作块后 15 分钟缓冲。容量包含工作时段中的事件及缓冲并集。生成块会预留完整末尾缓冲，不跨工作时段和任务时间边界。均可在设置中调整，使用 15 分钟网格。

排程覆盖本地今天到第六天，今天只安排未来时间。采用优先级、截止、最早开始、ID 的确定性顺序，逐项选择最早可行时段；可能保留部分未安排量，不保证全局最优。包含夏令时跳变的周会拒绝排程。

## 预览、应用、锁定、撤销

1. 执行命令 **Auto Scheduler: 预览一周排程**。日历按钮现在打开 AI 任务助手。
2. 检查新增/移除/保留项、逐日容量和未安排原因；可以展开实际写入内容。
3. 点击“应用排程”，写入默认 `Scheduler/Schedule.md`，或配置的每日笔记。管理区外文字保持原样，已有普通同名笔记会被拒绝接管。
4. 如需保留某工作块，将它的 `as-block` 注释改为 `locked=true`，再预览。
5. 执行 **Auto Scheduler: 撤销最近一次排程**。仅保留最近一次备份，可跨重启；输出被修改后拒绝自动覆盖。撤销新建输出时保留空管理文件，不删除文件。

预览后源笔记、固定日程、输出或设置改变，就需要重新预览。应用时有单文件原子核对和写后检查；Obsidian 不提供跨文件事务，写入期间源文件变化会显示警告。

手动拖动未锁定块后，下一次预览会替换它。锁定或勾选的本周工作块从源任务 remaining 中扣除；历史块保留且不扣本周量。更新 remaining 时注意这一约定，避免重复扣减。插件不会从执行时间自动估算 remaining。

写入失败时，备份仍在插件目录 `data.json` 的 `undo` 字段中（before/after/path）。先检查输出与备份，保存两者后再手动恢复；多日记录的 `entries` 保存各文件；自动撤销先检查所有目标，再恢复已经写入的部分。任何不同于 before/after/恢复内容的手动改动都会拒绝覆盖。更换输出路径不迁移旧文件；撤销仍作用于记录的原路径。

## Day Planner

设置“输出格式”为 **Day Planner**：

```markdown
- [ ] 09:00 - 10:00 ⏫ 写实验分析 [[Tasks/Project]] [scheduled:: 2026-10-02] <!-- as-block id=b_analysis_1 task=analysis locked=false -->
```

工作块日期放在 scheduled 中，源任务业务截止不复制到输出。该模式参考 Day Planner 0.35.1 的公开格式。若 Day Planner 启用了过滤器，请允许专用输出文件/工作块；时间拖动后保留完整注释并锁定。勾选的是工作块，不会勾选源任务。

切换格式后，未锁定的本周块会采用新格式；锁定、勾选和历史块保留原始行，可能出现混合格式。独立文件中的普通列表不会被 Day Planner 当作 scheduled 任务读取。

详见 [compatibility.md](compatibility.md)。已做源码和格式测试，尚未完成两插件的实机互操作验收。

## 每日笔记与 Gantt Calendar

在设置中选择 **输出位置 → 每日笔记：Day planner**，指定每日目录（默认 `DailyNotes`），输出格式选择 **Gantt Calendar（Dataview）**。插件把工作块分配到今日起七天的 `YYYY-MM-DD.md`，只更新 `# Day planner` 内由插件数据记录的生成列表；其他章节和手写任务保持原样。没有标题时追加，重复标题会拒绝写入。没有工作块的日期不会新建空笔记。

每日模式默认启用“每日纯列表”，最终文件不含管理标记、scheduled 日期字段或工作块 ID：

```markdown
# Day planner
- [ ] 14:00 - 16:00 ⏫ 写实验分析 [[Tasks/Project]]
```

跟踪信息及锁定状态保存到插件 `data.json` 的 tracking 字段，与撤销备份一起先保存后写笔记。请保留/备份插件数据。支持勾选完成和编辑生成列表外的备注；改时间/标题导致无法核对时拒绝覆盖。需要修改生成列表时先撤销再重排。`Auto Scheduler: 清理每日排程格式` 会清理本周已有输出的管理字段，保留时间、完成状态及源链接，不重新排程。新建纯列表文件撤销后只保留标题。

以下为关闭“每日纯列表”后的 Gantt 日期字段兼容格式。纯列表日期来自文件名，Gantt 原生字段解析器无法从普通时钟列表获得 start/due；需要完整 Gantt 字段时关闭该设置。

Gantt Calendar 默认过滤器是 `🎯`；本插件的 **Gantt 任务前缀** 应与其一致。上游需启用 Dataview 任务格式，甘特图时间字段使用 startDate → dueDate。源任务可写为：

```markdown
# Day planner
- [ ] 🎯 写实验分析 [priority:: high] [due:: 2026-10-07 17:00] %%[as:: id=analysis remaining=120]%%
```

ID 和预计用时是自动排程必需信息。普通任务没有这些信息时保留，但不猜测用时。每日模式额外扫描本周目标每日文件中的源任务；如需扫描历史每日笔记的未完成任务，将“任务目录”也设为每日目录。日记中的其他章节不纳入每日任务读取。

输出示例：

```markdown
- [ ] 🎯 09:00 - 10:00 ⏫ 写实验分析 [[Tasks/Project]] %%[as-block:: id=b_analysis_1 task=analysis locked=false]%% [start:: 2026-10-02 09:00] [scheduled:: 2026-10-02 09:00] [due:: 2026-10-02 10:00]
```

输出的 due 是工作块结束时间，业务截止只留在源任务。结构化元数据可由 Gantt Calendar 编辑器保留，旧 HTML 元数据仍可读取。上游解析器和序列化器已实测往返；尚未验证其完整界面。Gantt 拖动后需让时钟范围、start/scheduled/due 一致，跨日移动还需移到对应日期文件；不一致时预览拒绝应用。保留手动位置需 `locked=true`。循环任务不自动展开。

多文件写入不是原子事务：完整备份先持久化，部分失败后可用撤销命令恢复已写文件。新建每日文件撤销后保留标题；字段兼容模式另保留空管理区。原单文件模式及默认设置继续保留，切换位置不自动迁移旧排程。

参考库位于相邻 `../obsidian-gantt-calendar`，固定提交 `a06130967bd862a642416e10970ca4bf4cfc7e11`。运行 `node scripts/gantt-interop.mjs` 可重复上游格式互操作测试。

## 仓库与架构

GitHub：[determinedsceptic/obsidian-auto-scheduler](https://github.com/determinedsceptic/obsidian-auto-scheduler)。主分支 main；源码、依赖锁文件、设计和验证记录由 Git 管理。

参考 Gantt Calendar 的 TypeScript / Obsidian 插件结构，职责划分见 [docs/architecture.md](docs/architecture.md)。versions.json 记录各版本最低 Obsidian 版本。CI 模板 [.github/ci.yml.example](.github/ci.yml.example) 在 Node 22/24 上执行类型检查、测试、宿主 smoke、打包及固定上游版本格式互操作。现有 GitHub 凭据没有 workflow 权限，因此模板尚未启用；取得该权限后放入 .github/workflows/ci.yml 即可。

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
