<img src=".github/logo_circle.png" alt="Agor Logo" width="160" />

# Agor

**所有代理事务的团队指挥中心。**

Agor 是一个共享画布，编码代理（Claude Code、Codex、Gemini）和长期运行的助手在隔离的 git worktree 上并行运行——它是会话、开发环境、提示和 PR 汇聚的锚定实体。你的整个团队实时围绕相同的工作协作，代理本身通过 MCP 驱动 Agor。

- **AI 代理的团队工作区** — 多代理协作，共享上下文
- **隔离的 git worktree** — 每个代理在自己的分支上工作
- **实时协作** — 团队成员可以看到所有代理的工作
- **MCP 驱动** — 代理通过 MCP 协议与 Agor 交互
- **持久化会话** — 会话在重启后仍然存在

## 快速开始

### 安装

```bash
npm install -g agor
```

### 初始化项目

```bash
cd your-project
agor init
```

### 启动 Agor

```bash
agor start
```

## 功能特性

### 多代理协作

在同一项目上运行多个 AI 代理，每个代理在自己的隔离环境中工作：

```bash
# 启动 Claude Code 代理
agor agent start claude-code

# 启动 Codex 代理
agor agent start codex

# 启动 Gemini 代理
agor agent start gemini
```

### 共享画布

所有代理的工作都显示在共享画布上，团队成员可以实时查看：

- 代码更改
- 终端输出
- 文件操作
- PR 状态

### MCP 集成

代理通过 MCP 协议与 Agor 交互：

```json
{
  "mcpServers": {
    "agor": {
      "command": "agor",
      "args": ["mcp"]
    }
  }
}
```

### Git Worktree 隔离

每个代理在自己的 git worktree 中工作，避免冲突：

```bash
# 查看所有 worktree
agor worktree list

# 清理旧的 worktree
agor worktree clean
```

## 配置

在项目根目录创建 `agor.config.json`：

```json
{
  "agents": {
    "claude-code": {
      "enabled": true,
      "worktree": true
    },
    "codex": {
      "enabled": true,
      "worktree": true
    }
  },
  "shared": {
    "context": true,
    "canvas": true
  }
}
```

## 命令

| 命令 | 说明 |
|------|------|
| `agor init` | 初始化项目 |
| `agor start` | 启动 Agor |
| `agor agent start <name>` | 启动代理 |
| `agor agent stop <name>` | 停止代理 |
| `agor worktree list` | 列出 worktree |
| `agor worktree clean` | 清理 worktree |
| `agor mcp` | 启动 MCP 服务器 |

## 开发

```bash
git clone https://github.com/preset-io/agor.git
cd agor
npm install
npm run dev
```

## 许可证

Apache 2.0
