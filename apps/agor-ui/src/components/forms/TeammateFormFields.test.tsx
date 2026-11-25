import type { Repo } from '@agor-live/client';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Form } from 'antd';
import { useTeammateForm } from '../../hooks/useTeammateForm';
import { TeammateFormFields } from './TeammateFormFields';

it('shows personas before Advanced and carries explicit selection; custom refs and Blank clear public source', async () => {
  const repo = {
    repo_id: 'private-repo',
    default_branch: 'trunk',
    remote_url: 'https://github.com/acme/agor-teammate-private.git',
  } as Repo;
  let fields: ReturnType<typeof useTeammateForm>;
  function Harness() {
    fields = useTeammateForm(repo);
    return (
      <Form form={fields.form} onFieldsChange={fields.validateForm}>
        <TeammateFormFields
          form={fields.form}
          repos={[repo]}
          frameworkRepo={repo}
          onTemplateChange={fields.handleTemplateChange}
          onDisplayNameChange={fields.handleDisplayNameChange}
          customRepoSelected={false}
          onCustomRepoChange={fields.setCustomRepoSelected}
        />
      </Form>
    );
  }
  render(<Harness />);
  expect(screen.getByText('Builder')).toBeInTheDocument();
  fireEvent.click(screen.getByText('Builder'));
  await waitFor(() =>
    expect(fields.form.getFieldsValue(true)).toMatchObject({
      templateId: 'builder',
      sourceBranch: 'template/builder',
      sourceRemoteUrl: 'https://github.com/preset-io/agor-teammate.git',
      emoji: '🛠️',
    })
  );
  await expect(
    fields!.form.validateFields(['templateId', 'sourceBranch', 'sourceRemoteUrl'])
  ).resolves.toMatchObject({
    templateId: 'builder',
    sourceBranch: 'template/builder',
    sourceRemoteUrl: 'https://github.com/preset-io/agor-teammate.git',
  });
  fireEvent.click(screen.getByText('Advanced Teammate Settings'));
  fireEvent.change(await screen.findByPlaceholderText('Public template default'), {
    target: { value: 'my-custom-ref' },
  });
  expect(fields!.form.getFieldsValue(true)).toMatchObject({
    templateId: null,
    sourceBranch: 'my-custom-ref',
    sourceRemoteUrl: undefined,
  });
  fireEvent.click(screen.getByText('Start from scratch'));
  expect(fields!.form.getFieldsValue(true)).toMatchObject({
    templateId: 'blank',
    sourceBranch: undefined,
    sourceRemoteUrl: undefined,
  });
});

it('shows the repository default branch as the source placeholder for a non-fork repo', async () => {
  const repo = {
    repo_id: 'own-repo',
    default_branch: 'trunk',
    remote_url: 'https://github.com/acme/handbook.git',
  } as Repo;
  function Harness() {
    const fields = useTeammateForm(repo);
    return (
      <Form form={fields.form}>
        <TeammateFormFields
          form={fields.form}
          repos={[repo]}
          frameworkRepo={repo}
          onTemplateChange={fields.handleTemplateChange}
          onDisplayNameChange={fields.handleDisplayNameChange}
          customRepoSelected={false}
          onCustomRepoChange={fields.setCustomRepoSelected}
        />
      </Form>
    );
  }
  render(<Harness />);
  fireEvent.click(screen.getByText('Advanced Teammate Settings'));
  expect(await screen.findByPlaceholderText('trunk')).toBeInTheDocument();
});

describe('teammate avatar when choosing a starter persona', () => {
  const repo = {
    repo_id: 'own-repo',
    default_branch: 'trunk',
    remote_url: 'https://github.com/acme/handbook.git',
  } as Repo;
  let fields: ReturnType<typeof useTeammateForm>;

  function Harness() {
    fields = useTeammateForm(repo);
    return (
      <Form form={fields.form}>
        <TeammateFormFields
          form={fields.form}
          repos={[repo]}
          frameworkRepo={repo}
          onTemplateChange={fields.handleTemplateChange}
          onDisplayNameChange={fields.handleDisplayNameChange}
          customRepoSelected={false}
          onCustomRepoChange={fields.setCustomRepoSelected}
        />
      </Form>
    );
  }

  it('keeps an emoji the user already picked', () => {
    render(<Harness />);
    // The emoji picker popover writes the value through this same form field.
    fields.form.setFieldValue('emoji', '🦊');

    fireEvent.click(screen.getByText('Start from scratch'));
    expect(fields.form.getFieldValue('emoji')).toBe('🦊');

    fireEvent.click(screen.getByText('Builder'));
    expect(fields.form.getFieldValue('emoji')).toBe('🦊');
  });

  it('applies each persona emoji while the user has not picked one', () => {
    render(<Harness />);
    expect(fields.form.getFieldValue('emoji')).toBe('🤖');

    fireEvent.click(screen.getByText('Builder'));
    expect(fields.form.getFieldValue('emoji')).toBe('🛠️');

    fireEvent.click(screen.getByText('Start from scratch'));
    expect(fields.form.getFieldValue('emoji')).toBe('✨');
  });
});
