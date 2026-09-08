# Disco

Disco 是面向 Codex 的私有、多用户 Web 工作台，支持独立会话、持久 Agent、任务队列、附件、共享技能以及 Token 和费用统计。

本仓库保存独立开发所需的源代码、测试、数据库迁移、构建配置和静态资源。运行中的会话、账号、附件、数据库、凭据、依赖安装目录和构建缓存不属于源码仓库。

## 项目结构

| 目录 | 用途 |
| --- | --- |
| `apps/disco-ui` | React 浏览器界面 |
| `apps/disco-daemon` | API、认证、实时事件、任务调度和文件服务 |
| `apps/disco-cli` | 管理命令行 |
| `packages/core` | 类型、配置、数据库及共享逻辑 |
| `packages/executor` | Codex 执行和会话工作目录管理 |
| `packages/disco-*`、`packages/agentic-*` | 执行工具集成和发布包 |
| `apps/disco-docs` | 文档站、图片及演示资源 |
| `context`、`docs` | 架构说明与开发资料 |

## 获取和构建

需要 Node.js 22.12 或更新版本，以及 `package.json` 中指定的 pnpm 11.17.0。

```sh
git clone https://github.com/Reskip/Disco.git
cd Disco
pnpm install --frozen-lockfile
pnpm exec turbo run build typecheck --filter='!@disco/docs'
```

文档站单独构建：

```sh
pnpm --filter @disco/docs build
```

开发和测试入口：

```sh
pnpm dev
pnpm --filter disco-ui test
pnpm --filter @disco/daemon test
pnpm --filter @disco/core test
pnpm --filter @disco/executor test
```

运行服务前，需要配置自己的数据目录、数据库、认证密钥及 Codex 凭据。`.env.example` 提供 Docker 开发环境变量示例；不要把本机真实配置写入仓库。生产构建中的 UI 位于 `apps/disco-ui/dist`，部署时需要将其同步到 daemon 的 `apps/disco-daemon/ui` 目录。

GitHub Actions 中提供手动触发的 `Validate source` 工作流。此仓库未配置自动发布 npm 包、容器或网站。

## 当前产品约定

- 独立会话不依赖 Git 仓库或分支，也不自动获得 Agent 身份或记忆。
- 每个 Agent 拥有自己的持久工作目录、记忆和技能；其会话资源位于各自的会话子目录。
- 用户账号是文件访问的隔离边界；一个账号下的会话可以访问该账号自己的资源。
- Token 账本独立于会话内容的生命周期，删除或归档会话不应扣减历史用量。

更完整的开发约定见 [AGENTS.md](AGENTS.md)。`apps/disco-docs` 中保留了部分历史文档与演示素材；涉及当前行为时，以实现和 `context/concepts` 为准。

## 来源与许可

本项目基于 Preset, Inc. 的 Agor 代码定制，保留原有版权与 Business Source License 1.1 许可文本。来源信息见 [NOTICE](NOTICE)，完整条款见 [LICENSE](LICENSE)。
