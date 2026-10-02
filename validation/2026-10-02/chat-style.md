# 0.3.2 验证记录

作者：Codex；日期：2026-10-02；代码基线 a4323786974b3931150c3daab314536eaa8d0b1a，本次提交见 Git 历史。
环境：Node v22.22.2、npm 10.9.7、Obsidian 1.13.7、macOS；上游 plan.md/spec.md；下游 review.md。

命令：npm run typecheck、npm test（171/171）、npm run smoke、npm run package、git diff --check，全部通过。

新增回归：旧前缀迁移时根据源任务显示优先级5，保持完成状态和时间；撤销恢复旧字节后可继续预览。新无前缀生成行手动改名仍拒绝覆盖。构建包侧栏仅配置按钮，没有 h3 或 select。

原生界面：test 安装并启用0.3.2；清理每日排程格式预览新增0/移除0/保留15，应用后七日日期笔记只变动前缀和重要性符号，时间/状态/标题/来源没有改变。2026-10-03显示“11:15 - 11:45 🔼 晚上锻炼”。顶部只有配置服务商/API令牌，输入框和操作按钮固定底部；浅色主题实际截图检查。未读取令牌、未发送模型请求。旧构建与原日期笔记保存于忽略目录 local-test-vaults/chat-style-upgrade-20261002-172635/。

源码/产物 SHA-256：

```json
{
  "src/output.ts": "affc4433fa873fce1c1659d56365c0e295deeccb55f43461e912efd2aba98cad",
  "src/tracking.ts": "8c473477912fa9d4f5ec477187f2df1f93329b46138bc820cb4f156a3d3591c7",
  "src/chat-view.ts": "26d1ed869b8aefde4aa6e008777fef5659a2ad2e4dab11f86d222622a6cae1b0",
  "src/transaction.ts": "871c1cd8c80ed70f189982102b871d07429d0ad9ebb0367f91d6a7c12ebe7826",
  "styles.css": "f84f782a68a431f90157480e5888e9534529257f4b7c806d4046b9a0d6eed909",
  "scripts/smoke.mjs": "2cfe57996e9c5d34230fc8f151d374da9a5aecb43fed61cb9e40eac426c0e58c",
  "main.js": "a8dd7b2a58dba39f7a8035cb2a6d39fed7635702bfecb15ebe8814d2ee18c968"
}
```
