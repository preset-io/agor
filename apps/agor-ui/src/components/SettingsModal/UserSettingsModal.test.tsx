import type { User } from '@agor-live/client';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { UserSettingsModal } from './UserSettingsModal';

vi.mock('antd', async () => {
  const React = await vi.importActual<typeof import('react')>('react');
  type FormInstance = {
    setFieldsValue: (values: Record<string, unknown>) => void;
    getFieldsValue: () => Record<string, unknown>;
    validateFields: () => Promise<Record<string, unknown>>;
    resetFields: () => void;
    setFieldValue: (name: string, value: unknown) => void;
  };
  type FormContextValue = {
    form: FormInstance;
    onValuesChange?: (changed: Record<string, unknown>, all: Record<string, unknown>) => void;
  };

  const FormContext = React.createContext<FormContextValue | null>(null);
  const createForm = (): FormInstance => {
    const store: Record<string, unknown> = {};
    return {
      setFieldsValue: (values) => Object.assign(store, values),
      getFieldsValue: () => ({ ...store }),
      validateFields: async () => ({ ...store }),
      resetFields: () => {
        for (const key of Object.keys(store)) delete store[key];
      },
      setFieldValue: (name, value) => {
        store[name] = value;
      },
    };
  };

  const Form = ({
    children,
    component,
    form,
    onValuesChange,
  }: {
    children?: React.ReactNode;
    component?: false;
    form: FormInstance;
    onValuesChange?: FormContextValue['onValuesChange'];
  }) => {
    if (component === false) return null;
    return React.createElement(
      FormContext.Provider,
      { value: { form, onValuesChange } },
      React.createElement('form', {}, children)
    );
  };
  Form.useForm = () => [React.useState(createForm)[0]];
  Form.Item = ({
    children,
    name,
    valuePropName,
    label,
  }: {
    children?: React.ReactNode;
    name?: string;
    valuePropName?: string;
    label?: React.ReactNode;
  }) => {
    const context = React.useContext(FormContext);
    const child = React.Children.only(children) as React.ReactElement | undefined;
    if (!name || !context || !React.isValidElement(child)) {
      return React.createElement('div', {}, label, children);
    }
    const allValues = context.form.getFieldsValue();
    const value = allValues[name];
    const propName = valuePropName === 'checked' ? 'checked' : 'value';
    return React.createElement(
      'label',
      {},
      label,
      React.cloneElement(child, {
        [propName]: valuePropName === 'checked' ? !!value : (value ?? ''),
        onChange: (event: React.ChangeEvent<HTMLInputElement>) => {
          const nextValue = valuePropName === 'checked' ? event.target.checked : event.target.value;
          context.form.setFieldValue(name, nextValue);
          context.onValuesChange?.({ [name]: nextValue }, context.form.getFieldsValue());
          child.props.onChange?.(event);
        },
      })
    );
  };

  const Input = (props: React.InputHTMLAttributes<HTMLInputElement>) =>
    React.createElement('input', props);
  Input.Password = Input;

  const passthrough = ({ children }: { children?: React.ReactNode }) =>
    React.createElement('div', {}, children);
  const Button = ({ children, onClick }: { children?: React.ReactNode; onClick?: () => void }) =>
    React.createElement('button', { type: 'button', onClick }, children);
  const Checkbox = (props: React.InputHTMLAttributes<HTMLInputElement>) =>
    React.createElement('input', { ...props, type: 'checkbox' });
  const Switch = (props: React.InputHTMLAttributes<HTMLInputElement>) =>
    React.createElement('input', { ...props, type: 'checkbox' });
  const Select = (props: React.InputHTMLAttributes<HTMLInputElement>) =>
    React.createElement('input', props);
  const Modal = ({
    open,
    children,
    footer,
  }: {
    open?: boolean;
    children?: React.ReactNode;
    footer?: React.ReactNode;
  }) => (open ? React.createElement('div', { role: 'dialog' }, children, footer) : null);
  const Layout = Object.assign(passthrough, { Sider: passthrough, Content: passthrough });
  const Menu = ({
    items = [],
    onClick,
  }: {
    items?: Array<{
      key: string;
      label?: React.ReactNode;
      children?: Array<{ key: string; label?: React.ReactNode }>;
    }>;
    onClick?: ({ key }: { key: string }) => void;
  }) =>
    React.createElement(
      'div',
      { role: 'menu' },
      items.flatMap((item) =>
        item.children
          ? item.children.map((child) =>
              React.createElement(
                'button',
                {
                  key: child.key,
                  type: 'button',
                  role: 'menuitem',
                  onClick: () => onClick?.({ key: child.key }),
                },
                child.label
              )
            )
          : []
      )
    );
  const Tabs = ({
    items = [],
    defaultActiveKey,
    activeKey,
    onChange,
  }: {
    items?: Array<{ key: string; label: React.ReactNode; children: React.ReactNode }>;
    defaultActiveKey?: string;
    activeKey?: string;
    onChange?: (key: string) => void;
  }) => {
    const [internalActive, setInternalActive] = React.useState(defaultActiveKey ?? items[0]?.key);
    const selected = activeKey ?? internalActive;
    const activeItem = items.find((item) => item.key === selected) ?? items[0];
    return React.createElement(
      'div',
      {},
      items.map((item) =>
        React.createElement(
          'button',
          {
            key: item.key,
            type: 'button',
            role: 'tab',
            onClick: () => {
              setInternalActive(item.key);
              onChange?.(item.key);
            },
          },
          item.label
        )
      ),
      activeItem?.children
    );
  };
  const Typography = { Title: passthrough, Paragraph: passthrough };
  const theme = { useToken: () => ({ token: {} }) };

  return {
    Alert: passthrough,
    Button,
    Checkbox,
    Flex: passthrough,
    Form,
    Input,
    Layout,
    Menu,
    Modal,
    Popconfirm: passthrough,
    Select,
    Space: passthrough,
    Switch,
    Tabs,
    Tag: passthrough,
    Typography,
    theme,
  };
});

