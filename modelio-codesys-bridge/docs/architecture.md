# 架构与实现（怎么做出来的）

本文说明这个插件是怎么被 DSH 加载的、运行一次工具调用时发生了什么、以及每个“坑”对应的
工程决定。目标是让维护者能在不重新摸索的情况下修改它。

## 1. 它是什么形态的插件

DSH 的每个能力都是 composition 里的一行（`cordis.yml` / patch 文件里的 entry）。这个包是
**host 平面的工具插件**：

- 它不发布 service，只往 host 的 `tools` 注册表里注册 5 个工具；
- 注册表是进程级单例，所以一个实例服务所有会话（不需要 per-session 副本，也不需要 `isolate` realm）；
- 它依赖 host 已提供的 `fs`、`subprocess`、`timer` 三个 service，以及可选的 `sandboxPolicy`、`agents`。

模块形态是普通 ESM，`apply(ctx, config)` 是唯一入口：

```js
export const name = 'modelio-codesys-bridge'
export const inject = ['fs', 'subprocess', 'timer']
export function apply(ctx, config) { /* ... */ }
```

不写 `Config` schema：行上的 `config`（`codesysRoot`/`modelioRoot`/`scratchDir`）由 `apply`
自行合并默认值，减少对外部 schema 库的依赖。

## 2. 它是怎么被加载的：patch 语义

DSH 的 profile 由“每个 bundle 的 patch + profile 自己的 `cordis.patch.yml` + `$DSH_HOME/cordis.patch.yml`
（用户级）+ `--patch` overlay”依次叠加在空列表上得到。一个 patch 条目长这样：

```yaml
- insert:
    - id: modelio-codesys-bridge
      name: './plugins/modelio-codesys-bridge/lib/index.js'
```

关键点：

1. `insert` 里的 entry 被追加到根列表（或 `id` 指定的 group 内）。
2. `name` 以 `./`、`../` 或绝对路径开头时，加载器会**相对 patch 文件所在目录**解析成 `file:` URL。
   这就是为什么本地包不必进 npm：`$DSH_HOME/cordis.patch.yml` 里的 `./plugins/...` 会变成
   `file:///.../harness/plugins/modelio-codesys-bridge/lib/index.js`。
3. 非 insert 的 patch 需要 `id`，用于改 `config`/`disabled`；同一 `id` 插入两次会得到
   duplicate loader entry 错误，所以安装方式必须三选一。
4. `!!js` 表达式在 patch 里可用（本项目没有用到，保持可读）。

验证组合是否正确，不需要启动应用：

```bash
dsh --profile web --dump-config        # 打印组合后的树
```

`dump-config` 与真实启动共用同一套 patch 逻辑，所以它出现在输出里、且没有 error，就说明入口与
参数能被识别。真正的模块导入还要等应用启动。

## 3. 一次工具调用的生命周期

以 `modelio_run` 为例：

```
1. detect()                    安装信息缓存 + 本次调用的 policy/scratch 解析
2. makeRunDir()                <scratch>/modelio/<stamp>/   （通过 fs 写入 .dsh-keep 建目录）
3. stageUserScript()           写 user.py（或直接用 scriptPath）
4. writeWrapper()              写 run.py：ASCII 包装器
5. spawn modelio.exe           -workspace <ws> -project|-create <p> -batch run.py
6. wait（可超时）               超时则 terminate
7. readResult()                读 result.json（不存在 → null）
8. report()                    严格 ok + 证据字段（缺结果时附 hint / 日志尾部）
```

### 3.1 包装器（run.py）为什么存在

IDE 的脚本执行入口只接受一个文件，而我们需要：注入参数、捕获 `print`、把异常变成结构化结果、
决定事务提交/回滚、以及保证“无论发生什么都留下结果文件”。包装器就是这层胶水。核心结构：

```python
_status = u'ok'
_G = {}
_tx = None
try:
    if _APP == u'modelio':
        from org.modelio.api.modelio import Modelio
        _MS = Modelio.getInstance().getModelingSession()
        _MROOTS = _MS.getModel().getModelRoots()      # 先触碰模型，事务才可靠激活
        _tx = _MS.createTransaction(u'modelio-codesys-bridge batch')
    for _n in ('system','projects','online','librarymanager','Modelio','modelingSession','selectedElements','coreSession'):
        try: _G[_n] = eval(_n)
        except: pass
    _G['ARGS'] = _ARGS
    execfile(_USER, _G)
    _status = u'ok'
except SystemExit:
    _status = u'ok'
except:
    _status = u'error'; _error = traceback.format_exc()
finally:
    if _tx is not None:
        if _status == u'ok': _tx.commit()
        else: _tx.rollback()
    if _APP == u'modelio' and _SAVE and _status == u'ok':
        eval(u'coreSession').save(None)
    open(_RES).write(json.dumps({...}))
```

几个不显然的决定：

- **先 `getModelRoots()` 再 `createTransaction()`**：在 Modelio 4.1 里，过早创建的事务不会真正
  激活，后面会报 `no active transaction`；先触碰模型再开事务才稳定。
