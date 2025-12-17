import type { AgorClient } from '@agor/core/api';
import type { User, UserID } from '@agor/core/types';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Terminal } from '@xterm/xterm';
import { App, Modal } from 'antd';
import { useEffect, useRef, useState } from 'react';
import '@xterm/xterm/css/xterm.css';

const OSC_SEQUENCE_START = '\u001B]8;';
const OSC_SEQUENCE_END = '\u001B]8;;\u0007';
const BELL = '\u0007';

// Feature flag for executor-based terminals
// Can be enabled via prop or eventually via config
const USE_EXECUTOR_TERMINAL = true;

const expandOscHyperlinks = (input: string): string => {
  let output = '';
  let index = 0;

  while (index < input.length) {
    const start = input.indexOf(OSC_SEQUENCE_START, index);
    if (start === -1) {
      output += input.slice(index);
      break;
    }

    output += input.slice(index, start);

    const paramUriStart = start + OSC_SEQUENCE_START.length;
    const firstBell = input.indexOf(BELL, paramUriStart);
    if (firstBell === -1) {
      output += input.slice(start);
      break;
    }

    const paramUriSegment = input.slice(paramUriStart, firstBell);
    const lastSemicolon = paramUriSegment.lastIndexOf(';');
    const rawUri =
      lastSemicolon === -1 ? paramUriSegment : paramUriSegment.slice(lastSemicolon + 1);
    const trimmedUri = rawUri.trim();

    const labelStart = firstBell + 1;
    const terminatorIndex = input.indexOf(OSC_SEQUENCE_END, labelStart);
    if (terminatorIndex === -1) {
      output += input.slice(labelStart);
      break;
    }

    const rawLabel = input.slice(labelStart, terminatorIndex);

    if (!trimmedUri) {
      output += rawLabel;
    } else if (rawLabel.includes(trimmedUri)) {
      output += rawLabel;
    } else {
      const trimmedLabel = rawLabel.trim();
      const safeLabel = trimmedLabel.length > 0 ? trimmedLabel : trimmedUri;
      output += `${safeLabel} (${trimmedUri})`;
    }

    index = terminatorIndex + OSC_SEQUENCE_END.length;
  }

  return output;
};

export interface TerminalModalProps {
  open: boolean;
  onClose: () => void;
  client: AgorClient | null;
  user?: User | null;
  worktreeId?: string; // Worktree context for Zellij integration
  initialCommands?: string[]; // Commands to execute after connection
  /** Use executor-based terminal (channel-based I/O) instead of service-based */
  useExecutor?: boolean;
}

