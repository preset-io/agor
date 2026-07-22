import { sanitizeCredential } from '@agor-live/client';
import type { FormInstance } from 'antd';
import type React from 'react';
import { CredentialFieldFeedback } from './CredentialFieldFeedback';
import { useCredentialFields } from './useCredentialField';

/** True when the value carries a `{{ user.env.X }}` style template variable. */
function isTemplateValue(value: string): boolean {
  return value.includes('{{') && value.includes('}}');
}

export interface FormCredentialField {
  /** Spread onto the credential Input inside its Form.Item. */
  inputProps: {
    onBlur: () => void;
    onPaste: (e: React.ClipboardEvent<HTMLInputElement | HTMLTextAreaElement>) => void;
  };
  /** Render below the Form.Item — the opt-in "Clean it up" warning + lint. */
  feedback: React.ReactNode;
}

/**
 * Wire an antd Form field to the shared credential feedback: always-safe sanitize
 * on paste/blur, an opt-in "Clean it up" action for internal whitespace / wrapping
 * quotes, and the format lint. The field value is never rewritten automatically.
 *
 * `allowTemplates` (MCP secret fields) skips fix detection when the value is a
 * `{{ … }}` template — collapsing whitespace there would corrupt the template —
 * while still sanitizing edge/invisible noise.
 */
export function useFormCredential(
  form: FormInstance,
  name: string,
  options: { allowTemplates?: boolean } = {}
): FormCredentialField {
  const credentials = useCredentialFields();

  const inspect = (raw?: string) => {
    const current = raw ?? form.getFieldValue(name);
    if (typeof current !== 'string' || !current) return;
    if (options.allowTemplates && isTemplateValue(current)) {
      form.setFieldsValue({ [name]: sanitizeCredential(current) });
      credentials.reset(name);
      return;
    }
    form.setFieldsValue({ [name]: credentials.inspect(name, current) });
  };

  const cleanUp = () => {
    const current = form.getFieldValue(name);
    if (typeof current !== 'string') return;
    form.setFieldsValue({ [name]: credentials.applyFix(name, current) });
  };

  const state = credentials.get(name);

  return {
    inputProps: {
      onBlur: () => inspect(),
      onPaste: (e) => {
        const el = e.currentTarget;
        window.setTimeout(() => inspect(el.value), 0);
      },
    },
    feedback: <CredentialFieldFeedback lint={state.lint} fix={state.fix} onApplyFix={cleanUp} />,
  };
}
