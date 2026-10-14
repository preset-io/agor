import { fireEvent, render, screen } from '@testing-library/react';
import { App as AntApp, Form } from 'antd';
import { describe, expect, it, vi } from 'vitest';
import { AudioSettingsTab } from './AudioSettingsTab';

vi.mock('../../utils/audio', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../utils/audio')>()),
  checkAudioPermission: vi.fn().mockResolvedValue(false),
  previewChimeSound: vi.fn().mockRejectedValue(new Error('NotAllowedError')),
}));

function Harness() {
  const [form] = Form.useForm();
  return <AudioSettingsTab form={form} />;
}

describe('AudioSettingsTab', () => {
  it('explains a blocked preview inline, with a hedged cause and no toast', async () => {
    render(
      <AntApp>
        <Harness />
      </AntApp>
    );
    fireEvent.click(screen.getByRole('switch'));
    fireEvent.click(await screen.findByRole('button', { name: /Preview/ }));
    expect(
      await screen.findByText(
        "Couldn't play the sound, because your browser may be blocking it. Follow the steps below."
      )
    ).toBeInTheDocument();
    expect(screen.queryByText(/Audio blocked by browser/)).toBeNull();
  });
});
