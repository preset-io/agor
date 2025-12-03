# Themed Component Guidelines

This document outlines the proper way to use themed UI components in the Agor UI to ensure consistent dark mode styling and better user experience.

## ⚠️ DO NOT Use Raw Ant Design APIs

**NEVER** import or use these directly:
- ❌ `Modal.confirm()`, `Modal.info()`, `Modal.warning()`, `Modal.error()`, `Modal.success()`
- ❌ `message.success()`, `message.error()`, `message.warning()`, `message.info()`, `message.loading()`
- ❌ Direct imports: `import { Modal, message } from 'antd'` (for these specific APIs)

These bypass the App context and don't receive proper theming.

## ✅ Use Themed Utilities Instead

### For Modals (Confirm Dialogs)

**Use `useThemedModal` hook:**

```tsx
import { useThemedModal } from '@/utils/modal';

function MyComponent() {
  const { confirm, info, warning, error, success } = useThemedModal();

  const handleDelete = () => {
    confirm({
      title: 'Delete Item?',
      content: 'This action cannot be undone.',
      okText: 'Delete',
      okType: 'danger',
      onOk: async () => {
        await deleteItem();
      },
    });
  };

  return <Button onClick={handleDelete}>Delete</Button>;
}
```

**Available methods:**
- `confirm(options)` - Confirmation dialog
- `info(options)` - Information dialog
- `warning(options)` - Warning dialog
- `error(options)` - Error dialog
- `success(options)` - Success dialog

### For Messages (Toasts/Notifications)

**Use `useThemedMessage` hook:**

```tsx
import { useThemedMessage } from '@/utils/message';

function MyComponent() {
  const { showSuccess, showError, showWarning, showInfo, showLoading } = useThemedMessage();

  const handleSave = async () => {
    try {
      await saveData();
      showSuccess('Data saved successfully!');
    } catch (error) {
      showError(error instanceof Error ? error.message : 'Failed to save');
    }
  };

  return <Button onClick={handleSave}>Save</Button>;
}
```

**Available methods:**
- `showSuccess(content, options?)` - Success message
- `showError(content, options?)` - Error message (longer duration by default)
- `showWarning(content, options?)` - Warning message
- `showInfo(content, options?)` - Info message
- `showLoading(content, options?)` - Loading message (requires manual dismiss)
- `destroy(key?)` - Dismiss a message

**Features:**
- ✨ Automatic dark mode theming
- 📋 Copy-to-clipboard on all messages (click the copy icon)
- ⏱️ Smart durations (errors last longer for copying)
- 🎨 Consistent styling across the app

## Why This Matters

1. **Theming**: Raw Ant Design APIs don't receive theme tokens and appear broken in dark mode
2. **User Experience**: Our themed utilities add copy-to-clipboard and better error handling
3. **Consistency**: Ensures all dialogs and messages look the same across the app
4. **Future-Proof**: Easier to update styling globally

## Examples from the Codebase

### ✅ Good Example (Nuke Environment Modal)

```tsx
// EnvironmentTab.tsx
import { useThemedModal } from '../../../utils/modal';

export const EnvironmentTab = () => {
  const { confirm } = useThemedModal();

  const handleNuke = () => {
    confirm({
      title: 'Nuke Environment?',
      icon: <FireOutlined style={{ color: '#ff4d4f' }} />,
      content: 'This is destructive!',
      okText: 'Yes, Nuke It',
      okType: 'danger',
      onOk: async () => {
        await nukeEnvironment();
      },
    });
  };
};
```

### ❌ Bad Example (Don't do this)

```tsx
// DON'T DO THIS!
import { Modal, message } from 'antd';

export const BadComponent = () => {
  const handleDelete = () => {
    Modal.confirm({  // ❌ Bypasses theming
      title: 'Delete?',
      onOk: () => {
        deleteItem();
        message.success('Deleted!');  // ❌ No copy-to-clipboard
      },
    });
  };
};
```

## Code Review Checklist

When reviewing PRs, check for:
- [ ] No direct `Modal.confirm/info/warning/error/success` calls
- [ ] No direct `message.success/error/warning/info` calls
- [ ] All modals use `useThemedModal()`
- [ ] All toast messages use `useThemedMessage()`
- [ ] Imports are from `@/utils/modal` and `@/utils/message`
- [ ] `<Modal>` component usage is allowed (for custom modal rendering)

## Migration Guide

If you find code using raw APIs:

1. Add the import:
   ```tsx
   import { useThemedModal } from '@/utils/modal';
   // or
   import { useThemedMessage } from '@/utils/message';
   ```

2. Call the hook at the component level:
   ```tsx
   const { confirm } = useThemedModal();
   const { showSuccess } = useThemedMessage();
   ```

3. Replace the calls:
   ```tsx
   // Before
   Modal.confirm({ ... })
   message.success('Done!')

   // After
   confirm({ ... })
   showSuccess('Done!')
   ```

4. Remove the unused imports:
   ```tsx
   // Remove these from antd imports
   import { Modal, message } from 'antd';  // ❌
   ```

---

**Questions?** Check the implementations in:
- `apps/agor-ui/src/utils/modal.tsx`
- `apps/agor-ui/src/utils/message.tsx`
