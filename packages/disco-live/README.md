# disco-live

**Multiplayer canvas for orchestrating AI coding sessions**

Disco is a real-time collaborative platform for managing Claude Code, Codex, and Gemini AI coding sessions. Visualize work on spatial boards, track git branches, and collaborate with your team.

## Installation

Requires Node.js ≥ 22.12 and Git on `PATH`. HTTPS remotes also require a working system CA trust store; SSH remotes require an SSH client and configured keys or agent access.

```bash
npm install -g disco-live
```

Prefer Homebrew on macOS or Linux? See the main docs for the brew install path.

## Quick Start

```bash
# 1. Initialize Disco, choose agentic tools, and install their aligned packages
disco init

# 2. Start the daemon
disco daemon start

# 3. Open UI in browser
disco open
```

Later, `disco install` changes or repairs the selected agentic-tool packages without initializing or
recreating Disco.

## Features

- **Multi-Agent Support**: Claude Code, OpenAI Codex, Google Gemini
- **Git Integration**: Branch-based workflows with branch management
- **Spatial Boards**: Visual canvas for organizing sessions and tasks
- **Real-time Collaboration**: WebSocket-powered multiplayer features
- **Task Tracking**: First-class task primitives with genealogy
- **MCP Integration**: Model Context Protocol server management

## Documentation

- **GitHub**: https://github.com/preset-io/disco
- **Docs**: https://disco.live

## License

BSL-1.1
