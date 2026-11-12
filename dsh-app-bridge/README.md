# DSH app-bridge — Modelio 4.1 / CODESYS 3.5 通用桥

把两个 Windows IDE 的脚本引擎包装成 **DeepSeek Harness（DSH）的常驻工具**：Agent 用 Python
写操作，插件负责在独立目录里落地脚本、无界面启动 IDE、等待执行、收集 `RESULT`/stdout/异常/
事务与保存状态，并以结构化 JSON 返回。适合“让 Agent 自己改模型、写 PLC 程序、跑仿真、做校验”。

> 这是 **DSH 插件**，不是 Codex skill 本身。Agent 侧的使用说明见 [`SKILL.md`](SKILL.md)；
> 插件本体在 [`plugin/`](plugin/)。

## 功能

| 工具 | 引擎 | 作用 |
| --- | --- | --- |
| `bridge_status` | — | 探测两个 IDE 的安装位置、CODESYS Profile/版本、Modelio 版本、默认工作区、scratch、沙箱策略、是否已有实例在跑 |
| `codesys_run` | IronPython 2.7 | `CODESYS.exe --profile="…" --runscript="…" --noUI`，经生成的 `run.cmd` 启动 |
| `modelio_run` | Jython 2.7 | `modelio.exe -workspace … -project|-create … -batch …`，自动开事务、提交/回滚、保存 |
| `bridge_launch_gui` | — | 打开 IDE 图形界面，人工检查结果 |
| `bridge_help` | — | 已验证 API 速查（`codesys` / `modelio` / `overview`） |

能力覆盖：

- **Modelio**：新建/打开工程、建包/类/操作/用例/状态机/图、审计、XMI 导入导出、保存模型。
- **CODESYS**：新建/打开/保存工程、枚举设备与对象、创建 POU、编辑声明与实现、XML/native 导入导出、
  保存归档；登录仿真 PLC（`login` 即编译+下载，SP15 没有独立 `build()`）、启停应用、读写变量。

## 架构

```
Agent ──tool call──▶ DSH host ──plugin──▶ scratch/<app>/<stamp>/
                                          user.py   （你的脚本）
                                          run.py    （ASCII 包装器：注入 ARGS、捕获输出、写 result.json）
                                          run.cmd   （CODESYS 启动器，保留字面量引号）
                                          result.json
                                                │
                                    cmd /c CODESYS.exe --profile="…" --runscript="…" --noUI
                                    modelio.exe -workspace … -batch run.py
```

- **注册平面**：插件把工具注册进 host 的 `tools` 注册表，一个实例服务所有会话；不发布 service，
  因此无需 `isolate` realm。
- **组合方式**：DSH 用 patch 组装 profile。`- insert:` 里以 `./`、`../` 开头的 `name` 会相对
  **patch 文件所在目录**解析并转成 `file:` URL，所以本地包不需要发布到 npm。
- **包装器**：`pyStr`/`pyLiteral` 把非 ASCII 全部转成 `\uXXXX`，保证 Modelio 按系统字符集解码
  时不会破坏脚本；`execfile` 用户脚本并注入受控 globals，tee stdout，最后一定写 `result.json`。
- **事务**：Modelio 先触碰模型再 `createTransaction()`；脚本身份为 `ok` 才 commit，否则 rollback；
  只有 commit 之后才 `coreSession.save(None)`。
- **引号**：CODESYS 在 `--noUI` 下要求字面量 `--profile="名字"`；Node 的 argv 引用会改写它，
  所以写一个 `run.cmd` 交给 `cmd /c` 执行。
- **沙箱**：写入走 host `fs` 服务并显式传入会话策略；scratch 与策略**每次调用重新解析**，
  跨工作区不会沿用旧目录。
- **诊断**：无 `result.json` 返回 `resultMissing` + `hint`，Modelio 还附最新
  `modelio-*.log` 尾部。

## 安装

三种方式**只能选一种**（同一 row id 插入两次会报 loader 错误）。

### A. 用户级 patch（推荐）

把 `plugin/` 放到 `$DSH_HOME/plugins/dsh-tool-app-bridge/`，创建 `$DSH_HOME/cordis.patch.yml`：

```yaml
- insert:
    - id: tool-app-bridge
      name: './plugins/dsh-tool-app-bridge/lib/index.js'
```

重启 DSH 后所有 profile、所有会话都带这些工具。

### B. profile 级 patch

把同样的 `- insert:` 写进 `$DSH_HOME/profiles/<name>/cordis.patch.yml`，路径相对该文件。

### C. 作为 pnpm 插件

```bash
dsh plugin --profile web add <本包绝对路径>
```