- **`execfile` 而不是内联字符串**：内联字符串方案要求转义任意用户代码；`execfile` 让用户脚本
  以文件形式编译（编码声明照常生效）。
- **`_G` 受控注入**：只注入已知全局，避免把包装器内部变量泄漏给用户脚本。
- **`_status` 决定事务**：这是 1.0.1 修掉的最重要 bug——早期版本无条件 commit，会把脚本失败前
  做了一半的修改写进工程。
- **保存只在成功后**：回滚之后保存没有意义，还会把脏状态固化。

### 3.2 为什么包装器是纯 ASCII

Modelio 的 `-batch` 读取脚本时按系统字符集解码（本机是 GBK 环境），非 ASCII 内容可能被解错；
而 Jython 又拒绝“内联 Unicode 字符串里的 coding 声明”。解决办法是把路径、参数、脚本名全部用
`pyStr()` 转成 `u'...'` 形式的 ASCII 字面量（非 ASCII 一律 `\uXXXX`）。用户脚本本身单独落盘，
由 `execfile` 读取，编码声明正常工作。

### 3.3 为什么 CODESYS 要走 run.cmd

CODESYS 在 `--noUI` 下要求参数是**字面量** `--profile="CODESYS V3.5 SP15 Patch 3"`（引号属于值）。
Node 在 Windows 上把 argv 拼接成命令行时会转义引号，CODESYS 的解析器拿到的形式不对，于是报
“必须使用 --profile=\"profile name\"”。把完整命令行写进 `run.cmd`，再用 `cmd /c` 执行，就能保证
命令行逐字节不变；`cmd` 继承父进程的 stdio，收集输出不受影响。

### 3.4 成功判定与诊断

`report()` 的字段是一次调用的完整证据：

```js
const ok = !resultMissing
  && payload.status === 'ok'
  && !payload.transaction_error
  && !payload.save_error
  && !spawned.timedOut
  && spawned.outcome.exitCode === 0
```

为什么不用“退出码 0 就是成功”：IDE 启动器可能成功退出而脚本根本没跑完（例如沙箱拒绝写工作区外）。
所以成功必须有**正向证据**（`result.json` 里 status=ok）。缺结果时附带：

- `hint`：解释可能原因；
- `modelioLogTail`：最新 `modelio-*.log` 的尾部（Modelio 的失败经常只出现在日志里）；
- `competingInstance`：运行前检测到已打开的 IDE 实例时给出警告（脚本模式与 GUI 实例冲突常见）。

### 3.5 沙箱与路径

- 所有写入通过 host 的 `fs` 服务完成，并显式传入 `sandboxPolicy.resolve({session})` 得到的策略；
  这样插件的写入行为与 Agent 自己的文件工具一致。
- `scratch` 与 `policy` **每次调用重新解析**：`workspace-write` 下 scratch 落在
  `workspaceRoot/.dsh/modelio-codesys-bridge`，`danger-full-access` 下落在 `%USERPROFILE%\.dsh\modelio-codesys-bridge`。
  早期版本把整个配置缓存起来，切换工作区后仍用旧目录，1.0.1 已修。
- 目录创建不复用 `cmd mkdir`（引号转义问题），而是写一个 `.dsh-keep` 空文件——`fs.writeText`
  的原子写入自带 `mkdir -p` 父目录，行为稳定且受同一条策略约束。

## 4. 包结构与构建方式

```
dsh-tool-modelio-codesys-bridge/
  package.json          name/version/exports/files + dsh.bundle.patch
  cordis.patch.yml      bundle patch（方式 C 用）
  lib/index.js          插件本体（自包含，约 900 行）
  scripts/selfcheck.mjs fake host ctx + 真实 IDE 的端到端自检
  README.md
```

`lib/index.js` 由早期“动态 Cordis 插件”版本机械迁移而来：保留经过实测的包装器、路径处理与
运行逻辑，把 `harness.defineTool/registerTool` 换成原生 `ctx.tools.register` + JSON Schema，
把 `harness` 沙箱里的 `ctx.get(...)`/`ctx.effect`/`ctx.timeout` 换成真实 Cordis 语义。
迁移脚本没有随包保留（一次性使用），维护时直接改 `lib/index.js` 并用自检回归即可。

## 5. 自检覆盖了什么

`scripts/selfcheck.mjs` 用一个最小 fake ctx 适配 `fs`/`subprocess`/`timer` 三个 service 的契约，
直接 `import` 模块并调用 `apply`，然后：

1. 断言 5 个工具注册；
2. `bridge_status` 能识别两个 IDE；
3. **严格成功**：用一个只 `exit 0` 的假启动器跑 `codesys_run`，必须 `ok:false, resultMissing:true`；
4. **GUI 早退**：用瞬间退出的进程跑 `bridge_launch_gui`，必须 `started:false`；
5. **真实 CODESYS**：跑一段脚本并检查 `ok`；
6. **真实 Modelio**：建包成功、`transaction: committed`、`saved: true`；
7. **回滚回归**：脚本创建包后抛错，必须 `ok:false`、`transaction: rolled-back`、`saved:false`，
   且再次只读枚举时磁盘上不存在该包。

这些用例把“最容易误报成功”的路径全部钉死，也是后续修改的安全网。
