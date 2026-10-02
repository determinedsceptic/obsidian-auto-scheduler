# 0.3.1 AI 直接排程验证

作者：Codex；日期：2026-10-02；基线：dba20e001331c28fd352eaf57a21b1d7fa4ded91；本次代码提交见 Git 历史。
上游：plan.md/spec.md；下游：review.md/README.md。
环境：macOS，Node v22.22.2，npm 10.9.7，Obsidian 1.13.7；依赖版本见 package-lock.json。

执行命令及结果：

- npm run typecheck：通过。
- npm test：11 文件、169 项测试通过，约 694 ms。
- npm run smoke：构建通过，CJS 宿主验证全部 PASS；模拟 provider，不连接网络、不读取真实令牌。
- npm run package：构建和本地打包通过。
- git diff --check：通过。

新增流程：对话直接应用；没有 AI 预览 Modal；600 分钟任务按每天 60 分钟容量分七日，实际回复列出 09:00–10:00 和剩余 180 分钟；自动打开最早日期，其他日期链接可用。模型猜测“明天20点完成”未进入结果。链接 path 元数据未发送给模型。普通讨论不改文件。导航失败保留成功状态；容量不足/非法输入不改设置和输出；第二次写入失败保留恢复记录，撤销回到原文件。

原生 UI：指定 test 库安装 0.3.1，关闭旧插件、刷新版本、重新启用、打开 AI 侧栏，原服务商/模型仍选中。未发送真实推理请求，未更改已有排程。旧构建文件备份在 Git 忽略目录 local-test-vaults/chat-direct-upgrade-20261002-171123/。

源码及产物 SHA-256（工作区版本）：

```json
{
  "src/main.ts": "355ac58e2ad82f6e1608136d7d480c3bc9c986214f61370b7ae28cd9b7564a9d",
  "src/chat-view.ts": "6178322ab3d637c4fa2d6d9759795d4ec06c8574b475028a5f2a7f1cc25a48e3",
  "src/ai-result.ts": "596fc482e4684fe718fe6987e07080ac29673612526964e80333aa9e08ffbce2",
  "src/llm.ts": "53c844e82559758f6a95d02046eb9d1d1ed16a92ea69dd49c8d2e85c503ff6ec",
  "scripts/smoke.mjs": "399d1542e31fb37f0f21e087c54c1cddd854459940ff107d50cfc149d743f6e4",
  "package-lock.json": "f152c7be09c1873fc73684c3310846fd11a481fa4d934d52abb376d596fc4600",
  "main.js": "7c6ff019551e64bc6edb7322acd23de170cc0d9706d8c43ac5ee09a4a73c5192"
}
```
