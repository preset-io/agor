# agor-live

**Multiplayer canvas for orchestrating AI coding sessions**

Agor is a real-time collaborative platform for managing Claude Code, Codex, and Gemini AI coding sessions. Visualize work on spatial boards, track git branches, and collaborate with your team.

## Installation

Requires Node.js ≥ 22.12 and Git on `PATH`. HTTPS remotes also require a working system CA trust store; SSH remotes require an SSH client and configured keys or agent access.

```bash
npm install -g agor-live
```

Prefer one command that also runs the steps below? `curl -fsSL https://agor.live/install.sh | bash` — [view the script](https://github.com/preset-io/agor/blob/main/apps/agor-docs/public/install.sh) first, same as you should for any `curl | bash` installer. Prefer Homebrew on macOS or Linux? See the main docs for the brew install path.

## Quick Start

```bash
# 1. Initialize Agor, choose agentic tools, and install their aligned packages
agor init

# 2. Start the daemon
agor daemon start

# 3. Open UI in browser
agor open
```

Later, `agor install` changes or repairs the selected agentic-tool packages without initializing or
recreating Agor.

## Features

- **Multi-Agent Support**: Claude Code, OpenAI Codex, Google Gemini
- **Git Integration**: Branch-based workflows with branch management
- **Spatial Boards**: Visual canvas for organizing sessions and tasks
- **Real-time Collaboration**: WebSocket-powered multiplayer features
- **Task Tracking**: First-class task primitives with genealogy
- **MCP Integration**: Model Context Protocol server management

## Documentation

- **GitHub**: https://github.com/preset-io/agor
- **Docs**: https://agor.live

## License

BSL-1.1