vi.mock('../AgenticToolConfigForm', async () => {
  const React = await vi.importActual<typeof import('react')>('react');
  const { Form, Input } = await import('antd');

  return {
    AgenticToolConfigForm: ({ agenticTool }: { agenticTool: string }) =>
      React.createElement(
        Form.Item,
        { name: 'permissionMode', label: `${agenticTool} permission` },
        React.createElement(Input, { 'aria-label': `${agenticTool} permission` })
      ),
    buildConfigFromFormValues: (_tool: string, values: { permissionMode?: string }) => ({
      permissionMode: values.permissionMode,
    }),
    getClearedFormValues: () => ({ permissionMode: 'cleared' }),
    getFormValuesFromConfig: (_tool: string, config?: { permissionMode?: string }) => ({
      permissionMode: config?.permissionMode ?? 'default',
    }),
  };
});

vi.mock('../ApiKeyFields', () => ({
  ApiKeyFields: () => null,
  TOOL_FIELD_CONFIGS: {
    'claude-code': [{ field: 'ANTHROPIC_API_KEY' }],
    'claude-code-cli': [{ field: 'ANTHROPIC_API_KEY' }],
    codex: [{ field: 'OPENAI_API_KEY' }],
    gemini: [{ field: 'GEMINI_API_KEY' }],
    opencode: [],
    copilot: [{ field: 'COPILOT_GITHUB_TOKEN' }],
    cursor: [{ field: 'CURSOR_API_KEY' }],
  },
}));

vi.mock('../EmojiPickerInput', () => ({
  FormEmojiPickerInput: () => null,
}));

function makeUser(overrides: Partial<User> = {}): User {
  return {
    user_id: 'user-1' as User['user_id'],
    email: 'me@example.com',
    name: 'Test User',
    role: 'admin',
    onboarding_completed: true,
    must_change_password: false,
    created_at: new Date('2026-01-01T00:00:00Z'),
    default_agentic_config: {
      'claude-code': { permissionMode: 'claude-original' },
      codex: { permissionMode: 'codex-original' },
    },
    ...overrides,
  } as User;
}

function clickToolDefaults(label: string) {
  fireEvent.click(screen.getByRole('menuitem', { name: label }));
  fireEvent.click(screen.getByRole('tab', { name: 'Defaults' }));
}

describe('UserSettingsModal', () => {
  it('saves dirty default settings from multiple agentic tool tabs', async () => {
    const onUpdate = vi.fn(async () => undefined);
    const onClose = vi.fn();
    const user = makeUser();

    render(
      <UserSettingsModal
        open
        onClose={onClose}
        user={user}
        currentUser={user}
        mcpServerById={new Map()}
        client={null}
        onUpdate={onUpdate}
      />
    );

    clickToolDefaults('Claude Code');
    fireEvent.change(screen.getByLabelText('claude-code permission'), {
      target: { value: 'claude-updated' },
    });

    clickToolDefaults('Codex');
    fireEvent.change(screen.getByLabelText('codex permission'), {
      target: { value: 'codex-updated' },
    });

    clickToolDefaults('Claude Code');
    expect(screen.getByLabelText('claude-code permission')).toHaveValue('claude-updated');

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(onUpdate).toHaveBeenCalledTimes(1));
    expect(onUpdate).toHaveBeenCalledWith('user-1', {
      default_agentic_config: {
        'claude-code': { permissionMode: 'claude-updated' },
        codex: { permissionMode: 'codex-updated' },
      },
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('still saves a single active agentic tool tab and preserves untouched tool defaults', async () => {
    const onUpdate = vi.fn(async () => undefined);
    const onClose = vi.fn();
    const user = makeUser();

    render(
      <UserSettingsModal
        open
        onClose={onClose}
        user={user}
        currentUser={user}
        mcpServerById={new Map()}
        client={null}
        onUpdate={onUpdate}
      />
    );

    clickToolDefaults('Claude Code');
    fireEvent.change(screen.getByLabelText('claude-code permission'), {
      target: { value: 'claude-only-updated' },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(onUpdate).toHaveBeenCalledTimes(1));
    expect(onUpdate).toHaveBeenCalledWith('user-1', {
      default_agentic_config: {
        'claude-code': { permissionMode: 'claude-only-updated' },
        codex: { permissionMode: 'codex-original' },
      },
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
