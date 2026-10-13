import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App as AntApp } from 'antd';
import { describe, expect, it, vi } from 'vitest';
import {
  DrillCrumbs,
  DrillInFrame,
  SettingsDrillProvider,
  StandaloneSettingsDrillProvider,
  useDrillShell,
} from './SettingsDrill';

// Regression for the Branches drill-in crash: the component that OWNS the
// drill shell also renders the editor in its own render (like SettingsModal),
// so a registration re-renders the owner → a NEW editor element with a NEW
// onSave identity. DrillInFrame must not re-register on every render (that
// loops → "Maximum update depth").
function Shell() {
  const shell = useDrillShell('branches');
  return (
    <SettingsDrillProvider shell={shell}>
      <DrillInFrame title={`Branch: ${Math.random()}`} dirty onSave={() => {}}>
        <div>body</div>
      </DrillInFrame>
      {shell.footer}
    </SettingsDrillProvider>
  );
}

function renderFrame(dirty: boolean | (() => boolean), onBack = vi.fn()) {
  render(
    <AntApp>
      <StandaloneSettingsDrillProvider section="card-types">
        <DrillInFrame title="Edit Card Type" dirty={dirty} onBack={onBack}>
          <div>editor</div>
        </DrillInFrame>
      </StandaloneSettingsDrillProvider>
    </AntApp>
  );
  return onBack;
}

describe('DrillInFrame', () => {
  it('does not loop when the owner re-renders the editor with fresh callbacks', () => {
    render(
      <AntApp>
        <Shell />
      </AntApp>
    );
    expect(screen.getByText('body')).toBeInTheDocument();
    // Registered with a Save action: the shell footer renders it.
    expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument();
  });

  it('labels the first crumb with the shell section', () => {
    renderFrame(false);
    expect(screen.getByText('Card Types')).toBeInTheDocument();
  });

  it('leaves a clean editor at once', () => {
    const onBack = renderFrame(false);
    fireEvent.click(screen.getByText('Card Types'));
    expect(onBack).toHaveBeenCalledOnce();
  });

  it.each([
    ['a value', true],
    ['a getter', () => true],
  ])('asks before leaving when dirty is %s, even with a custom onBack', async (_, dirty) => {
    const onBack = renderFrame(dirty);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(document.querySelectorAll('.ant-modal-confirm')).toHaveLength(1));
    fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }));
    expect(onBack).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText('Card Types'));
    fireEvent.click(await screen.findByRole('button', { name: 'Discard' }));
    await waitFor(() => expect(onBack).toHaveBeenCalledOnce());
  });
});

describe('DrillCrumbs', () => {
  // An in-place editor opens at the list's scroll offset; its crumbs must not
  // start off screen.
  it('brings itself into view when an editor opens', () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    try {
      render(<DrillCrumbs parent="Schedules" onParent={vi.fn()} current="Weekly retro" />);
      expect(scrollIntoView).toHaveBeenCalledOnce();
      expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' });
    } finally {
      // jsdom has no scrollIntoView of its own.
      delete (Element.prototype as Partial<Element>).scrollIntoView;
    }
  });
});
