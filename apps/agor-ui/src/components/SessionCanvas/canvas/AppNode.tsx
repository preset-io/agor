import type { AppBoardObject, BoardObject, SandpackTemplate } from '@agor-live/client';
import { CodeOutlined, DeleteOutlined, EyeOutlined } from '@ant-design/icons';
import { SandpackPreview, SandpackProvider } from '@codesandbox/sandpack-react';
import { Button, Card, Tooltip, Typography, theme } from 'antd';
import { useCallback, useRef, useState } from 'react';
import { NodeResizer } from 'reactflow';
import { withBodyReset } from './utils/sandpackDefaults';

interface AppNodeData {
  objectId: string;
  title: string;
  description?: string;
  template: SandpackTemplate;
  files: Record<string, string>;
  dependencies?: Record<string, string>;
  entryFile?: string;
  showEditor?: boolean;
  showConsole?: boolean;
  width: number;
  height: number;
  onUpdate: (id: string, data: BoardObject) => void;
  onDelete?: (id: string) => void;
}

const MIN_WIDTH = 300;
const MIN_HEIGHT = 200;

export const AppNode = ({ data, selected }: { data: AppNodeData; selected?: boolean }) => {
  const { token } = theme.useToken();
  const [interactMode, setInteractMode] = useState(false);
  const iframeContainerRef = useRef<HTMLDivElement>(null);

  const handleResize = useCallback(
    (_event: unknown, params: { width: number; height: number }) => {
      const objectData: AppBoardObject = {
        type: 'app',
        x: 0, // Position managed by React Flow, not relevant for resize
        y: 0,
        width: Math.max(params.width, MIN_WIDTH),
        height: Math.max(params.height, MIN_HEIGHT),
        title: data.title,
        description: data.description,
        template: data.template,
        files: data.files,
        dependencies: data.dependencies,
        entryFile: data.entryFile,
        showEditor: data.showEditor,
        showConsole: data.showConsole,
      };
      data.onUpdate(data.objectId, objectData);
    },
    [data]
  );

  const toggleInteract = useCallback(() => {
    setInteractMode((prev) => !prev);
  }, []);

  const headerHeight = 40;
  const previewHeight = data.height - headerHeight - 16; // 16 for padding

  return (
    <>
      <NodeResizer
        isVisible={selected}
        minWidth={MIN_WIDTH}
        minHeight={MIN_HEIGHT}
        onResize={handleResize}
        lineStyle={{ borderColor: token.colorPrimary }}
        handleStyle={{ backgroundColor: token.colorPrimary, width: 8, height: 8 }}
      />
      <Card
        style={{
          width: data.width,
          height: data.height,
          background: token.colorBgContainer,
          border: `2px solid ${selected ? token.colorPrimary : token.colorBorder}`,
          borderRadius: 8,
          boxShadow: token.boxShadowSecondary,
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
        }}
        styles={{
          body: {
            padding: 0,
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
          },
        }}
        size="small"
        title={
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <Typography.Text
              style={{ fontSize: 12, fontWeight: 600, maxWidth: data.width - 120 }}
              ellipsis
            >
              {data.title}
            </Typography.Text>
            <div style={{ display: 'flex', gap: 2 }}>
              <Tooltip title={interactMode ? 'Exit interact mode' : 'Interact with app'}>
                <Button
                  type={interactMode ? 'primary' : 'text'}
                  size="small"
                  icon={interactMode ? <EyeOutlined /> : <CodeOutlined />}
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleInteract();
                  }}
                />
              </Tooltip>
              {data.onDelete && (
                <Button
                  type="text"
                  size="small"
                  danger
                  icon={<DeleteOutlined />}
                  onClick={(e) => {
                    e.stopPropagation();
                    data.onDelete?.(data.objectId);
                  }}
                />
              )}
            </div>
          </div>
        }
      >
        <div
          ref={iframeContainerRef}
          // In interact mode, React Flow's node-drag / canvas-pan / wheel-zoom
          // listeners would otherwise capture every mousedown and wheel event
          // before the iframe sees them — text selection (and therefore
          // copy/paste) breaks, and scrolling zooms the canvas. The
          // `nodrag nopan nowheel` classes are React Flow's documented
          // escape hatch.
          className={interactMode ? 'nodrag nopan nowheel' : undefined}
          style={{
            flex: 1,
            position: 'relative',
            // Block pointer events on the iframe when not in interact mode
            // so React Flow can handle pan/zoom/drag
            pointerEvents: interactMode ? 'auto' : 'none',
          }}
        >
          <SandpackProvider
            template={data.template as 'react'}
            files={withBodyReset(data.files)}
            customSetup={data.dependencies ? { dependencies: data.dependencies } : undefined}
            options={{
              initMode: 'user-visible',
              ...(data.entryFile ? { activeFile: data.entryFile } : {}),
            }}
          >
            <SandpackPreview
              style={{
                height: previewHeight > 0 ? previewHeight : 200,
                border: 'none',
              }}
              showNavigator={false}
              showOpenInCodeSandbox={false}
              showRefreshButton={interactMode}
            />
          </SandpackProvider>
        </div>
      </Card>
    </>
  );
};
