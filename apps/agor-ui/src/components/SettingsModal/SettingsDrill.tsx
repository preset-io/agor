import { App as AntApp, Breadcrumb, Button, Flex, Grid, Typography, theme } from 'antd';
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
import { settingsSectionLabel } from './settingsNavigation';

/**
 * Drill-in navigation for the Workspace Settings modal.
 *
 * The redesign replaces every stacked "modal on modal" edit/detail dialog with
 * an in-place drill-in: the Content pane swaps from a section's list view to a
 * detail / edit view while the nav stays put. The shell owns one piece of state
 * (`drill`, keyed to the active section) that decides list-vs-editor; each table
 * renders its editor inline in a {@link DrillInFrame}, which registers a
 * {@link DrillController} so the shell footer can drive Save/Cancel and the
 * unsaved-changes guard.
 */

export interface DrillTarget {
  mode: 'create' | 'edit' | 'view';
  /** Record being edited/viewed (omitted for `create`). */
  recordId?: string;
}

/**
 * Contract an active drill-in editor publishes to the shell footer.
 *
 * The footer is a single slot holding one controller: a DrillInFrame nested
 * inside another would replace its parent's registration (and clear it on
 * unmount). Nested editors render inline without a second frame instead.
 */
interface DrillController {
  /** Read when leaving, so `dirty` may be a live getter (e.g. form.isFieldsTouched). */
  isDirty: () => boolean;
  saving: boolean;
  /** Omit for autosave editors: the footer then shows no Save button. */
  onSave?: () => void | Promise<void>;
  saveLabel?: string;
  /** Disables the footer Save button (e.g. an invalid create form). */
  saveDisabled?: boolean;
  /** Guarded back, invoked by the breadcrumb and the footer Cancel. */
  onBack: () => void;
  /** The editor renders its own footer; the shell suppresses its Save/Cancel. */
  ownsFooter?: boolean;
}

interface SettingsDrillContextValue {
  /** The section the drill-in belongs to (the shell's active tab). */
  section?: SettingsSection;
  drill: DrillTarget | null;
  openDrill: (target: DrillTarget) => void;
  closeDrill: () => void;
  /** Runs `leave` now when the open editor is clean, else after a discard confirm. */
  confirmLeaveIfDirty: (leave: () => void) => void;
  registerController: (controller: DrillController | null) => void;
}

const SettingsDrillContext = createContext<SettingsDrillContextValue>({
  drill: null,
  openDrill: () => undefined,
  closeDrill: () => undefined,
  confirmLeaveIfDirty: (leave) => leave(),
  registerController: () => undefined,
});

export function useSettingsDrill(): SettingsDrillContextValue {
  return useContext(SettingsDrillContext);
}

export interface DrillShell extends SettingsDrillContextValue {
  /** The shell's Save/Cancel footer, or null when no editor needs one. */
  footer: ReactNode;
}

/**
 * Drill state, controller slot and leave guard for one settings surface. Used by
 * the Settings modal and by {@link StandaloneSettingsDrillProvider}, so tests run
 * the production wiring.
 */
export function useDrillShell(section?: SettingsSection): DrillShell {
  const { modal } = AntApp.useApp();
  const [state, setState] = useState<{ section?: SettingsSection; target: DrillTarget } | null>(
    null
  );
  // Leaving the section (nav click, deep link) abandons its drill-in.
  if (state && state.section !== section) setState(null);
  const drill = state?.section === section ? (state?.target ?? null) : null;

  const [controller, setControllerState] = useState<DrillController | null>(null);
  const controllerRef = useRef<DrillController | null>(null);
  const registerController = useCallback((next: DrillController | null) => {
    controllerRef.current = next;
    setControllerState(next);
  }, []);

  // Stable identity (reads the controller through a ref), so DrillInFrame's
  // registration effect doesn't re-run on every register.
  const confirmLeaveIfDirty = useCallback(
    (leave: () => void) => {
      if (!controllerRef.current?.isDirty()) {
        leave();
        return;
      }
      modal.confirm({
        title: 'Discard unsaved changes?',
        content: 'You have unsaved changes. Leaving now will discard them.',
        okText: 'Discard',
        okButtonProps: { danger: true },
        cancelText: 'Keep editing',
        onOk: leave,
      });
    },
    [modal]
  );
  const openDrill = useCallback((target: DrillTarget) => setState({ section, target }), [section]);
  const closeDrill = useCallback(() => {
    setState(null);
    registerController(null);
  }, [registerController]);

  return {
    section,
    drill,
    openDrill,
    closeDrill,
    confirmLeaveIfDirty,
    registerController,
    footer: controller && !controller.ownsFooter ? <DrillFooter controller={controller} /> : null,
  };
}