export const TerminalModal: React.FC<TerminalModalProps> = ({
  open,
  onClose,
  client,
  user,
  worktreeId,
  initialCommands = [],
  useExecutor = USE_EXECUTOR_TERMINAL,
}) => {
  const { modal } = App.useApp();
  const terminalDivRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const [_terminalId, setTerminalId] = useState<string | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [sessionInfo, setSessionInfo] = useState<{
    zellijSession?: string;
    zellijReused?: boolean;
    worktreeName?: string;
  }>({});

  // Check if user has admin role
  const isAdmin = user?.role === 'admin' || user?.role === 'owner';

  useEffect(() => {
    if (!open || !terminalDivRef.current || !client) return;

    // Skip terminal setup for non-admin users
    if (!isAdmin) return;

    // Executor mode requires user to be logged in
    if (useExecutor && !user?.user_id) {
      console.error('[Terminal] Executor mode requires authenticated user');
      return;
    }

    let mounted = true;
    let currentTerminalId: string | null = null;
    let currentChannel: string | null = null;
    let transformData: (value: string) => string = (value) => value;
    const terminalService = client.service('terminals');
    const socket = client.io;

    // Cleanup functions for both modes
    const removeServiceListeners = () => {
      terminalService.removeListener?.('data', handleServiceData);
      terminalService.removeListener?.('exit', handleServiceExit);
    };

    const removeChannelListeners = () => {
      if (socket) {
        socket.off('terminal:output', handleChannelOutput);
        socket.off('terminal:exit', handleChannelExit);
        if (currentChannel) {
          socket.emit('leave', currentChannel);
        }
      }
    };

    // Service-based event handlers (legacy)
    const handleServiceData = (payload: unknown) => {
      if (!terminalRef.current || typeof payload !== 'object' || payload === null) {
        return;
      }
      const message = payload as Partial<{ terminalId: string; data: string }>;
      if (message.terminalId === currentTerminalId && typeof message.data === 'string') {
        terminalRef.current.write(transformData(message.data));
      }
    };

    const handleServiceExit = (payload: unknown) => {
      if (!terminalRef.current || typeof payload !== 'object' || payload === null) {
        return;
      }
      const message = payload as Partial<{ terminalId: string; exitCode: number }>;
      if (message.terminalId === currentTerminalId && typeof message.exitCode === 'number') {
        terminalRef.current.writeln(`\r\n\r\n[Process exited with code ${message.exitCode}]`);
        terminalRef.current.writeln('[Close and reopen terminal to start a new session]');
        setIsConnected(false);
      }
    };

    // Channel-based event handlers (executor mode)
    const handleChannelOutput = (payload: { userId: string; data: string }) => {
      if (!terminalRef.current) return;
      if (payload.userId === user?.user_id) {
        terminalRef.current.write(transformData(payload.data));
      }
    };

    const handleChannelExit = (payload: { userId: string; exitCode: number }) => {
      if (!terminalRef.current) return;
      if (payload.userId === user?.user_id) {
        terminalRef.current.writeln(`\r\n\r\n[Terminal exited with code ${payload.exitCode}]`);
        terminalRef.current.writeln('[Close and reopen terminal to start a new session]');
        setIsConnected(false);
      }
    };

    // Create xterm instance with common configuration
    const createTerminalInstance = () => {
      const terminal = new Terminal({
        allowProposedApi: true,
        fontSize: 14,
        fontFamily: 'Menlo, Monaco, "Courier New", monospace',
        cursorBlink: true,
        scrollback: 1000,
        rows: 40,
        cols: 160,
        linkHandler: {
          activate: (_event, uri) => {
            console.debug('[Terminal] Opening link', uri);
            window.open(uri, '_blank', 'noopener,noreferrer');
          },
          hover: () => {
            // no-op but ensures handler exists so OSC links get hover feedback
          },
        },
        theme: {
          // Ant Design dark theme colors
          background: '#141414', // colorBgContainer
          foreground: '#ffffff', // colorText
          cursor: '#2e9a92', // Agor teal
          cursorAccent: '#141414',

          // ANSI colors matching Ant Design palette
          black: '#000000',
          red: '#ff4d4f', // colorError
          green: '#52c41a', // colorSuccess
          yellow: '#faad14', // colorWarning
          blue: '#1890ff', // colorInfo
          magenta: '#eb2f96',
          cyan: '#2e9a92', // Agor teal (colorPrimary)
          white: '#f0f0f0',

          // Bright colors
          brightBlack: '#8c8c8c', // colorTextSecondary
          brightRed: '#ff7875',
          brightGreen: '#95de64',
          brightYellow: '#ffc53d',
          brightBlue: '#40a9ff',
          brightMagenta: '#f759ab',
          brightCyan: '#3db5ab', // Lighter teal
          brightWhite: '#ffffff',
        },
      });

      terminal.open(terminalDivRef.current!);
      terminalRef.current = terminal;

      // Load Web Links addon for clickable URLs
      const webLinksAddon = new WebLinksAddon((_event, uri) => {
        console.log('[Terminal] Link clicked:', uri);
        window.open(uri, '_blank', 'noopener,noreferrer');
      });
      terminal.loadAddon(webLinksAddon);

      return terminal;
    };

    // Setup executor-based terminal (channel I/O via Zellij)
    const setupExecutorTerminal = async () => {
      const terminal = createTerminalInstance();

      try {
        // Request executor terminal from daemon
        // This spawns an executor with zellij.attach if not already running
        const result = (await client.service('terminals').create({
          rows: 40,
          cols: 160,
          worktreeId,
          useExecutor: true,
        })) as {
          userId: UserID;
          channel: string;
          sessionName: string;
          isNew: boolean;
          worktreeName?: string;
        };

        if (!mounted) {
          return;
        }

        currentChannel = result.channel;
        setIsConnected(true);
        transformData = expandOscHyperlinks;
        setSessionInfo({
          zellijSession: result.sessionName,
          zellijReused: !result.isNew,
          worktreeName: result.worktreeName,
        });
        // Only clear for new sessions - reconnections will get screen via redraw
        if (result.isNew) {
          terminal.clear();
        }

        // Join the user's terminal channel
        socket.emit('join', result.channel);

        // Listen for terminal output via channel
        socket.on('terminal:output', handleChannelOutput);
        socket.on('terminal:exit', handleChannelExit);

        // Handle user input - send via channel
        terminal.onData((data) => {
          socket.emit('terminal:input', {
            userId: user?.user_id,
            input: data,
          });
        });

        // Handle terminal resize
        terminal.onResize(({ cols, rows }) => {
          socket.emit('terminal:resize', {
            userId: user?.user_id,
            cols,
            rows,
          });
        });

        // Send initial resize to trigger Zellij full redraw (important for reconnections)
        // This ensures the tab bar and status bar are properly rendered
        socket.emit('terminal:resize', {
          userId: user?.user_id,
          cols: terminal.cols,
          rows: terminal.rows,
        });

        // Execute initial commands if provided
        if (initialCommands.length > 0) {
          for (const cmd of initialCommands) {
            socket.emit('terminal:input', {
              userId: user?.user_id,
              input: `${cmd}\r`,
            });
          }
        }

        console.log(`[Terminal] Connected to executor terminal via channel: ${result.channel}`);
      } catch (error) {
        console.error('Failed to create executor terminal:', error);
        if (terminalRef.current) {
          terminalRef.current.writeln('\r\n❌ Failed to connect to Zellij terminal');
          terminalRef.current.writeln(
            `Error: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      }
    };

    // Setup service-based terminal (legacy PTY per terminal)
    const setupServiceTerminal = async () => {
      const terminal = createTerminalInstance();
      terminal.writeln('🚀 Connecting to shell...');

      try {
        // Create terminal session on backend
        const result = (await client.service('terminals').create({
          rows: 40,
          cols: 160,
          worktreeId,
        })) as {
          terminalId: string;
          cwd: string;
          zellijSession: string;
          zellijReused: boolean;
          worktreeName?: string;
        };

        if (!mounted) {
          // If unmounted during connection, clean up immediately
          client.service('terminals').remove(result.terminalId).catch(console.error);
          return;
        }

        currentTerminalId = result.terminalId;
        setTerminalId(result.terminalId);
        setIsConnected(true);
        transformData = expandOscHyperlinks;
        setSessionInfo({
          zellijSession: result.zellijSession,
          zellijReused: result.zellijReused,
          worktreeName: result.worktreeName,
        });
        terminal.clear();

        // Execute initial commands if provided
        if (initialCommands.length > 0) {
          for (const cmd of initialCommands) {
            // Send command with carriage return to execute
            client.service('terminals').patch(result.terminalId, { input: `${cmd}\r` });
          }
        }

        // Handle user input - send to backend
        // FeathersJS automatically uses WebSocket when available, REST as fallback
        terminal.onData((data) => {
          if (result.terminalId && client) {
            client.service('terminals').patch(result.terminalId, { input: data });
          }
        });

        // Listen for terminal output from backend
        removeServiceListeners();
        terminalService.on('data', handleServiceData);

        // Listen for terminal exit
        terminalService.on('exit', handleServiceExit);
      } catch (error) {
        console.error('Failed to create terminal:', error);
        if (terminalRef.current) {
          terminalRef.current.writeln('\r\n❌ Failed to connect to shell');
          terminalRef.current.writeln(
            `Error: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      }
    };

    // Choose setup based on mode
    if (useExecutor) {
      setupExecutorTerminal();
    } else {
      setupServiceTerminal();
    }

    return () => {
      mounted = false;
      // Cleanup terminal instance
      if (terminalRef.current) {
        terminalRef.current.dispose();
        terminalRef.current = null;
      }
      // Kill backend terminal session (service mode only)
      // In executor mode, the Zellij session persists
      if (currentTerminalId && !useExecutor) {
        client.service('terminals').remove(currentTerminalId).catch(console.error);
      }
      // Remove listeners based on mode
      if (useExecutor) {
        removeChannelListeners();
      } else {
        removeServiceListeners();
      }
      setTerminalId(null);
      setIsConnected(false);
      setSessionInfo({});
    };
  }, [open, client, initialCommands, isAdmin, worktreeId, useExecutor, user?.user_id]);

  const handleClose = () => {
    if (isConnected) {
      modal.confirm({
        title: 'Close Terminal?',
        content:
          'The Zellij session will continue running in the background. You can reconnect by reopening the terminal.',
        okText: 'Close',
        okType: 'primary',
        cancelText: 'Cancel',
        onOk: () => {
          onClose();
        },
      });
    } else {
      onClose();
    }
  };

  return (
    <Modal
      title={`Terminal${sessionInfo.worktreeName ? ` - ${sessionInfo.worktreeName}` : ''}`}
      open={open}
      onCancel={handleClose}
      footer={null}
      width="auto"
      styles={{
        body: {
          padding: '16px',
          background: '#000',
        },
      }}
      centered
    >
      {!isAdmin ? (
        <div style={{ padding: '24px', color: '#fff' }}>
          <p>
            Terminal access requires <strong>admin</strong> or <strong>owner</strong> role.
          </p>
          <p style={{ marginBottom: 0 }}>
            Terminal sessions run as the daemon's system user and can execute arbitrary code.
            Contact your Agor administrator to request elevated permissions.
          </p>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, color: '#fff' }}>
          <div ref={terminalDivRef} />
        </div>
      )}
    </Modal>
  );
};
