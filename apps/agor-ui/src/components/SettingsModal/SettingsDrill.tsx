import { ArrowLeftOutlined } from '@ant-design/icons';
import { App as AntApp, Button, Flex, Typography, theme } from 'antd';
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
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
  /** Disables the footer Save button (e.g. an invalid create form). */
  saveDisabled?: boolean;
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

/**
 * Self-managed drill provider that owns its own `drill`/`controller` state.
 * The Workspace Settings shell wires the controlled SettingsDrillProvider, but
 * this is handy for rendering a settings surface standalone — e.g. focused unit
 * tests of a single table's drill-in.
 */
export const StandaloneSettingsDrillProvider: React.FC<{ children: ReactNode }> = ({
  children,
}) => {
  const [drill, setDrill] = useState<DrillTarget | null>(null);
  const [controller, setControllerState] = useState<DrillController | null>(null);
  const controllerRef = useRef<DrillController | null>(null);
  const setController = useCallback((next: DrillController | null) => {
    controllerRef.current = next;
    setControllerState(next);
  }, []);
  const getDirty = useCallback(() => controllerRef.current?.dirty ?? false, []);
  const confirmLeaveIfDirty = useDirtyLeaveGuard(getDirty);
  const openDrill = useCallback((target: DrillTarget) => setDrill(target), []);
  const closeDrill = useCallback(() => {
    setDrill(null);
    setController(null);
  }, [setController]);
  return (
    <SettingsDrillProvider
      drill={drill}
      openDrill={openDrill}
      closeDrill={closeDrill}
      confirmLeaveIfDirty={confirmLeaveIfDirty}
      controller={controller}
      setController={setController}
    >
      {children}
    </SettingsDrillProvider>
  );
};

export interface DrillInFrameProps {
  title: ReactNode;
  dirty?: boolean;
  saving?: boolean;
  /** Omit for autosave editors; the footer then renders no Save button. */
  onSave?: () => void | Promise<void>;
  saveLabel?: string;
  /** Disables the footer Save button (e.g. an invalid create form). */
  saveDisabled?: boolean;
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
  saveDisabled = false,
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

  // Keep the latest callbacks/title in refs and register through STABLE wrappers,
  // so re-registration is driven only by the footer's display values
  // (dirty/saving/saveLabel/hasOnSave). Editors routinely pass a fresh
  // onSave/onBack/title identity every render (e.g. BranchModal's non-memoized
  // handleSave); without this, the effect re-runs each render → setController →
  // the owner re-renders the editor → new identities → infinite loop (the
  // Branches drill-in crash). Wrappers read the refs so Save/Back stay current.
  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;
  const backRef = useRef(back);
  backRef.current = back;
  const titleRef = useRef(title);
  titleRef.current = title;
  const stableOnSave = useCallback(() => onSaveRef.current?.(), []);
  const stableBack = useCallback(() => backRef.current(), []);
  const hasOnSave = onSave != null;

  // biome-ignore lint/correctness/useExhaustiveDependencies: title read via ref on purpose (footer doesn't display it)
  useEffect(() => {
    registerController({
      title: titleRef.current,
      dirty,
      saving,
      saveLabel,
      saveDisabled,
      onSave: hasOnSave ? stableOnSave : undefined,
      onBack: stableBack,
    });
    return () => registerController(null);
  }, [
    registerController,
    dirty,
    saving,
    saveLabel,
    saveDisabled,
    hasOnSave,
    stableOnSave,
    stableBack,
  ]);

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
