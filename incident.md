# 实现与验证记录

- 作者：Codex
- 日期：2026-10-01
- 上游：spec.md、plan.md
- 下游：tests/、package-lock.json、validation/2026-10-01/、review.md
- Git commit：对应实现提交，详见 Git 历史
- 接受历史：开发诊断记录，未由 Alex 作产品效果判断

## 首轮测试预期违反最小尾块约束

现象：首轮 89 个测试中 1 个失败，原始记录见 `validation/2026-10-01/tests-first.txt`。固定事件案例期望排 105 分钟、留下 15 分钟，但任务 min=30，这违反规格的“剩余尾块为零或不少于 min”。

影响：测试期望错误，非算法证据表明排程失效。对照约束手工检查，正确结果为两个 45 分钟块、剩余 30 分钟、总占用 165 分钟。修正精确期望，未删除测试或放宽断言；合成样本时长守恒及 min 约束检查继续保留。

## npm 依赖解析与开发依赖审计

初始 Vitest 3 的 mocker 和 Obsidian SDK 的 moment 引入 4 项 moderate 审计警告。改用支持 Node 22 的 Vitest 4.1.11，并把仅开发阶段类型依赖中的 moment 覆盖到 2.31.0；插件运行包不包含 moment。首次 npm install 遇到 npm 10 的 edgesOut 解析错误，使用本项目 `--legacy-peer-deps` 完成安装；不改全局环境。后续干净安装同样使用该配置并重新审计。

预防：锁文件、项目 .npmrc 和审计命令纳入验证；类型编译检查最低 Obsidian SDK，运行包只 external 引用 obsidian。

## 设置快速输入的并发检查

代码复查发现最初“忙时拒绝操作”会丢失快速输入的设置变更。改为所有操作进入同一 Promise 队列；每次设置编辑按顺序持久化，应用时再校验设置快照。该问题在第一次实机使用前发现，不涉及用户数据。操作队列的回归测试随实现补齐。

## TypeScript 执行工具的 ESM/CJS 不一致

扩展时区测试首次运行时，Node ESM eval 无法读取被 tsx 按 CommonJS 编译的具名导出；演示脚本的顶层 await 也不能在该配置下运行。保留第二轮失败记录 `validation/2026-10-01/tests-second.txt`。修复项目开发代码为 ESM（package.json type=module），而 esbuild 插件产物继续明确输出 CJS 供 Obsidian 加载。时区测试和演示保留原断言，再次执行验证。新增 Node 启动脚本设置测试时区，避免开发命令依赖 Unix 的 TZ= 前缀。

## 午夜结束的格式检查

审查发现本地 clock 格式会把次日零点输出成 00:00，与同日区间读回约束矛盾。设置允许工作时段结束为 24:00，因此明确用 24:00 序列化当日午夜结束。普通/Day Planner 两种模式均添加午夜读回回归测试。默认白天演示未受影响，没有真实笔记写入。

## 自定义路径撤销和不可拆分锁定检查

最终复查发现撤销路径校验不应借用默认 fixedFile：用户把固定文件改为其他路径、输出设为原默认 Fixed.md 时，原校验会在重启丢弃合法备份。改为独立的库内安全路径校验，模拟宿主追加此场景的重启撤销检查。另为不可拆分任务追加多个锁定块的拒绝测试，避免变更 split 后出现违反约束的旧块。设置空值保留为无效值，不把空工作日/空缓冲隐式当作周日或零缓冲。

## 2026-10-01：GitHub Git 传输超时

现象：三次 shallow clone 在连接 github.com:443 / packfile 阶段超时；GitHub API 可访问。影响：参考源码获取延迟。处理：下载固定提交归档及 Git commit 元数据，恢复原始 Git 对象；文件树 SHA cccc5e02f97d348882554da16decdacffb9bcb08 与 commit a06130967bd862a642416e10970ca4bf4cfc7e11 均匹配，配置 shallow 边界与 origin，fsck 通过。未使用未知镜像或修改源码。预防：记录源码提交与 tree 哈希，互操作脚本检查固定提交和干净工作树。

## 2026-10-01：GitHub 同步通道及 CI 权限

Git push 到 github.com:443 持续连接超时，GitHub API 可达。使用 Git 对象 API 验证并上传原始 blob/tree/commit，保留完整本地提交。空仓库经 README 初始化，初始化提交作为同步合并的第二父提交保留，ref 只做 fast-forward 更新。更新含工作流的目标 ref 返回 404；API 响应显示 OAuth scope 为 repo 等，不含 workflow。CI 改为 .github/ci.yml.example 模板，未读取或修改凭据、未扩大授权。启用 CI 需另行取得 workflow 权限。

## 2026-10-02：测试库未实际切换每日输出

用户指出 test/Scheduler/Schedule.md 仍使用单文件和日期子标题，不符合 YYYY-MM-DD.md 下 # Day planner 的要求。原因：之前仅更新插件 bundle，保留的旧 data.json 仍为专用文件输出，未执行每日模式的实机验收；告知用户自行切换设置不足以完成测试库适配。

修复：在 test 的原生 Obsidian 中重新加载插件，实际切换 outputLocation=daily / outputMode=day-planner / dailyFolder=DailyNotes，并通过预览与应用生成 5 个每日文件、11 个工作块。将 Obsidian 核心日记目录也设为 DailyNotes。旧 Schedule 连同备注归档到被 Git 忽略的本地备份，避免重复事件；源任务 SHA256 不变；多文件撤销备份由插件保存。阅读视图已核验日期文件和一级 Day planner 标题。

证据：validation/2026-10-02/daily-output-validation.json 及对应每日合成示例。预防：安装 bundle 不作为完成标准；必须核对已保存配置、命令实际应用后的文件名/标题/列表、源文件哈希和当前 UI。此修复针对测试库配置，没有改变其他用户的既有输出设置。
