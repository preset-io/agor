import type { AgorClient } from '@agor/core/api';
import { Modal } from 'antd';
import { useEffect, useRef, useState } from 'react';
import { Terminal } from 'xterm';
import 'xterm/css/xterm.css';

export interface TerminalModalProps {
  open: boolean;
  onClose: () => void;
  client: AgorClient | null;
}

export const TerminalModal: React.FC<TerminalModalProps> = ({ open, onClose, client }) => {
  const terminalDivRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const [terminalId, setTerminalId] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !terminalDivRef.current || !client) return;

    let mounted = true;

    // Create terminal instance and connect to backend
    const setupTerminal = async () => {
      if (terminalRef.current) return; // Already created

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
        const result = await client.service('terminals').create({
          rows: 30,
          cols: 100,
        });

        if (!mounted) return;

        setTerminalId(result.terminalId);
        terminal.clear();
        terminal.writeln(`✅ Connected! Working directory: ${result.cwd}`);
        terminal.writeln('');

        // Handle user input - send to backend
        terminal.onData(data => {
          if (result.terminalId) {
            client.service('terminals').patch(result.terminalId, { input: data });
          }
        });

        // Listen for terminal output from backend
        client.service('terminals').on('data', (message: { terminalId: string; data: string }) => {
          if (message.terminalId === result.terminalId && terminalRef.current) {
            terminalRef.current.write(message.data);
          }
        });

        // Listen for terminal exit
        client
          .service('terminals')
          .on('exit', (message: { terminalId: string; exitCode: number }) => {
            if (message.terminalId === result.terminalId && terminalRef.current) {
              terminalRef.current.writeln(`\r\n\r\n[Process exited with code ${message.exitCode}]`);
            }
          });
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
      // Cleanup when modal closes
      if (terminalRef.current && !open) {
        terminalRef.current.dispose();
        terminalRef.current = null;
      }
      // Kill backend terminal session
      if (terminalId && client) {
        client.service('terminals').remove(terminalId).catch(console.error);
        setTerminalId(null);
      }
    };
  }, [open, client, terminalId]);

  return (
    <Modal
      title="Terminal"
      open={open}
      onCancel={onClose}
      footer={null}
      width={900}
      bodyStyle={{
        padding: 0,
        height: '600px',
        background: '#000',
      }}
      styles={{
        body: {
          padding: 0,
        },
      }}
    >
      <div style={{ height: '100%', width: '100%', padding: '16px' }}>
        <div ref={terminalDivRef} style={{ height: '100%', width: '100%' }} />
      </div>
    </Modal>
  );
};
