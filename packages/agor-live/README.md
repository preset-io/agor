# agor-live

**Multiplayer canvas for orchestrating AI coding sessions**

Agor is a real-time collaborative platform for managing Claude Code, Codex, and Gemini AI coding sessions. Visualize work on spatial boards, track git worktrees, and collaborate with your team.

## Installation

```bash
npm install -g agor-live
```

## Quick Start

```bash
# 1. Initialize Agor (creates ~/.agor/ and database)
agor init

# 2. Start the daemon
agor daemon start

# 3. Open UI in browser
agor ui open
```

## Features

- **Multi-Agent Support**: Claude Code, OpenAI Codex, Google Gemini
- **Git Integration**: Worktree-based workflows with branch management
- **Spatial Boards**: Visual canvas for organizing sessions and tasks
- **Real-time Collaboration**: WebSocket-powered multiplayer features
- **Task Tracking**: First-class task primitives with genealogy
- **MCP Integration**: Model Context Protocol server management

## Documentation

- **GitHub**: https://github.com/preset-io/agor
- **Docs**: https://agor.live

## License

BSL-1.1
