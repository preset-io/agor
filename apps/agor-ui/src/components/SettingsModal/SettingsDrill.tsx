import { ArrowLeftOutlined } from '@ant-design/icons';
import { App as AntApp, Button, Flex, Typography, theme } from 'antd';
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo } from 'react';
import type { SettingsSection } from '../../hooks/useSettingsRoute';

/**
 * Drill-in navigation for the Workspace Settings modal.
 *
 * The redesign replaces every stacked "modal on modal" edit/detail dialog with
 * an in-place drill-in: the Content pane swaps from a list view to a detail /
 * edit view while the left nav stays put. One piece of state (`drill`) owned by
 * the modal shell decides list-vs-editor for the active section; each table
 * renders its own editor inline and registers a {@link DrillController} so the
 * shared modal footer can drive Save/Cancel and the unsaved-changes guard.
 */

export interface DrillTarget {
  /** Which section owns the drill-in — always the active nav section. */
  kind: SettingsSection;
  mode: 'create' | 'edit' | 'view';
  /** Record being edited/viewed (omitted for `create`). */
  recordId?: string;
}

/**
 * Contract an active drill-in editor publishes to the shell. The footer renders
 * Save/Cancel from this; `dirty` drives the discard guard on Back/Cancel/nav.
 */
export interface DrillController {
  title: ReactNode;
  dirty: boolean;
  saving: boolean;
  /** Omit for autosave editors — the footer then shows no Save button. */
  onSave?: () => void | Promise<void>;
  saveLabel?: string;
  /** Invoked by the header back-arrow and footer Cancel. */
  onBack: () => void;
}

interface SettingsDrillContextValue {
  drill: DrillTarget | null;
  openDrill: (target: DrillTarget) => void;
  closeDrill: () => void;
  /** Runs the unsaved-changes guard, resolving true when it is safe to leave. */
  confirmLeaveIfDirty: () => Promise<boolean>;
  registerController: (controller: DrillController | null) => void;
}

const defaultSettingsDrillContext: SettingsDrillContextValue = {
  drill: null,
  openDrill: () => undefined,
  closeDrill: () => undefined,
  confirmLeaveIfDirty: async () => true,
  registerController: () => undefined,
};

const SettingsDrillContext = createContext<SettingsDrillContextValue>(defaultSettingsDrillContext);

export function useSettingsDrill(): SettingsDrillContextValue {
  return useContext(SettingsDrillContext);
}

export interface SettingsDrillProviderProps {
  drill: DrillTarget | null;
  openDrill: (target: DrillTarget) => void;
  closeDrill: () => void;
  confirmLeaveIfDirty: () => Promise<boolean>;
  controller: DrillController | null;
  setController: (controller: DrillController | null) => void;
  children: ReactNode;
}

/**
 * Provider wired to state owned by the modal shell. The shell keeps `drill` and
 * the active `controller` so it can render the footer next to the dialog frame.
 */
export const SettingsDrillProvider: React.FC<SettingsDrillProviderProps> = ({
  drill,
  openDrill,
  closeDrill,
  confirmLeaveIfDirty,
  setController,
  children,
}) => {
  const registerController = useCallback(
    (controller: DrillController | null) => setController(controller),
    [setController]
  );
  const value = useMemo<SettingsDrillContextValue>(
    () => ({ drill, openDrill, closeDrill, confirmLeaveIfDirty, registerController }),
    [drill, openDrill, closeDrill, confirmLeaveIfDirty, registerController]
  );
  return <SettingsDrillContext.Provider value={value}>{children}</SettingsDrillContext.Provider>;
};

export interface DrillInFrameProps {
  title: ReactNode;
  dirty?: boolean;
  saving?: boolean;
  /** Omit for autosave editors; the footer then renders no Save button. */
  onSave?: () => void | Promise<void>;
  saveLabel?: string;
  /** Overrides the default back behavior (guarded close). */
  onBack?: () => void;
  /** Right-aligned node in the header row (e.g. a Reset action). */
  extra?: ReactNode;
  children: ReactNode;
}

/**
 * Wraps a drill-in editor: renders the back-arrow header and publishes the
 * Save/dirty/back contract to the shell footer. Destructive confirmations are
 * intentionally NOT routed through here — they stay as their own blocking
 * dialogs (Popconfirm / ArchiveDeleteBranchModal / repo delete choice).
 */
export const DrillInFrame: React.FC<DrillInFrameProps> = ({
  title,
  dirty = false,
  saving = false,
  onSave,
  saveLabel,
  onBack,
  extra,
  children,
}) => {
  const { token } = theme.useToken();
  const { confirmLeaveIfDirty, closeDrill, registerController } = useSettingsDrill();

  const back = useCallback(() => {
    if (onBack) {
      onBack();
      return;
    }
    void confirmLeaveIfDirty().then((ok) => {
      if (ok) closeDrill();
    });
  }, [onBack, confirmLeaveIfDirty, closeDrill]);

  useEffect(() => {
    registerController({ title, dirty, saving, onSave, saveLabel, onBack: back });
    return () => registerController(null);
  }, [registerController, title, dirty, saving, onSave, saveLabel, back]);

  return (
    <Flex vertical style={{ height: '100%' }}>
      <Flex align="center" gap={token.marginXS} style={{ marginBottom: token.marginLG }}>
        <Button
          type="text"
          icon={<ArrowLeftOutlined />}
          onClick={back}
          aria-label="Back"
          style={{ marginInlineStart: -token.marginXS }}
        />
        {/* Size — not boldness — carries hierarchy: regular/medium weight. */}
        <Typography.Title level={4} style={{ margin: 0, flex: 1, fontWeight: 500 }}>
          {title}
        </Typography.Title>
        {extra}
      </Flex>
      <div style={{ flex: 1, minHeight: 0 }}>{children}</div>
    </Flex>
  );
};

/**
 * Hook the shell uses to build a stable `confirmLeaveIfDirty`. Dirtiness is read
 * at call time through `getDirty` (a ref-backed getter) so this callback keeps a
 * stable identity across controller registrations — otherwise the identity would
 * churn on every register and re-fire the DrillInFrame effect in a loop.
 * Resolves true when leaving is safe (clean, or the user confirmed discarding).
 * AntD's static `Modal.confirm` is avoided so the confirm inherits the app theme.
 */
export function useDirtyLeaveGuard(getDirty: () => boolean): () => Promise<boolean> {
  const { modal } = AntApp.useApp();
  return useCallback(
    () =>
      new Promise<boolean>((resolve) => {
        if (!getDirty()) {
          resolve(true);
          return;
        }
        modal.confirm({
          title: 'Discard unsaved changes?',
          content: 'You have unsaved changes. Leaving now will discard them.',
          okText: 'Discard',
          okButtonProps: { danger: true },
          cancelText: 'Keep editing',
          onOk: () => resolve(true),
          onCancel: () => resolve(false),
        });
      }),
    [getDirty, modal]
  );
}
