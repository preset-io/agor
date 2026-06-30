import { Typography, theme } from 'antd';
import type React from 'react';
import { useCallback, useEffect, useState } from 'react';

interface SessionComposerDropZoneProps {
  children: React.ReactNode;
  disabled?: boolean;
  onDragActiveChange?: (active: boolean) => void;
  onFilesDrop: (files: File[]) => void;
}

function hasDraggedFiles(dataTransfer: DataTransfer): boolean {
  return Array.from(dataTransfer.types).includes('Files');
}

export const SessionComposerDropZone: React.FC<SessionComposerDropZoneProps> = ({
  children,
  disabled = false,
  onDragActiveChange,
  onFilesDrop,
}) => {
  const { token } = theme.useToken();
  const [isDragOver, setIsDragOver] = useState(false);

  const handleDragEnter = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      if (!hasDraggedFiles(event.dataTransfer)) return;
      event.preventDefault();
      setIsDragOver(!disabled);
    },
    [disabled]
  );

  const handleDragOver = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      if (!hasDraggedFiles(event.dataTransfer)) return;
      event.preventDefault();
      setIsDragOver(!disabled);
    },
    [disabled]
  );

  const handleDragLeave = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    const nextTarget = event.relatedTarget;
    if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) return;
    setIsDragOver(false);
  }, []);

  const handleDropCapture = useCallback(() => {
    // Child drop handlers (notably the textarea) intentionally stop
    // propagation after handling files. Clear the container affordance during
    // capture so the dashed outline cannot remain stuck behind that child.
    setIsDragOver(false);
  }, []);

  const handleDrop = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      setIsDragOver(false);

      // AutocompleteTextarea keeps its own drop handling for the textarea. If a
      // child handles the same drop and still lets it bubble, avoid routing the
      // files twice from this larger container.
      if (event.defaultPrevented) return;

      const files = Array.from(event.dataTransfer.files);
      if (files.length === 0) return;

      event.preventDefault();
      event.stopPropagation();
      if (disabled) return;
      onFilesDrop(files);
    },
    [disabled, onFilesDrop]
  );

  useEffect(() => {
    if (!isDragOver) return;

    const clearDragState = () => setIsDragOver(false);
    window.addEventListener('drop', clearDragState);
    window.addEventListener('dragend', clearDragState);
    window.addEventListener('blur', clearDragState);
    return () => {
      window.removeEventListener('drop', clearDragState);
      window.removeEventListener('dragend', clearDragState);
      window.removeEventListener('blur', clearDragState);
    };
  }, [isDragOver]);

  useEffect(() => {
    onDragActiveChange?.(isDragOver);
  }, [isDragOver, onDragActiveChange]);

  return (
    <section
      aria-label="Composer attachments and input drop zone"
      aria-disabled={disabled}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDropCapture={handleDropCapture}
      onDrop={handleDrop}
      style={{
        position: 'relative',
        display: 'flex',
        flexDirection: 'column',
        gap: token.sizeUnit * 2,
        borderRadius: token.borderRadiusLG,
      }}
    >
      {children}
      {isDragOver && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            backgroundColor: `${token.colorBgContainer}CC`,
            border: `1px solid ${token.colorPrimary}`,
            borderRadius: token.borderRadius,
            boxShadow: `0 0 0 ${token.controlOutlineWidth}px ${token.controlOutline}`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 10,
            pointerEvents: 'none',
          }}
        >
          <Typography.Text strong style={{ color: token.colorPrimary }}>
            Drop files here to attach
          </Typography.Text>
        </div>
      )}
    </section>
  );
};
