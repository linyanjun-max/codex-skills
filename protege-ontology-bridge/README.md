# protege-ontology-bridge — Protégé OWL 本体工具桥

**用一句话说清楚**：让 Agent 不点 Protégé 界面，也能**建 OWL 2 本体、跑 HermiT 推理、执行 DL 查询、
生成带图和表格的实验报告**。适合本体建模课程实验、知识库原型、以及"把领域知识形式化成可推理模型"。

> 这是 **DSH（DeepSeek Harness）插件**，不是纯 `SKILL.md` 技能。真正的能力在 [`plugin/`](plugin/)；
> Agent 侧的使用流程见 [`SKILL.md`](SKILL.md)。

## 它解决什么问题

Protégé 只有图形界面，没有命令行/RPC；OWL API 与 HermiT 又只提供 Java 库。本桥在中间加一层：
Agent 写一份**声明式本体规格（JSON）**，桥把它变成真正的 OWL 文件，用 Protégé 自带的 HermiT 做
逻辑推理，再把结果整理成结构化 JSON 与可直接提交的报告。

| 工具 | 作用 |
| --- | --- |
| `onto_status` | 探测 Protégé / JVM / HermiT / jpype / 缓存，判断工具链是否就绪 |
| `onto_check` | 只校验 spec（不启 JVM）：引用是否解析、有无环、数据类型是否对、作业数量红线 |
| `onto_build` | spec → `.owl`（RDF/XML，由 OWL API 写出，Protégé 打开无警告） |
| `onto_reason` | **真跑 HermiT**：一致性、不可满足类、推断类层次、个体推断类型、DL 查询答案 |
| `onto_report` | 三张图（推断类树、概念图、查询结果）+ 俄文 DOCX 报告 |
| `onto_all` | 一条龙：本体 + 推理结果 + 图 + 报告 |
| `onto_help` | spec 字段与 Manchester 语法的速查 |

## 已验证的能力（本机实测）

- Protégé **5.6.9** + 内置 **Temurin JRE 11** + **HermiT 1.4.3**，无 javac 也能推理（JPype 直连 JVM）。
- 25 个类 / 7 个对象属性 / 5 个数据属性 / 12 个个体的本体，HermiT 判为**一致**，无不可满足类。
- 推断出**非平凡新知识**：例如"有未处理泄漏的压缩机"被自动归入 `CriticalEquipment`，并被进一步归入
  `EquipmentWithFailure`。
- 5 条 Manchester 语法的 DL 查询全部返回合理结果（含 `some`、`and`、`or`、括号、定义类）。
- 生成的 `.owl` 经 OWL API 存盘→重载往返验证；生成的 DOCX 9 页、6 表 3 图，封面沿用已提交报告样式。
- 两种安装位置（工作区内、`$DSH_HOME/plugins/` 内）都能通过 `scripts/selfcheck.mjs --full`。

## 架构

```
Agent ──tool call──▶ DSH host ──plugin/lib/index.js──▶ python engine/cli.py <subcommand>
                                                          │
                                        ┌─────────────────┼──────────────────┐
                                   spec.py            onto.py            reasoner.py
                                （校验/统计）      （→ OWL API）        （HermiT）
                                                          │                  │
                                                     ontology.owl      reasoning.json
                                                          └──── report.py ────┘
                                                            （matplotlib + python-docx）
```

关键实现点：

- **JVM 引导**：`jvm.py` 用 `%LOCALAPPDATA%\onto-engine\cache` 存放解包后的嵌套 jar 与 quiet logback 配置。
- **嵌套 jar 解包**：OWL API 的依赖在 jar 内 `lib/*.jar`，HermiT 的 `automaton-*.jar` 在 jar 根，两者都要解。
- **URI 编码**：用 `java.io.File.toURI()` 处理含西里尔/中文字符的路径，避免 `URISyntaxException`。
- **字面值按 range 生成**：`xsd:float` 属性写 `96.5` 时若生成 `xsd:double` 会直接导致本体不一致。
- **只允许正向定义类**：开放世界假设下"没有某关系"不可推断，报告里也解释了这一点。

## 安装

插件有三种装法，**只能选一种**（同一 row id 插入两次会报 loader 错误）：

```yaml
# $DSH_HOME/cordis.patch.yml
- insert:
    - id: protege-ontology-bridge
      name: './plugins/protege-ontology-bridge/lib/index.js'
```

把本仓库的 `plugin/` 目录复制成 `$DSH_HOME/plugins/protege-ontology-bridge/`，重启 DSH 即可。
也可以用 `dsh plugin --profile web add <plugin 目录>` 作为插件包安装。细节见
[`plugin/README.md`](plugin/README.md)。

依赖：Python 3 + `jpype1`、`matplotlib`、`python-docx`、`networkx`；Protégé 5.6.x。

## 快速示例

`spec.json`（节选）：

```json
{
  "iri": "http://www.semanticweb.org/example/equipment-maintenance",
  "classes": [
    {"name": "Equipment", "comment": "Эксплуатируемое оборудование"},
    {"name": "Pump", "parent": "Equipment", "comment": "Насосный агрегат"}
  ],
  "objectProperties": [
    {"name": "hasFailure", "domain": "Equipment", "range": "Failure", "inverse": "isFailureOf"}
  ],
  "classAxioms": [
    {"subject": "EquipmentWithFailure", "kind": "equivalentTo",
     "expression": "Equipment and hasFailure some Failure"}
  ],
  "queries": [
    {"name": "Q1", "expression": "Equipment and hasFailure some Failure", "ask": "individuals"}
  ]
}
```

调用：

```text
onto_all { "spec": "D:/work/spec.json", "outdir": "D:/work/out" }
```

返回：

```json
{ "ok": true, "consistent": true, "owl": "D:/work/out/ontology.owl",
  "queries": [{"name": "Q1", "count": 3, "entities": ["Compressor_402", "Conveyor_310", "Pump_101"]}],
  "report": {"docx": "D:/work/out/report.docx", "tables": 6, "figuresCount": 3} }
```

## 已知限制

- **不生成 Protégé 界面截图**：推理数字是真的，但没有 GUI 截图。需要截图时用生成的 `.owl` 在 Protégé
  里打开一次（Reasoner → HermiT，再看 DL Query 页）。
- 报告模板复用**俄文课程报告**的封面与样式；换语言/换学校需要提供自己的 `.docx` 作为样式母本
  （`onto_report` 的 `template` 参数）。
- 大本体（>1000 类）未做性能验证；HermiT 对复杂否定/基数限制可能较慢。
- 只覆盖 Manchester 语法的一个子集：`A and B`、`A or B`、`not A`、`p some C`、`p only C`、
  `p value v`、括号；不支持基数限制（`min/max/exactly`）。

## 目录结构

```
protege-ontology-bridge/
  README.md             # 本文件：这是什么、怎么装、怎么用
  SKILL.md              # Agent 侧技能说明（何时用、标准流程、校验清单）
  docs/
    architecture.md     # 内部实现：JVM 引导、嵌套 jar、字面值、布局算法
    usage.md            # 分步用法与命令
    troubleshooting.md  # 常见报错与处置
    api-verified.md     # 实测过的 JPype / OWL API / HermiT 调用事实
    changelog.md
  plugin/               # DSH 插件本体（可直接安装）
```

## License

MIT，见仓库根目录 `LICENSE`。
