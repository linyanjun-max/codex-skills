# 故障排查

先读返回 JSON 的这几个字段，再看对应小节：

`ok` · `resultMissing` · `timedOut` · `exitCode` · `error` · `transaction` ·
`transaction_error` · `saved` · `save_error` · `stderr` · `competingInstance` ·
`hint` · `modelioLogTail` · `runDir`

## 对照表

| 现象 | 可能原因 | 处理 |
| --- | --- | --- |
| `ok:false`，`resultMissing:true`，`exitCode:0` | 启动器成功退出，但脚本没跑到包装器结尾：IDE 启动失败、参数/Profile 不对、或沙箱阻止 IDE 写工作区外 | 看 `hint`/`stderr`；把会话切到 `danger-full-access`，或把 scratch/workspace 放进当前工作区；手动执行 `runDir\run.cmd` 对照 |
| `ok:false`，`status:"error"`，`transaction:"rolled-back"` | 脚本自身抛错（Modelio） | 看 `error` 的 traceback；修改已回滚、未保存，可安全重试 |
| `ok:false`，`status:"error"`，`transaction_error` 有值 | 事务创建/提交失败 | 常与模型状态或并发实例有关；关掉 GUI 实例后重试 |
| `save_error` 有值 | `coreSession.save()` 失败 | 可能磁盘权限/空间；看 traceback |
| `timedOut:true` | 超过 `timeoutSec` 被强杀 | 冷启动 60–90 s，给 300–600；确认没有弹窗等待 |
| `competingInstance` 非 null | 运行前已有 CODESYS/Modelio 实例 | 关闭实例后重试；GUI 与脚本模式不要并用 |
| `profile` 为空/未探测 | 安装目录/VersionKey 异常 | `bridge_status` 检查；或显式传 `profile: "CODESYS V3.5 SP15 Patch 3"` |
| `Modelio project "X" was not found` | 工程不在该 workspace | 用 `create` 新建，或修正 `workspace` |
| `Modelio project "X" already exists`（create 时） | 目录已存在 | 改用 `project` |
| GUI `started:false` | 进程 2.5 s 内退出 | 看 `exitCode`/`stderr`；确认 exe 路径、workspace 可写 |
| Modelio 启动即失败且日志只有 `Invalid workspace directory` | 批处理要求 workspace 已存在 | 工具会自动建；若手写命令，先建目录 |
| CODESYS 报 `必须使用 --profile="profile name"` | 命令行引号被改写 | 插件已用 `run.cmd` 规避；手写命令时保留字面量引号 |
| CODESYS 提示加载 Core 程序集被拒绝 / 启动即退出 | 多为环境/权限类问题（受限沙箱、已运行实例、损坏的 Profile） | 用 `danger-full-access`、关闭已开实例、重试；仍复现则把完整 `stderr` + `command` 保留下来对比 |

## 手工复现一次运行

每次运行都留下完整现场，`runDir` 内容：

- `user.py`：你的脚本；
- `run.py`：包装器（可直接阅读）；
- `run.cmd`：CODESYS 启动器（内含逐字节命令行）；
- `result.json`：包装器写出的结果（缺失就是 `resultMissing` 的直接证据）。

手工重放（CODESYS）：

```powershell
cd <runDir>
cmd /c run.cmd
```

手工重放（Modelio）：

```powershell
& 'D:\modelio\modelio.exe' -workspace '<ws>' -project '<name>' -batch '<runDir>\run.py'
```

对照 `result.json` 与 IDE 日志：

- Modelio：`%USERPROFILE%\.modelio\4.1\modelio-*.log`（插件在缺结果时自动附尾部）；
- CODESYS：`stderr` 通常已含关键错误；脚本消息也走 stderr。

## 沙箱边界

插件是 host 插件，IDE 是 DSH 的子进程，同样受会话策略约束：

- `danger-full-access`：IDE 可自由读写，推荐用于真实工程；
- `workspace-write`：IDE 只能在工作区内写。若工程、日志或临时目录在工作区外，容易出现
  “启动器退出 0 但没有结果文件”。此时把 `scratchDir` 与 Modelio `workspace` 指到工作区内，
  或直接切到 `danger-full-access`。

## 自检不通过

```bash
node plugin/scripts/selfcheck.mjs
```

- 前两步（注册、`bridge_status`）失败 → 模块加载/服务契约问题，先检查 Node 版本与路径；
- `strict-ok` / `gui-early-exit` 失败 → 成功判定逻辑被改坏；
- `codesys_run` / `modelio_run` 失败 → IDE 或环境问题，查看它打印的 `error`/`stderr`；
- `modelio rollback` / `rollback persistence` 失败 → 事务/保存语义被改坏（最危险的一类）。

## 清理

scratch 目录可整体删除：`%USERPROFILE%\.dsh\modelio-codesys-bridge\`（或配置的 `scratchDir`）。
`runDir` 里没有需要长期保留的状态。
