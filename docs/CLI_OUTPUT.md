# CLI 输出契约

Minibase CLI 默认输出稳定的人类可读键值格式；自动化脚本应显式使用 `--json`。

## Human 模式

对象字段按键名稳定排序，嵌套对象缩进两个空格，数组使用 `-`。例如：

```text
projectRoot: E:\work\example
runtime: null
state:
  components:
    minibaseCore: 1.0.0
    pglite: 0.5.4
    postgresRuntime: "18.4"
  createdAt: 2026-08-05T00:00:00.000Z
  database:
    postgresMajor: null
  engine: pglite
  formatVersion: 2
  minibaseVersion: 1.0.0
```

空对象和数组显示为 `{}` / `[]`，空值显示为 `null`。容易被误读为布尔值、数字或空值的字符串会加
双引号。换行、ANSI Escape、双向文本控制符和其他不可见格式控制字符会被转义，不允许用户数据改变
终端行结构或注入控制序列。

字段名称和缩进属于稳定契约；字段集合仍随相应命令的公开结果版本演进。脚本不应解析 human 输出。

## JSON 模式

`--json` 始终输出一行可解析 JSON，不添加标题、颜色或额外 stdout 文本：

```powershell
minibase status --project . --json
```

命令失败时错误消息写入 stderr，进程退出码保持非零。运行时服务日志与 CLI 命令结果是不同通道；启动
服务时仍应根据 `[logging].format` 选择控制台日志格式。

`doctor` 的 human 模式继续使用其专用 `[LEVEL] code` 诊断格式，因为该格式还承载逐项修复建议；
`doctor --json` 同样保持单行 JSON。
