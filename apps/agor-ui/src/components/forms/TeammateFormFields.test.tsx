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
  fireEvent.change(await screen.findByPlaceholderText('trunk'), {
    target: { value: 'my-custom-ref' },
  });
  expect(fields!.form.getFieldsValue(true)).toMatchObject({
    templateId: null,
    sourceBranch: 'my-custom-ref',
    sourceRemoteUrl: undefined,
  });
  fireEvent.click(screen.getByText('Start blank'));
  expect(fields!.form.getFieldsValue(true)).toMatchObject({
    templateId: 'blank',
    sourceBranch: undefined,
    sourceRemoteUrl: undefined,
  });
});
