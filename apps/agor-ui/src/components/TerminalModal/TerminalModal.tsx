import type { AgorClient } from '@agor/core/api';
import type { User } from '@agor/core/types';
import { App, Modal } from 'antd';
import { useEffect, useRef, useState } from 'react';
import { Terminal } from 'xterm';
import { WebLinksAddon } from 'xterm-addon-web-links';
import 'xterm/css/xterm.css';

const OSC_SEQUENCE_START = '\u001B]8;';
const OSC_SEQUENCE_END = '\u001B]8;;\u0007';
const BELL = '\u0007';

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
  worktreeId?: string; // Worktree context for tmux integration
  initialCommands?: string[]; // Commands to execute after connection
}

export const TerminalModal: React.FC<TerminalModalProps> = ({
  open,
  onClose,
  client,
  user,
  worktreeId,
  initialCommands = [],
}) => {
  const { modal } = App.useApp();
  const terminalDivRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const [_terminalId, setTerminalId] = useState<string | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [sessionInfo, setSessionInfo] = useState<{
    tmuxSession?: string;
    tmuxReused?: boolean;
    worktreeName?: string;
  }>({});

  // Check if user has admin role
  const isAdmin = user?.role === 'admin' || user?.role === 'owner';

  useEffect(() => {
    if (!open || !terminalDivRef.current || !client) return;

    // Skip terminal setup for non-admin users
    if (!isAdmin) return;

    let mounted = true;
    let currentTerminalId: string | null = null;
    let transformData: (value: string) => string = (value) => value;
    const terminalService = client.service('terminals');

    const removeListeners = () => {
      terminalService.removeListener?.('data', handleData);
      terminalService.removeListener?.('exit', handleExit);
    };

    const handleData = (payload: unknown) => {
      if (!terminalRef.current || typeof payload !== 'object' || payload === null) {
        return;
      }
      const message = payload as Partial<{ terminalId: string; data: string }>;
      if (message.terminalId === currentTerminalId && typeof message.data === 'string') {
        terminalRef.current.write(transformData(message.data));
      }
    };

    const handleExit = (payload: unknown) => {
      if (!terminalRef.current || typeof payload !== 'object' || payload === null) {
        return;
      }
      const message = payload as Partial<{ terminalId: string; exitCode: number }>;
      if (message.terminalId === currentTerminalId && typeof message.exitCode === 'number') {
        terminalRef.current.writeln(`\r\n\r\n[Process exited with code ${message.exitCode}]`);
        terminalRef.current.writeln('[Close and reopen terminal to start a new session]');
      }
    };

    // Create terminal instance and connect to backend
    const setupTerminal = async () => {
      // Create xterm instance with larger size to fit modal
      // Custom theme with Agor teal (#2e9a92) for cyan
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
          background: '#000000',
          foreground: '#ffffff',
          cursor: '#ffffff',
          cyan: '#2e9a92', // Agor teal - used for ANSI color code 36
          brightCyan: '#3db5ab', // Lighter teal for bright cyan - used for ANSI code 96
        },
      });

      terminal.open(terminalDivRef.current!);
      terminalRef.current = terminal;

      // Load Web Links addon for clickable URLs
      terminal.loadAddon(new WebLinksAddon());

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
          tmuxSession: string;
          tmuxReused: boolean;
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
          tmuxSession: result.tmuxSession,
          tmuxReused: result.tmuxReused,
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
        removeListeners();
        terminalService.on('data', handleData);

        // Listen for terminal exit
        terminalService.on('exit', handleExit);
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

    setupTerminal();

    return () => {
      mounted = false;
      // Cleanup terminal instance
      if (terminalRef.current) {
        terminalRef.current.dispose();
        terminalRef.current = null;
      }
      // Kill backend terminal session
      if (currentTerminalId) {
        client.service('terminals').remove(currentTerminalId).catch(console.error);
      }
      removeListeners();
      setTerminalId(null);
      setIsConnected(false);
      setSessionInfo({});
    };
  }, [open, client, initialCommands, isAdmin, worktreeId]);

  const handleClose = () => {
    if (isConnected) {
      modal.confirm({
        title: 'Close Terminal?',
        content:
          'The tmux session will continue running in the background. You can reconnect by reopening the terminal.',
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