`package.json` 声明了 `dsh.bundle.patch`，包内 `plugin/cordis.patch.yml` 会自动插入该行。

### 配置

```yaml
- id: tool-app-bridge
  name: './plugins/dsh-tool-app-bridge/lib/index.js'
  config:
    codesysRoot: 'D:\CODESYS 3.5'     # 默认
    modelioRoot: 'D:\modelio'         # 默认
    scratchDir: 'C:\Users\me\bridge'  # 默认 %USERPROFILE%\.dsh\app-bridge
```

## 使用

脚本契约：`ARGS` 入参、`RESULT` 出参、`print` 捕获、异常进 `error`。

```text
bridge_status {}
bridge_help { "topic": "modelio" }

codesys_run {
  "script": "proj = projects.open(r'D:\\work\\demo.project')\npou = proj.create_pou('PLC_PRG')\nproj.save()\nRESULT = {'pou': str(pou)}",
  "timeoutSec": 300
}

modelio_run {
  "create": "Demo",
  "workspace": "D:\\proj\\modelio-ws",
  "script": "from org.modelio.api.modelio import Modelio\nmi = Modelio.getInstance()\nms = mi.getModelingSession()\nmodel = ms.getModel()\nroot = [r for r in model.getModelRoots() if 'Standard.Project' in str(r)][0]\nrootpkg = [c for c in root.getCompositionChildren() if 'Package' in str(type(c))][0]\nmodel.createPackage('Design', rootpkg)\nRESULT = {'ok': True}"
}
```

### 返回语义（严格）

`ok` 只有在「有 `result.json` + `status=ok` + 无事务/保存错误 + 未超时 + 退出码 `0`」时为真。
任一不满足即 `ok: false`，并保留 `resultMissing`、`transaction`、`saved`、`error`、`stderr`、
`competingInstance`、`modelioLogTail` 等证据字段。

- `resultMissing: true` → IDE 没跑到包装器结尾，看 `hint` / `stderr` / `modelioLogTail`。
- `transaction: "rolled-back"` → 脚本失败，修改已丢弃，未保存。
- `started: false`（GUI）→ 进程 2.5 秒内退出，看 `exitCode`/`stderr`。

详见 [`docs/usage.md`](docs/usage.md)，故障对照见 [`docs/troubleshooting.md`](docs/troubleshooting.md)。

## 已验证（本机实测）

- Modelio 4.1.00：新建 `BridgeDemo`，建 `Design` 包与 `Tank` 类，`transaction: committed`、
  `saved: true`，并在 `data/fragments/<proj>/model/` 下确认落盘；失败脚本回滚后磁盘无残留。
- CODESYS 3.5 SP15 Patch 3：打开工程副本、`create_pou("PLC_PRG")`、`save()`，冷启动约 60–90 s。
- 严格成功判定：退出码 0 但无 `result.json` → `ok:false, resultMissing:true`；GUI 早退 →
  `started:false`。
- 自检脚本 `plugin/scripts/selfcheck.mjs` 覆盖以上全部路径（`SELFCHECK_SKIP_IDE=1` 只测加载/注册）。

API 细节见 [`docs/api-verified.md`](docs/api-verified.md)，实现细节见
[`docs/architecture.md`](docs/architecture.md)。

## 已知限制

- 仅 Windows + 本机安装的两个 IDE（路径可配置）。
- IDE 子进程同样受会话沙箱约束；`workspace-write` 下若 IDE 需要写工作区外，会出现“启动器退出 0
  但无结果”，此时用 `danger-full-access` 或把 scratch/workspace 放进工作区。
- CODESYS API 随 SP 版本变化；速查表针对 **3.5 SP15 Patch 3** 验证。
- 实验请用工程副本：CODESYS 打开工程期间会锁文件；Modelio GUI 与批处理实例同时操作同一工程可能冲突。

## 开发与自检

```bash
node plugin/scripts/selfcheck.mjs                     # 全量：注册 + 两个 IDE + 回滚回归
SELFCHECK_SKIP_IDE=1 node plugin/scripts/selfcheck.mjs   # 只验证加载与注册
```

`lib/index.js` 是自包含 ESM（不 import 任何包），工具参数用原生 JSON Schema 直接交给
`ctx.tools.register`，因此换安装目录、换节点都能加载。`docs/architecture.md` 末尾说明了从
“动态插件版本”迁移到本包的构建方式。

## 卸载

删除 patch 里的 `- insert:` 条目（或整个 patch 文件）并重启；如用方式 C 安装，
`dsh plugin --profile web remove dsh-tool-app-bridge`。scratch 目录可随时整体删除。

## License

MIT（与仓库一致，见根目录 `LICENSE`）。
