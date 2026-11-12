# 使用手册（怎么用）

面向“要完成一件具体的事”的读者。所有示例都是工具调用参数；`\n` 是脚本里的换行。

## 0. 安全起步：先探测、再只读、后写入

```text
bridge_status {}
```

关注字段：

| 字段 | 用途 |
| --- | --- |
| `codesys.profile` | 传给 `codesys_run` 的 Profile 名（探测不到时显式传 `profile`） |
| `modelio.version` / `modelio.defaultWorkspace` | 决定 `modelio_run` 的 workspace 默认值 |
| `scratch` | 运行目录根；`runDir` 都在这下面 |
| `policy.mode` | `danger-full-access` 时 IDE 可自由写；`workspace-write` 时要留意工作区边界 |
| `*.running` | 已打开 IDE 实例会与脚本模式冲突 |

接着用 `save:false` 或 `script` 只做只读枚举，确认路径与对象名，再放开写操作。实验一律用工程副本。

## 1. Modelio

### 1.1 新建工程并建模型

```text
modelio_run {
  "create": "Demo",
  "workspace": "D:\\proj\\modelio-ws",
  "script": "from org.modelio.api.modelio import Modelio\nmi = Modelio.getInstance()\nms = mi.getModelingSession()\nmodel = ms.getModel()\nroot = [r for r in model.getModelRoots() if 'Standard.Project' in str(r)][0]\nrootpkg = [c for c in root.getCompositionChildren() if 'Package' in str(type(c))][0]\nmodel.createPackage('Design', rootpkg)\nRESULT = {'ok': True}"
}
```

要点：

- `create` 新工程、`project` 已存在工程；工具会先检查，避免 `-create` 撞已有目录。
- workspace 不存在会自动创建。
- **模型根不是 NameSpace**：`model.getModelRoots()` 返回 `[LocalModule, <Project>]`，`createPackage(name, project)`
  会抛类型错误；必须从 `root.getCompositionChildren()` 里取根 `Package`。

### 1.2 在已有工程里编辑

```text
modelio_run {
  "project": "Demo",
  "workspace": "D:\\proj\\modelio-ws",
  "script": "from org.modelio.api.modelio import Modelio\nms = Modelio.getInstance().getModelingSession()\nmodel = ms.getModel()\nroot = [r for r in model.getModelRoots() if 'Standard.Project' in str(r)][0]\nrootpkg = [c for c in root.getCompositionChildren() if 'Package' in str(type(c))][0]\ndesign = [c for c in rootpkg.getCompositionChildren() if 'Design' in str(c)][0]\ncls = model.createClass('Tank', design)\nop = model.createOperation('fill', cls)\nRESULT = {'class': str(cls)}"
}
```

事务与保存由包装器处理：脚本成功 → commit + `coreSession.save(None)`；脚本抛错 → rollback + 不保存。

### 1.3 只读检查（不写盘）

```text
modelio_run {
  "project": "Demo",
  "workspace": "D:\\proj\\modelio-ws",
  "save": false,
  "script": "from org.modelio.api.modelio import Modelio\nms = Modelio.getInstance().getModelingSession()\nmodel = ms.getModel()\nroot = [r for r in model.getModelRoots() if 'Standard.Project' in str(r)][0]\nRESULT = {'roots': [str(r) for r in root.getCompositionChildren()]}"
}
```

### 1.4 审计与 XMI

```text
modelio_run {
  "project": "Demo",
  "workspace": "D:\\proj\\modelio-ws",
  "save": false,
  "script": "from org.modelio.api.modelio import Modelio\nmi = Modelio.getInstance()\nRESULT = {'has_audit': hasattr(mi, 'getAuditService'), 'has_xmi': hasattr(mi, 'getExchangeService')}"
}
```

`mi.getExchangeService().exportXmiFile(...)` / `importXmiFile(...)` 是 XMI 通道；具体签名用
`dir(mi.getExchangeService())` 确认后再调用。

