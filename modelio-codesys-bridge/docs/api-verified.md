# 已验证的 API 事实

针对本机 **Modelio 4.1.00** 与 **CODESYS 3.5 SP15 Patch 3** 的实测结论。版本不同要先复测；
`bridge_help` 工具内置了同一份速查。

## Modelio（Jython 2.7）

### 入口对象

```python
from org.modelio.api.modelio import Modelio
mi = Modelio.getInstance()
ms = mi.getModelingSession()
model = ms.getModel()
```

`mi` 的已确认成员：`auditService`、`diagramService`、`editionService`、`exchangeService`、
`getAuditService`、`getContext`、`getDiagramService`、`getEditionService`、`getExchangeService`、
`getImageService`、`getInstance`、`getLogService`、`getMetamodelService`、`getModelComponentService`、
`getModelManipulationService`、`getModelingSession`、`getModuleService`、`getNavigationService`、
`getPatternService`、`getPickingService`、`getScriptService`、`logService`、`modelingSession` 等。

`ms` 的已确认成员：`createTransaction`、`getModel`、`getRequirementModel`、`findElementById`、
`findByClass`、`findByAtt`、`addModelListener` 等——**没有 `save()`**。

### 模型根

```python
roots = model.getModelRoots()          # [LocalModule (Infrastructure.ModuleComponent), <项目> (Standard.Project)]
root  = [r for r in roots if 'Standard.Project' in str(r)][0]
rootpkg = [c for c in root.getCompositionChildren() if 'Package' in str(type(c))][0]
pkg = model.createPackage('Design', rootpkg)
cls = model.createClass('Tank', pkg)
```

`Standard.Project` **不是 NameSpace**，`createPackage(name, project)` 会报
`can't be coerced to NameSpace`；根 `Package` 必须从 `getCompositionChildren()` 里取。

### 事务与保存

```python
tx = ms.createTransaction('name')      # 返回 TransactionWrapper（commit/rollback/close）
...
tx.commit()                            # 或 tx.rollback()
```

- 事务**要先触碰模型再创建**，否则可能出现 `no active transaction`。
- 保存不是 API 方法，而是 `coreSession` 全局：`coreSession.save(None)`。
  `coreSession` 由 batch 运行器绑定，包装器会把它注入用户脚本。

### 失败与日志

- 脚本异常以 Jython traceback 形式回传（`error` 字段），Modelio 自身退出码可能仍是 0/负数。
- 真正的批处理失败常只出现在 `%USERPROFILE%\.modelio\4.1\modelio-*.log`；插件在缺失结果时自动附
  最新日志尾部。

## CODESYS（IronPython 2.7）

### 全局对象

`projects`、`system`、`online`、`librarymanager`。

- `projects`：`all`、`convert`、`create`、`get_by_path`、`open`、`open_archive`、`primary`
- `system`：`abort_autocheck`、`commands`、`dump_scripting_api`、`exit`、`get_messages`、
  `process_messageloop`、`ui`、`write_message`、`executable_filename` 等
- `online`：`create_online_application`、`create_online_device`、`gateways`、`auth_fallback_modes` 等
- `librarymanager`：`find_library`、`get_all_libraries`、`install_library`、`repositories` 等

### IScriptProject（SP15 反射结果）

`check_all_pool_objects`、`clean_all`、`close`、`compare_to`、`create_folder`、`document`、
`export_doc`、`export_native`、`export_xml`、`find`、`generate_runtime_system_files`、
`get_active_application`、`get_children`、`get_dirty`、`get_handle`、`get_library`、`get_path`、
`get_primary`、`get_project_info`、`get_project_settings`、`import_native`、`import_xml`、
`login`、`logout`、`save`、`save_archive`、`save_as`、`save_as_compiled_library`、
`set_active_application`，以及动态扩展的 `create_pou(name)`。

- **没有 `build()` / `compile()`**：编译在 `login`/下载时发生。
- `.NET` 对象上 Python `dir()` 返回空，用反射：

```python
proj = projects.open(r'C:\work\demo.project')
RESULT = sorted(set(str(m.Name) for m in proj.GetType().GetMethods()))
```

- 已实测：`projects.open`、`get_children(False)`、`create_pou('PLC_PRG')`、`save()`、
  `active_application`、`find(name, True)`、`create_folder`。

### 仿真

```python
app = online.create_online_application(proj.active_application)
app.login(True)        # 编译 + 下载；失败抛异常
app.start()
```

`set_prepared_value` / `write_prepared_values` / `read_value` / `stop` / `logout` 属文档常见用法，
本安装未逐项验证；批量使用前先 `getattr`/反射确认。登录需要模拟设备，否则会连到真实网关。

## 命令行形态

```text
CODESYS.exe --profile="CODESYS V3.5 SP15 Patch 3" --runscript="<run.py>" --noUI
modelio.exe -workspace <ws> (-project <name> | -create <name>) -batch <run.py> [-param k v]
```

- CODESYS 的 `--profile` 值必须带**字面量引号**，所以插件用 `run.cmd` 保证命令行逐字节不变。
- Modelio 的 `-workspace` 目录必须已存在；`-batch` 结束后工程会关闭，**不会自动保存**（需要
  `coreSession.save(None)`）。
- `-param` 可向脚本注入变量；本插件不用它，统一走 `ARGS`。

## 容易踩的坑（都已在实现中规避）

| 坑 | 规避方式 |
| --- | --- |
| Modelio 拒绝内联 coding 声明 | 包装器纯 ASCII，非 ASCII 用 `\uXXXX` |
| 无事务时修改模型报错 | 包装器触碰模型后创建事务 |
| 失败仍提交/保存 | 按 `_status` commit/rollback，成功后保存 |
| CODESYS 引号被 argv 改写 | 生成 `run.cmd` + `cmd /c` |
| 启动器退出 0 但脚本没跑 | 成功必须有 `result.json` 正向证据 |
| 跨工作区沿用旧 scratch | policy/scratch 每次调用重算 |
| 已开 IDE 实例冲突 | 报告里带 `competingInstance` 警告 |
