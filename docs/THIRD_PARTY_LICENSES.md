# 第三方许可证索引

本页是源码仓库的集中索引，不替代发行目录中的完整法律通知。每个已支持平台的发行目录必须包含由构建
脚本生成的 `THIRD_PARTY_LICENSES.txt`，其大小和 SHA-256 写入 `release-manifest.json` 并由发行 smoke
验证。源码基准位于 [`release/THIRD_PARTY_LICENSES.txt`](../release/THIRD_PARTY_LICENSES.txt)。

## 发行版共享组件

| 组件                                   | 固定版本          | 许可证             | 用途/分发边界                                                         |
| -------------------------------------- | ----------------- | ------------------ | --------------------------------------------------------------------- |
| Deno                                   | 2.9.2             | MIT                | 主 EXE Runtime；Function Runtime 以压缩的官方对应平台二进制分发       |
| Deno Standard Library                  | `@std/path` 1.1.5 | MIT                | 生产路径处理依赖                                                      |
| PGlite                                 | 0.5.4             | Apache-2.0         | Embedded 数据库 TypeScript/JavaScript 包；Apache-2.0 全文进入发行通知 |
| PGlite PostgreSQL-derived WASM Runtime | 随 PGlite 0.5.4   | PostgreSQL License | Embedded PostgreSQL 兼容执行 Runtime                                  |
| postgres.js                            | 3.4.9             | Unlicense          | Server/external PostgreSQL 驱动                                       |
| smol-toml                              | 1.7.0             | BSD-3-Clause       | `minibase.toml` 和 Supabase TOML 解析                                 |

PGlite 包的 `package.json` 和随包 `LICENSE` 声明 Apache-2.0；其 PostgreSQL-derived WASM Runtime 另受
PostgreSQL License 约束。两份许可证都必须存在，不能把它们描述为可任选其一。Apache-2.0 标准全文来源
保存在 [`release/APACHE-2.0.txt`](../release/APACHE-2.0.txt)。

## Server 发行版追加组件

Windows Server 构建从固定 PostgreSQL 18.4 Windows x64 Runtime 原始分发中复制 `server_license.txt` 与
`commandlinetools_3rd_party_licenses.txt`，并追加仓库中的 ICU 77.1 许可证。Linux Server 构建从固定
的六个 PGDG/Ubuntu 直接包和 37 个传递/许可证包提取 Debian copyright 通知，并把全部 43 个固定包的
包名和版本写入 `release-manifest.json`。通知只允许来自固定 package root；copyright 符号链接解析到根
目录之外会使构建失败。发行 smoke 至少验证以下通知存在：

- PostgreSQL 18.4 Windows x64 Runtime；
- OpenSSL；
- ICU 77.1 与 Unicode 数据；
- PostgreSQL 18.4 Linux x64 Runtime、PostgreSQL Database Management System 与对应动态库通知；
- 发行 manifest 中许可证文件的大小和 SHA-256。

Windows PostgreSQL Runtime 的裁剪排除文档、头文件、pgAdmin、StackBuilder 和静态库；Linux Runtime
排除文档、头文件、JIT、未使用客户端工具和 glibc，并保留运行时实际依赖的非 glibc 动态库。两个平台都
不允许通过裁剪许可证文件来缩小产物。

## 开发、测试与兼容性验证依赖

以下组件固定在仓库工具链中，用于测试或验证用户 Function，但由 `deno compile --exclude-unused-npm`
排除在 Minibase 主 EXE 的生产依赖图之外；用户项目自行携带的 Function 依赖也不作为 Minibase 发行组件
重新授权：

| 组件                    | 固定版本 | 许可证     | 用途                                        |
| ----------------------- | -------- | ---------- | ------------------------------------------- |
| `@supabase/supabase-js` | 2.110.9  | MIT        | 官方 Auth/REST/Storage/Functions 黑盒客户端 |
| `@supabase/server`      | 1.4.1    | MIT        | Supabase CLI Function 模板兼容 fixture      |
| `@std/assert`           | 1.0.14   | MIT        | 测试断言                                    |
| Supabase CLI            | 2.110.0  | Apache-2.0 | 生成并锁定兼容 fixture；不打包进产品        |

精确版本和审计日期见[版本策略](./VERSIONS.md)。npm/JSR 间接依赖以 `deno.lock` 为机器可读依据；新增会
进入发行依赖图的组件时，必须同时更新完整通知、此索引、发行 manifest/smoke 和版本审计，不能只在
README 中添加链接。

## 构建与审计规则

1. Embedded 与 Server 必须从同一共享通知生成许可证文件。
2. Server 只能在共享通知后追加 Runtime 原始通知，不得覆盖共享组件。
3. `release-manifest.json` 必须记录许可证文件名、字节数和 SHA-256。
4. 发行 smoke 必须读取最终文件并验证关键组件与完整 Apache-2.0 条款。
5. 许可证缺失、哈希不一致或组件版本与 `toolchain.json` 不一致时，发行验收失败。
