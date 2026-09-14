import { render, screen } from '@testing-library/react';
import { App as AntApp } from 'antd';
import { useCallback, useRef, useState } from 'react';
import { describe, expect, it } from 'vitest';
import {
  type DrillController,
  DrillInFrame,
  SettingsDrillProvider,
  useDirtyLeaveGuard,
} from './SettingsDrill';

// Regression for the Branches drill-in crash: the component that OWNS the
// controller state also renders the editor in its own render (like
// SettingsModal), so setController → re-render → a NEW editor element with a
// NEW onSave identity. With a non-memoized onSave (BranchModal's handleSave)
// DrillInFrame must NOT re-register on every render (that loops → "Maximum
// update depth" and the whole UI crashes).
function Shell() {
  const [controller, setControllerState] = useState<DrillController | null>(null);
  const controllerRef = useRef<DrillController | null>(null);
  const setController = useCallback((next: DrillController | null) => {
    controllerRef.current = next;
    setControllerState(next);
  }, []);
  const getDirty = useCallback(() => controllerRef.current?.dirty ?? false, []);
  const confirmLeaveIfDirty = useDirtyLeaveGuard(getDirty);

  return (
    <SettingsDrillProvider
      drill={{ kind: 'branches', mode: 'edit' }}
      openDrill={() => {}}
      closeDrill={() => {}}
      confirmLeaveIfDirty={confirmLeaveIfDirty}
      controller={controller}
      setController={setController}
    >
      {/* Fresh title/onSave identity every render, rendered inline by the owner. */}
      <DrillInFrame title={`Branch: ${Math.random()}`} dirty onSave={() => {}}>
        <div>body</div>
      </DrillInFrame>
      {controller?.onSave ? <span>has-save</span> : null}
    </SettingsDrillProvider>
  );
}

describe('DrillInFrame registration', () => {
  it('does not loop when the owner re-renders the editor with fresh callbacks', () => {
    render(
      <AntApp>
        <Shell />
      </AntApp>
    );
    expect(screen.getByText('body')).toBeInTheDocument();
    // Controller registered with a Save action (proves the footer still wires up).
    expect(screen.getByText('has-save')).toBeInTheDocument();
  });
});
