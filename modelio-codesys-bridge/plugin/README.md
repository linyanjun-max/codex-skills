# modelio-codesys-bridge — Modelio 4.1 / CODESYS 3.5 自动化桥

**Modelio 4.1 / CODESYS 3.5 通用桥（MCP 式工具插件）** —— 让 DeepSeek Harness 的 Agent 能够以脚本方式
无界面驱动 Modelio（Jython）和 CODESYS 3.5（IronPython），完成编辑、撰写、仿真、校验等操作。

零依赖、自包含 ESM：`lib/index.js` 不 import 任何包，任何 DSH 安装都能直接加载。

## 提供的工具

| 工具 | 作用 |
| --- | --- |
| `bridge_status` | 探测两个 IDE 的安装位置、CODESYS Profile、Modelio 版本、默认工作区、scratch 目录、沙箱策略 |
| `codesys_run` | 无界面执行 IronPython 2.7 脚本（`CODESYS.exe --profile="…" --runscript="…" --noUI`，经生成的 `run.cmd` 启动以保留字面量引号） |
| `modelio_run` | 无界面执行 Jython 2.7 脚本（`modelio.exe -workspace … -project|-create … -batch …`），自动开事务、提交、保存 |
| `bridge_launch_gui` | 打开 IDE 图形界面（人工检查结果） |
| `bridge_help` | 已验证 API 速查与常用配方（`overview` / `codesys` / `modelio`） |

## 脚本契约（两种 IDE 相同）

- `ARGS`：工具参数 `args` 传入的 JSON（自动转成 Python 字面量）。
- `RESULT`：脚本里赋值即可作为结构化结果返回。
- `print(...)`：被捕获进 `output`（CODESYS 同时出现在 `stdout`）。
- 失败：返回 `status: "error"` 与 traceback；插件绝不吞掉脚本异常。
- 每次运行都有独立目录（返回值 `runDir`）：`user.py`（你的脚本）、`run.py`（ASCII 包装器）、`result.json`。

```text
bridge_status { }
codesys_run  { script: "proj = projects.open(r'C:\\work\\demo.project'); proj.create_pou('PLC_PRG'); proj.save()" }
modelio_run  { project: "Demo", workspace: "C:\\ws", script: "..." }
```

## 安装（三种方式，只选一种）

插件是按“composition patch 插入一行”的方式加载的。**同一 row id 插入两次会报 loader 错误**，
所以下面三种方式互斥。

### A. 作为 DSH 插件包安装（推荐）

```bash
# 指向本包的 plugin/ 目录
dsh plugin --profile web add <本包绝对路径>
```

`package.json` 声明了 `dsh.bundle.patch`，安装后：

- 包名进入 profile 的 `dependencies`（pnpm 以 `link:` 指向本包目录）；
- 包名进入 `dsh.profile.bundles`；
- 包内 `cordis.patch.yml` 自动插入 `modelio-codesys-bridge` 行，**不用手写 patch**。

重启后出现在 设置 → 插件 → **插件列表 → 全局插件**；卸载：

```bash
dsh plugin --profile web remove dsh-tool-modelio-codesys-bridge
```

### B. 用户级 patch（本地开发）

在 `$DSH_HOME/cordis.patch.yml`（本机为
`C:\Users\<用户>\AppData\Roaming\dsh-desktop\harness\cordis.patch.yml`）里加入：

```yaml
- insert:
    - id: modelio-codesys-bridge
      name: './plugins/modelio-codesys-bridge/lib/index.js'
```

`./` 路径会相对 patch 文件解析成 file URL，因此只要把本包放在
`$DSH_HOME/plugins/modelio-codesys-bridge/` 即可；重启 DSH 后所有 profile 都带这些工具。

### C. profile 级 patch

编辑 `$DSH_HOME/profiles/<name>/cordis.patch.yml`，同上加 `- insert: …`；
把 `name` 写成本机绝对路径或相对 profile 目录的路径。

> 从 B/C 切到 A 时，记得删掉 B/C 里的 insert，否则同一 row 会插入两次。

## 配置

