# 初版验证记录

- 作者：Codex
- 日期：2026-10-01
- 代码提交：f716db1c493769d5ef415c2668eb35e85b716cf6
- 上游：spec.md、plan.md、tests/、scripts/、demo-vault/
- 下游：review.md、本地试用
- 状态：自动检查通过；真实 Obsidian / Day Planner 互操作未验证
- 环境：Node v22.22.2、npm 10.9.7、Obsidian SDK 1.6.6；完整依赖版本见根目录 package-lock.json
- 原始数据：仅 Git 中的虚构 fixtures；SHA-256 见 demo-result.json

复现命令（项目根目录）：

```sh
npm ci --ignore-scripts
npm run typecheck
npm test
npm run demo
npm run smoke
npm run package
npm audit --json
```

测试时区通过 scripts/run.mjs 固定为 Asia/Shanghai，时区边界测试另外启动独立纽约子进程；demo 和宿主模拟固定时钟为 2026-10-01 08:00 +08:00。npm run demo 会重新生成本目录的 demo 文件和 JSON；如果源码/fixtures 有未提交修改，应保留新记录的 codeDirty=true，不能当作冻结版本证据。

| 文件 | 内容 |
| --- | --- |
| install.txt | 干净安装原始输出 |
| typecheck.txt | 最低 SDK 类型检查 |
| tests-first.txt | 初始 88/89 通过，错误尾块预期，失败保留 |
| tests-second.txt | 扩展时区测试的 ESM/CJS 工具失败，失败保留 |
| tests-final.txt | 96/96 最终测试通过 |
| smoke.txt | 真正 CJS 产物在模拟宿主中的加载、命令、应用和重启撤销 |
| package.txt | 产物生成，dist/auto-scheduler/ |
| audit.json | 开发依赖审计 0 项漏洞 |
| demo-command.txt | 固定小样本、一周和 1000 任务短时检查输出 |
| demo-result.json | 配置、时钟、提交、输入校验和、容量和未安排结果 |
| demo-plain.md | 普通格式完整输出 |
| demo-day-planner.md | Day Planner 格式完整输出 |

本地生成的 main.js、dist/ 和 node_modules 不进入 Git，用上述命令再生成；不存在大数据、模型权重或外部上传。失败原因和修复见根目录 incident.md。每个演示数字均可追踪到 demo-result.json，未作实际产品效果结论。
