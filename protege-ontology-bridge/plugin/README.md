# dsh-tool-protege-ontology-bridge — Protégé / OWL 本体自动化桥（插件本体）

把 **Protégé 自带的 JVM、OWL API 和 HermiT** 包装成 DeepSeek Harness 的常驻工具：Agent 写一份
声明式的本体规格（JSON），插件负责建 OWL 2 本体、跑真正的 HermiT 推理、执行 DL 查询、画图并生成
俄文实验报告。

零依赖 ESM：`lib/index.js` 不 import 任何 npm 包；重活交给 `engine/`（Python 3）。

## 提供的工具

| 工具 | 作用 |
| --- | --- |
| `onto_status` | 探测 Protégé 安装、内置 JVM、HermiT jar、jpype 版本、jar 缓存、引擎路径、Python |
| `onto_check` | 只校验 spec（不启 JVM）：命名唯一性、父子/域/值域/类型引用、环、数据类型、作业最低数量提示 |
| `onto_build` | spec → `.owl`（由 OWL API 写出 RDF/XML，Protégé 打开无规范化警告），可另存 Turtle |
| `onto_reason` | HermiT：一致性、不可满足类、推断类层次、每个个体的推断类型、DL 查询答案 |
| `onto_report` | 三张图 + 8 节俄文 DOCX（复用已提交报告的封面与样式） |
| `onto_all` | 一条龙：`ontology.owl` + `reasoning.json` + `figures/` + `report.docx` |
| `onto_help` | 速查：工具流程、spec 字段、Manchester 语法 |

## 为什么必须这样实现（三个不显然的事实）

1. **没有 javac**。Protégé 自带的是 JRE（不是 JDK），所以不编译任何 Java：JPype 直接启动 Protégé 的
   JVM，调用 OWL API 与 HermiT 的类。
2. **OWL API 的依赖藏在嵌套 jar 里**。Protégé 以 OSGi 方式发布 OWL API，caffeine / rdf4j / jackson
   等依赖是 jar 内的 `lib/*.jar`（`Bundle-ClassPath`），HermiT 的 `automaton-*.jar` 则直接放在 jar 根。
   普通 classpath 看不见这些，所以引擎启动前把所有嵌套 jar 解包到缓存目录。
3. **Java 的 URI 不接受非 ASCII**。路径里有西里尔字母或中文时必须用 `java.io.File.toURI()`
   （百分号编码），而不是拼 `file:///`；缓存目录也因此放在 ASCII 路径下（`%LOCALAPPDATA%`）。

## 引擎（可脱离 DSH 独立使用）

```bash
python engine/cli.py status
python engine/cli.py check  --spec spec.json
python engine/cli.py build  --spec spec.json --out ontology.owl
python engine/cli.py reason --owl ontology.owl --spec spec.json --save-json reasoning.json
python engine/cli.py all    --spec spec.json --outdir out
```

每个子命令只往 stdout 打一个 JSON 对象，失败时 `ok: false` + `error`，插件原样转给 Agent。

依赖：`jpype1`、`matplotlib`、`python-docx`、`networkx`；Protégé 5.6.x（自带 JRE 11 与 HermiT 1.4.3）。

## 安装（三选一，同一 row id 只能插入一次）

### A. 用户级 patch（最简单）

`$DSH_HOME/cordis.patch.yml`：

```yaml
- insert:
    - id: protege-ontology-bridge
      name: './plugins/protege-ontology-bridge/lib/index.js'
```

并把本 `plugin/` 目录放到 `$DSH_HOME/plugins/protege-ontology-bridge/`。**重启 DSH 后生效。**

### B. 作为插件包

```bash
dsh plugin --profile web add <本 plugin 目录的绝对路径>
```

`package.json` 的 `dsh.bundle.patch` 会把包内 `cordis.patch.yml` 插进去。

### C. profile 级 patch

编辑 `$DSH_HOME/profiles/<name>/cordis.patch.yml`，同上加一行。

## 配置

```yaml
config:
  protegeHome: 'E:\Protege-5.6.9-win\Protege-5.6.9'  # 默认自动探测
  pythonExe:   'D:\anaconda\python.exe'              # 默认自动探测
  engineCli:   '.../engine/cli.py'                   # 默认相对本包
```

## 自检（不需要 DSH 在运行）

```bash
node scripts/selfcheck.mjs                # 注册 + status + spec 校验
node scripts/selfcheck.mjs --full spec.json   # 再跑 build + reason + report
```

## 报告文字可以按领域覆盖

报告正文默认是领域无关的表述，但课程作业需要具体领域文字。spec 里加一个可选的 `report` 对象即可覆盖，
键都是可选的：

```json
"report": {
  "subtitle": "副标题（封面第 3 行）",
  "domainTitle": "报告里用来称呼该领域的一句话",
  "scope": "第 1 节里“所选领域是……”的那段",
  "domain": ["第 4 节第 1 段", "第 4 节第 2 段", "第 4 节第 3 段"],
  "individualsNote": "6.2 节里对个体集合的说明",
  "queriesNote": "7.3 节里对查询意图的说明",
  "conclusions": ["第 8 节第 1 段", "第 8 节第 2 段", "第 8 节第 3 段"]
}
```

未提供的键会退回由本体自身推导的通用文字（顶层类名、计数、定义类名），所以同一个 spec 换领域不需要改代码。

## 两个必须知道的建模陷阱（引擎已处理，但报告里值得写）

- **`xsd:double` ≠ `xsd:float`**：断言写 `96.5` 默认生成 double 字面值；若属性 range 是 `xsd:float`，
  + `Functional` 会让 HermiT 判整个本体不一致。引擎按属性声明的 range 生成字面值。
- **开放世界假设下"没有某关系"推不出来**：`¬∃resolvedBy.MaintenanceAction` 无法由"未记录"推出，
  只能用作**正向**定义类（`ResolvedFailure ≡ Failure ⊓ ∃resolvedBy.MaintenanceAction`）。

## 限制

推理与查询是真跑 HermiT 得到的，数字可作为报告依据；但**插件不驱动 GUI**，没有 Protégé 界面截图。
需要截图时用生成的 `.owl` 在 Protégé 里手动打开（Reasoner → HermiT，再看 DL Query 页）。

## 目录结构

```
plugin/
  package.json          # 名称/入口/dsh.bundle 声明
  cordis.patch.yml      # 方式 B 使用的 bundle patch
  lib/index.js          # 插件本体（自包含）
  engine/               # Python 引擎
    jvm.py              # JVM 引导、嵌套 jar 解包、quiet logback
    spec.py             # spec 校验与统计
    onto.py             # spec → OWL（OWL API）
    manchester.py       # Manchester 表达式 → OWL 类表达式
    reasoner.py         # HermiT：一致性/层次/类型/查询
    report.py           # 图 + 俄文 DOCX
    cli.py              # 子命令入口（JSON in/out）
  scripts/selfcheck.mjs # 独立自检
```
