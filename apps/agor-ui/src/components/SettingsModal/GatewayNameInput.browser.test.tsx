import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { ConfigProvider, Form, theme } from 'antd';
import { afterEach, describe, expect, it } from 'vitest';
import { userEvent } from 'vitest/browser';
import { GatewayNameInput } from './GatewayNameInput';

afterEach(cleanup);

describe.each([false, true])('Gateway name preview (dark: %s)', (dark) => {
  it('keeps Rename visible for long names and opens a focused input by keyboard', async () => {
    const targetName = 'An unusually long teammate name for the customer support team';
    render(
      <ConfigProvider theme={{ algorithm: dark ? theme.darkAlgorithm : theme.defaultAlgorithm }}>
        <div style={{ maxWidth: 480, padding: 16 }} data-testid="name-container">
          <Form layout="vertical">
            <Form.Item name="name">
              <GatewayNameInput targetName={targetName} channelTypeLabel="Slack" />
            </Form.Item>
          </Form>
        </div>
      </ConfigProvider>
    );

    const name = `${targetName} · Slack`;
    await screen.findByText(name);
    const rename = screen.getByRole('button', { name: 'Rename gateway' });
    const container = screen.getByTestId('name-container');
    await waitFor(() => {
      const bounds = container.getBoundingClientRect();
      const buttonBounds = rename.getBoundingClientRect();
      expect(buttonBounds.right).toBeLessThanOrEqual(bounds.right);
      expect(buttonBounds.left).toBeGreaterThanOrEqual(bounds.left);
      expect(container.scrollWidth).toBeLessThanOrEqual(container.clientWidth);
    });

    await userEvent.tab();
    expect(rename).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    const input = screen.getByRole('textbox', { name: 'Display name' });
    await waitFor(() => expect(input).toHaveFocus());
    expect(input).toHaveValue(name);
  });
});
