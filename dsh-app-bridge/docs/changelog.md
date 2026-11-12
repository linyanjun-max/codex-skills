# Changelog

## 1.0.1

修复安装版实测发现的问题，并补充诊断能力：

- **事务按脚本结果提交/回滚**：失败脚本不再把半成品写进 Modelio 工程；失败时跳过
  `coreSession.save()`。（此前无条件 commit + save。）
- **严格成功判定**：`ok` 要求 `result.json` 存在、`status=ok`、无 `transaction_error`/`save_error`、
  未超时、退出码为 0；缺结果时返回 `resultMissing` 与 `hint`，Modelio 附 `modelioLogTail`。
- **GUI 早退检测**：进程在 2.5 s 内退出返回 `started:false` 与 `exitCode`/`stdout`/`stderr`；
  CODESYS GUI 改为 `cmd` 直接守护（不再 `start` 后立即返回）。
- **跨工作区安全**：只缓存安装事实，`scratch` 与沙箱策略每次调用重新解析，切换工作区不沿用旧目录。
- **打包完整**：`files` 增加 `scripts`，`npm pack` 包含 `scripts/selfcheck.mjs`。
- **诊断增强**：IDE 子进程 `cwd` 改为各自安装目录；运行前检测已开实例并返回 `competingInstance` 警告。
- **自检扩展**：新增 `strict-ok`、`gui-early-exit`、`modelio rollback`、`rollback persistence` 回归用例。

## 1.0.0

首个可复用版本：

- 从动态 Cordis 插件迁移为常驻包：自包含 ESM（零 import），工具参数用原生 JSON Schema 直接
  `ctx.tools.register`。
- 5 个工具：`bridge_status`、`codesys_run`、`modelio_run`、`bridge_launch_gui`、`bridge_help`。
- 通过 `$DSH_HOME/cordis.patch.yml`（或 profile patch、或 `dsh plugin add`）安装。
- ASCII 包装器、Modelio 事务/保存、CODESYS `run.cmd` 引号处理、`ARGS`/`RESULT` 契约。
- `scripts/selfcheck.mjs`：不依赖 DSH 进程的端到端自检。