### 1.5 打开 GUI 人工检查

```text
bridge_launch_gui { "app": "modelio", "project": "Demo", "workspace": "D:\\proj\\modelio-ws" }
```

## 2. CODESYS

### 2.1 打开工程、看结构

```text
codesys_run {
  "script": "proj = projects.open(r'D:\\work\\demo.project')\nRESULT = {'children': [str(c.get_name()) for c in proj.get_children(False)]}",
  "timeoutSec": 300
}
```

### 2.2 建 POU 并保存

```text
codesys_run {
  "script": "proj = projects.open(r'D:\\work\\demo.project')\npou = proj.create_pou('PLC_PRG')\nproj.save()\nRESULT = {'pou': str(pou)}",
  "timeoutSec": 300
}
```

`.NET` 对象不支持 `dir()`，要反射：`sorted(set(str(m.Name) for m in proj.GetType().GetMethods()))`。

### 2.3 仿真：登录、运行、读写变量

```text
codesys_run {
  "script": "proj = projects.open(r'D:\\work\\demo.project')\napp = online.create_online_application(proj.active_application)\napp.login(True)\napp.start()\nRESULT = {'started': True}",
  "timeoutSec": 300
}
```

- `login` 就是编译+下载；编译错误会以脚本异常返回。
- 需要模拟设备（例如 CODESYS Control Win V3 x64 的 Simulation 模式），否则登录真实网关会失败。
- `set_prepared_value` / `read_value` / `stop` / `logout` 在 SP15 属文档常见接口，批量使用前先用
  `getattr`/反射确认签名。

### 2.4 保存归档与导出

```text
codesys_run {
  "script": "proj = projects.open(r'D:\\work\\demo.project')\nproj.save_archive(r'D:\\work\\backup.projectarchive')\nRESULT = {'archived': True}",
  "timeoutSec": 300
}
```

## 3. 怎么读返回

```json
{ "ok": true, "status": "ok", "result": {...},
  "transaction": "committed", "saved": true,
  "error": null, "resultMissing": false, "timedOut": false, "exitCode": 0,
  "runDir": "...", "scriptPath": "...", "stdout": "...", "stderr": "...",
  "competingInstance": null }
```

- `ok`：严格结论（见 README “返回语义”）。
- `result`：脚本里赋给 `RESULT` 的值。
- `runDir`：`user.py`（脚本）、`run.py`（包装器）、`run.cmd`（CODESYS）、`result.json`。
- `resultMissing: true`：IDE 没跑到包装器结尾，看 `hint`、`stderr`、`modelioLogTail`。
- `competingInstance` 非 null：先关掉已运行的 IDE。

## 4. 典型故障与动作

| 现象 | 动作 |
| --- | --- |
| `resultMissing: true` | 看 `hint`/`stderr`/`modelioLogTail`；确认会话是否 `workspace-write` 阻止 IDE 写工作区外；必要时换 `danger-full-access` 或把 scratch/workspace 放进工作区 |
| `competingInstance` 有值 | 关闭对应 IDE 后重试 |
| CODESYS 超时 | `timeoutSec` 调到 300–600（冷启动 60–90 s） |
| `profile` 未探测 | `bridge_status` 看 profile，或显式传 `profile` |
| Modelio 项目不存在 | 用 `create`，或确认 `workspace` + 工程名 |
| GUI `started:false` | 看 `exitCode`/`stderr`（exe 路径或环境问题） |
| 脚本报错但想保留部分修改 | 不要依赖失败现场：把脚本拆成多个成功步骤，或捕获异常后自行决定（包装器只会在未抛错时提交） |

## 5. 建议的工作流

1. `bridge_status` → 2. 只读枚举 → 3. 小步写（每步一次调用，检查 `ok`/`transaction`）→
4. 需要人工确认时 `bridge_launch_gui` → 5. 清理 scratch 里的历史运行目录。