/** The controller-driven Save/Cancel footer. */
const DrillFooter: React.FC<{ controller: DrillController }> = ({ controller }) => (
  <Flex justify="flex-end" gap={8}>
    <Button onClick={controller.onBack} disabled={controller.saving}>
      Cancel
    </Button>
    {controller.onSave ? (
      <Button
        type="primary"
        loading={controller.saving}
        disabled={controller.saveDisabled}
        onClick={() => void controller.onSave?.()}
      >
        {controller.saveLabel ?? 'Save'}
      </Button>
    ) : null}
  </Flex>
);

export const SettingsDrillProvider: React.FC<{ shell: DrillShell; children: ReactNode }> = ({
  shell,
  children,
}) => {
  const { section, drill, openDrill, closeDrill, confirmLeaveIfDirty, registerController } = shell;
  const value = useMemo(
    () => ({ section, drill, openDrill, closeDrill, confirmLeaveIfDirty, registerController }),
    [section, drill, openDrill, closeDrill, confirmLeaveIfDirty, registerController]
  );
  return <SettingsDrillContext.Provider value={value}>{children}</SettingsDrillContext.Provider>;
};

/** A settings surface rendered on its own (focused tests), with the shell's footer. */
export const StandaloneSettingsDrillProvider: React.FC<{
  section?: SettingsSection;
  children: ReactNode;
}> = ({ section, children }) => {
  const shell = useDrillShell(section);
  return (
    <SettingsDrillProvider shell={shell}>
      {children}
      {shell.footer}
    </SettingsDrillProvider>
  );
};

export interface DrillInFrameProps {
  title: ReactNode;
  /** A value, or a getter read when leaving (e.g. `() => form.isFieldsTouched()`). */
  dirty?: boolean | (() => boolean);
  saving?: boolean;
  /** Omit for autosave editors; the footer then renders no Save button. */
  onSave?: () => void | Promise<void>;
  saveLabel?: string;
  /** Disables the footer Save button (e.g. an invalid create form). */
  saveDisabled?: boolean;
  /** Runs after the unsaved-changes guard; defaults to closing the drill-in. */
  onBack?: () => void;
  /** Right-aligned node in the header row (e.g. a Reset action). */
  extra?: ReactNode;
  /**
   * The editor renders its own footer (User, Card and Gateway-create editors)
   * and uses the frame for the breadcrumb, the guard and `dirty` only.
   */
  ownsFooter?: boolean;
  children: ReactNode;
}

/**
 * Wraps a drill-in editor: renders the breadcrumb and publishes the
 * Save/dirty/back contract to the shell footer. Destructive confirmations are
 * intentionally NOT routed through here; they stay as their own blocking
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
  ownsFooter = false,
  children,
}) => {
  const { token } = theme.useToken();
  const compact = !Grid.useBreakpoint().md;
  const { section, confirmLeaveIfDirty, closeDrill, registerController } = useSettingsDrill();

  // Latest props behind refs, registered through stable wrappers: editors pass
  // fresh onSave/onBack identities every render (e.g. BranchModal), and
  // re-registering on each one loops register → re-render → new identity.
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const onBackRef = useRef(onBack);
  onBackRef.current = onBack;
  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;
  const isDirty = useCallback(() => {
    const value = dirtyRef.current;
    return typeof value === 'function' ? value() : value;
  }, []);
  // Every way back (breadcrumb, footer Cancel) runs the guard first.
  const back = useCallback(
    () => confirmLeaveIfDirty(() => (onBackRef.current ?? closeDrill)()),
    [confirmLeaveIfDirty, closeDrill]
  );
  const stableOnSave = useCallback(() => onSaveRef.current?.(), []);
  const hasOnSave = onSave != null;

  useEffect(() => {
    registerController({
      isDirty,
      saving,
      saveLabel,
      saveDisabled,
      onSave: hasOnSave ? stableOnSave : undefined,
      onBack: back,
      ownsFooter,
    });
    return () => registerController(null);
  }, [
    registerController,
    isDirty,
    saving,
    saveLabel,
    saveDisabled,
    hasOnSave,
    stableOnSave,
    back,
    ownsFooter,
  ]);

  return (
    <Flex vertical style={{ height: '100%' }}>
      <Flex
        align="center"
        justify="space-between"
        gap={token.marginXS}
        wrap
        style={{ marginBottom: compact ? token.marginMD : token.marginLG }}
      >
        {/* The section crumb goes back to the list through the guarded `back`;
            the current-record crumb is the (non-clickable) page marker. */}
        <Breadcrumb
          items={[
            ...(section
              ? [
                  {
                    key: 'section',
                    title: (
                      <Typography.Link onClick={back} style={{ fontWeight: 500 }}>
                        {settingsSectionLabel(section)}
                      </Typography.Link>
                    ),
                  },
                ]
              : []),
            {
              key: 'current',
              title: (
                <Typography.Text style={{ fontWeight: 500, color: token.colorText }}>
                  {title}
                </Typography.Text>
              ),
            },
          ]}
        />
        {extra}
      </Flex>
      <div style={{ flex: 1, minHeight: 0 }}>{children}</div>
    </Flex>
  );
};
