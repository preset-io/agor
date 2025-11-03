import type { AgorClient } from '@agor/core/api';
import type { User } from '@agor/core/types';
import { Alert, App, Modal } from 'antd';
import { useEffect, useRef, useState } from 'react';
import { Terminal } from 'xterm';
import 'xterm/css/xterm.css';

export interface TerminalModalProps {
  open: boolean;
  onClose: () => void;
  client: AgorClient | null;
  user?: User | null;
  initialCommands?: string[]; // Commands to execute after connection
}

export const TerminalModal: React.FC<TerminalModalProps> = ({
  open,
  onClose,
  client,
  user,
  initialCommands = [],
}) => {
  const { modal } = App.useApp();
  const terminalDivRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const [_terminalId, setTerminalId] = useState<string | null>(null);
  const [isConnected, setIsConnected] = useState(false);

  // Check if user has admin role
  const isAdmin = user?.role === 'admin' || user?.role === 'owner';

  useEffect(() => {
    if (!open || !terminalDivRef.current || !client) return;

    // Skip terminal setup for non-admin users
    if (!isAdmin) return;

    let mounted = true;
    let currentTerminalId: string | null = null;

    // Create terminal instance and connect to backend
    const setupTerminal = async () => {
      // Create xterm instance
      const terminal = new Terminal({
        fontSize: 14,
        fontFamily: 'Menlo, Monaco, "Courier New", monospace',
        cursorBlink: true,
        scrollback: 1000,
        rows: 30,
        cols: 100,
      });

      terminal.open(terminalDivRef.current!);
      terminalRef.current = terminal;

      terminal.writeln('🚀 Connecting to shell...');

      try {
        // Create terminal session on backend
        const result = (await client.service('terminals').create({
          rows: 30,
          cols: 100,
        })) as { terminalId: string; cwd: string };

        if (!mounted) {
          // If unmounted during connection, clean up immediately
          client.service('terminals').remove(result.terminalId).catch(console.error);
          return;
        }

        currentTerminalId = result.terminalId;
        setTerminalId(result.terminalId);
        setIsConnected(true);
        terminal.clear();
        terminal.writeln(`✅ Connected! Working directory: ${result.cwd}`);
        terminal.writeln('');

        // Execute initial commands if provided
        if (initialCommands.length > 0) {
          for (const cmd of initialCommands) {
            // Send command with carriage return to execute
            client.service('terminals').patch(result.terminalId, { input: `${cmd}\r` });
          }
        }

        // Handle user input - send to backend
        terminal.onData((data) => {
          if (result.terminalId) {
            client.service('terminals').patch(result.terminalId, { input: data });
          }
        });

        // Listen for terminal output from backend
        client.service('terminals').on('data', ((message: { terminalId: string; data: string }) => {
          if (message.terminalId === result.terminalId && terminalRef.current) {
            terminalRef.current.write(message.data);
          }
          // biome-ignore lint/suspicious/noExplicitAny: Socket event listener type mismatch
        }) as any);

        // Listen for terminal exit
        client.service('terminals').on('exit', ((message: {
          terminalId: string;
          exitCode: number;
        }) => {
          if (message.terminalId === result.terminalId && terminalRef.current) {
            terminalRef.current.writeln(`\r\n\r\n[Process exited with code ${message.exitCode}]`);
            terminalRef.current.writeln('[Close and reopen terminal to start a new session]');
          }
          // biome-ignore lint/suspicious/noExplicitAny: Socket event listener type mismatch
        }) as any);
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
      setTerminalId(null);
      setIsConnected(false);
    };
  }, [open, client, initialCommands, isAdmin]);

  const handleClose = () => {
    if (isConnected) {
      modal.confirm({
        title: 'Close Terminal?',
        content: 'The terminal session and history will be lost. This cannot be undone.',
        okText: 'Close',
        okType: 'danger',
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
      title={
        <div>
          Terminal{' '}
          <span style={{ fontSize: '12px', fontWeight: 'normal', opacity: 0.6 }}>
            (ephemeral session - closes with modal)
          </span>
        </div>
      }
      open={open}
      onCancel={handleClose}
      footer={null}
      width={900}
      styles={{
        body: {
          padding: 0,
          height: '600px',
          background: '#000',
        },
      }}
    >
      {!isAdmin ? (
        <div style={{ padding: '24px' }}>
          <Alert
            message="Admin Access Required"
            description={
              <div>
                <p>
                  Terminal access requires <strong>admin</strong> or <strong>owner</strong> role.
                </p>
                <p style={{ marginBottom: 0 }}>
                  Terminal sessions run as the daemon's system user and can execute arbitrary code.
                  Contact your Agor administrator to request elevated permissions.
                </p>
              </div>
            }
            type="warning"
            showIcon
          />
        </div>
      ) : (
        <div style={{ height: '100%', width: '100%', padding: '16px' }}>
          <div ref={terminalDivRef} style={{ height: '100%', width: '100%' }} />
        </div>
      )}
    </Modal>
  );
};