用 A 安装时，在 profile 的 `cordis.patch.yml` 里按 id 覆盖 `config`；用 B/C 时写在 insert 的行上。
字段全部可选：

```yaml
config:
  codesysRoot: 'D:\CODESYS 3.5'      # 默认值
  modelioRoot: 'D:\modelio'          # 默认值
  scratchDir: 'C:\Users\me\bridge'   # 运行目录根；默认 %USERPROFILE%\.dsh\modelio-codesys-bridge
```

## 行为保证（1.0.1）

- **成功判定是严格的**：`ok` 只有在 `result.json` 存在、`status=ok`、无 `transaction_error`/`save_error`、
  未被超时杀死、且进程退出码为 `0` 时才为 `true`。任何一项不满足都是 `ok: false`，并保留全部字段。
- **没有结果文件 = 失败**：`resultMissing: true` 加 `hint`；Modelio 还附带 `modelioLogTail`
  （最新 `modelio-*.log` 的尾部），便于定位“无输出失败”。绝不再因退出码为 0 而误报成功。
- **脚本失败会回滚，且不保存**：Modelio 事务按脚本结果提交/回滚，`status != ok` 时回滚并跳过
  `coreSession.save()`，不会把写了一半的修改写进工程。
- **GUI 启动会检测早退**：进程在 2.5 秒内退出即返回 `started: false`，附 `exitCode`/`stdout`/`stderr`。
- **scratch 与沙箱策略按每次调用解析**：只有安装信息（exe/Profile/版本）缓存；切换工作区或改策略后，
  运行目录不会沿用上一个会话的路径。

## 已验证的 API 事实（本机实测，写进 `bridge_help`）

- **Modelio**：`model.getModelRoots()` 返回 `[LocalModule, <Project>]`；`Standard.Project` 不是 NameSpace，
  必须 `root.getCompositionChildren()` 取根 `Package`；事务用 `modelingSession.createTransaction()`；
  保存用 `coreSession.save(None)`（`IModelingSession` 没有 `save()`）。
- **CODESYS**：`--noUI` 要求字面量 `--profile="名字"`（Node argv 会改写引号，故用 `run.cmd`）；
  SP15 没有 `project.build()`，编译在登录/下载时发生；`.NET` 对象 `dir()` 返回空，需 `GetType().GetMethods()`。
- **沙箱**：写入通过 DSH 的 `fs` 服务，并显式传入当前会话语义解析出的策略（`sandboxPolicy.resolve({session})`），
  在 `workspace-write` 下 scratch 落到工作区，在 `danger-full-access` 下落到用户目录。
  IDE 子进程同样受会话语义约束：如果批处理时 IDE 需要在工作区外写（工程、日志、临时文件），
  请在 `danger-full-access` 下运行，或把 scratch 与 Modelio workspace 放在当前工作区内；
  否则可能出现“启动器退出 0 但没有结果文件”，此时结果里的 `hint`/`modelioLogTail` 会指向该原因。

## 自检

不依赖 DSH 进程，用最小 fake ctx（fs/subprocess/timer 适配器）直接加载模块并跑工具：

```bash
node scripts/selfcheck.mjs                    # 注册 + status + 两个 IDE 真实运行（约 1–2 分钟）
SELFCHECK_SKIP_IDE=1 node scripts/selfcheck.mjs   # 只验证加载与注册
```

`files` 包含 `scripts/`，因此 `npm pack` / 打包分发后自检脚本仍在包内。

## 卸载

- 方式 A/B：删掉 `cordis.patch.yml` 里那条 `- insert:` 条目（或整个文件）。
- 方式 C：`dsh plugin --profile web remove dsh-tool-modelio-codesys-bridge`。
- 运行历史在 scratch 目录，可随时删除。

## 目录结构

```
dsh-tool-modelio-codesys-bridge/
  package.json          # 名称/入口/dsh.bundle 声明
  cordis.patch.yml      # 方式 C 使用的 bundle patch
  lib/index.js          # 插件本体（自包含，不 import 任何包）
  scripts/selfcheck.mjs # 独立自检
  README.md
```
