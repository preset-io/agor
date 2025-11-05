/**
 * AutocompleteTextarea
 *
 * Textarea with @ mentions autocomplete for files and users.
 * Uses @webscopeio/react-textarea-autocomplete for inline autocomplete.
 */

import type { AgorClient } from '@agor/core/api';
import type { SessionID, User } from '@agor/core/types';
import { Empty, List, Spin, Typography, theme } from 'antd';
import React, { useCallback, useMemo } from 'react';
import ReactTextareaAutocomplete from '@webscopeio/react-textarea-autocomplete';
import '@webscopeio/react-textarea-autocomplete/style.css';
import './AutocompleteTextarea.css';

// Constants
const MAX_FILE_RESULTS = 10;
const MAX_USER_RESULTS = 5;
const DEBOUNCE_MS = 300;

interface FileResult {
  path: string;
  type: 'file';
}

interface UserResult {
  name: string;
  email: string;
  type: 'user';
}

interface AutocompleteEntity {
  heading?: string;
  type?: 'file' | 'user';
  label?: string;
  path?: string;
  name?: string;
  email?: string;
}

interface AutocompleteTextareaProps {
  value: string;
  onChange: (value: string) => void;
  onKeyPress?: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  placeholder?: string;
  client: AgorClient | null;
  sessionId: SessionID | null;
  users: User[];
  autoSize?: {
    minRows?: number;
    maxRows?: number;
  };
}

/**
 * Custom render component for autocomplete items
 */
const AutocompleteItem: React.FC<{ entity: AutocompleteEntity }> = ({ entity }) => {
  if (entity.heading) {
    return (
      <Typography.Text
        type="secondary"
        style={{
          fontSize: '12px',
          fontWeight: 600,
          display: 'block',
          paddingLeft: '8px',
          paddingTop: '4px',
          paddingBottom: '4px',
          textTransform: 'uppercase',
        }}
      >
        {entity.heading}
      </Typography.Text>
    );
  }

  return (
    <Typography.Text ellipsis style={{ display: 'block', padding: '4px 8px' }}>
      {entity.label}
    </Typography.Text>
  );
};

/**
 * Loading component for autocomplete
 */
const LoadingComponent: React.FC = () => {
  return (
    <div style={{ padding: '8px', textAlign: 'center' }}>
      <Spin size="small" />
    </div>
  );
};

/**
 * Extract text at cursor position before the @ trigger
 */
const getAtTokenQuery = (text: string, position: number): string | null => {
  const textBeforeCursor = text.substring(0, position);
  const lastAtIndex = textBeforeCursor.lastIndexOf('@');

  if (lastAtIndex === -1) {
    return null;
  }

  // Check if @ is at start or after whitespace
  const charBeforeAt = lastAtIndex > 0 ? textBeforeCursor[lastAtIndex - 1] : ' ';
  const isValidTrigger = charBeforeAt === ' ' || charBeforeAt === '\n' || lastAtIndex === 0;

  if (!isValidTrigger) {
    return null;
  }

  const query = textBeforeCursor.substring(lastAtIndex + 1);

  // Don't trigger if query contains whitespace (@ is no longer active trigger)
  if (query.includes(' ') || query.includes('\n')) {
    return null;
  }

  return query;
};

/**
 * Add quotes around text if it contains spaces
 */
const quoteIfNeeded = (text: string): string => {
  return text.includes(' ') ? `"${text}"` : text;
};

export const AutocompleteTextarea = React.forwardRef<
  HTMLTextAreaElement,
  AutocompleteTextareaProps
>(
  (
    {
      value,
      onChange,
      onKeyPress,
      placeholder = 'Send a prompt, fork, or create a subsession... (type @ for autocomplete)',
      client,
      sessionId,
      users,
      autoSize,
    },
    ref
  ) => {
    const { token } = theme.useToken();
    const [isLoading, setIsLoading] = React.useState(false);
    const [fileResults, setFileResults] = React.useState<FileResult[]>([]);
    const abortControllerRef = React.useRef<AbortController | null>(null);

    /**
     * Search files in session's worktree
     */
    const searchFiles = useCallback(
      async (query: string) => {
        console.log('[AutocompleteTextarea] searchFiles called:', { sessionId, query, hasClient: !!client });

        if (!client || !sessionId || !query.trim()) {
          console.log('[AutocompleteTextarea] Early return:', { hasClient: !!client, sessionId, query });
          setFileResults([]);
          return;
        }

        if (abortControllerRef.current) {
          abortControllerRef.current.abort();
        }

        setIsLoading(true);
        abortControllerRef.current = new AbortController();

        try {
          console.log('[AutocompleteTextarea] Calling files service:', { sessionId, search: query });
          const result = await client.service('files').find({
            query: { sessionId, search: query },
          });

          console.log('[AutocompleteTextarea] Got result:', result);
          setFileResults(
            Array.isArray(result) ? result : result.data || []
          );
        } catch (error) {
          if ((error as any)?.name !== 'AbortError') {
            console.error('File search error:', error);
          }
          setFileResults([]);
        } finally {
          setIsLoading(false);
        }
      },
      [client, sessionId]
    );

    // Debounce file search
    const debouncedSearchFiles = useMemo(() => {
      let timeoutId: NodeJS.Timeout;

      return (query: string) => {
        clearTimeout(timeoutId);
        timeoutId = setTimeout(() => {
          searchFiles(query);
        }, DEBOUNCE_MS);
      };
    }, [searchFiles]);

    /**
     * Filter users by query (client-side)
     */
    const filterUsers = useCallback(
      (query: string): UserResult[] => {
        if (!query.trim()) {
          return [];
        }

        const lowercaseQuery = query.toLowerCase();
        return users
          .filter(
            (u) =>
              u.name.toLowerCase().includes(lowercaseQuery) ||
              u.email.toLowerCase().includes(lowercaseQuery)
          )
          .slice(0, MAX_USER_RESULTS)
          .map((u) => ({
            name: u.name,
            email: u.email,
            type: 'user' as const,
          }));
      },
      [users]
    );

    /**
     * Build autocomplete options for @ trigger
     */
    const buildAutocompleteOptions = useCallback(
      (query: string): AutocompleteEntity[] => {
        const userResults = filterUsers(query);
        const options: AutocompleteEntity[] = [];

        // Add FILES section if we have file results
        if (fileResults.length > 0) {
          options.push({ heading: 'FILES' });
          options.push(
            ...fileResults.map((f) => ({
              type: 'file' as const,
              path: f.path,
              label: f.path,
            }))
          );
        }

        // Add USERS section if we have user results
        if (userResults.length > 0) {
          options.push({ heading: 'USERS' });
          options.push(
            ...userResults.map((u) => ({
              type: 'user' as const,
              name: u.name,
              email: u.email,
              label: `${u.name} (${u.email})`,
            }))
          );
        }

        // Show loading state if searching
        if (isLoading && fileResults.length === 0 && userResults.length === 0) {
          options.push({
            heading: 'LOADING',
            label: 'Searching files...',
          });
        }

        return options;
      },
      [fileResults, filterUsers, isLoading]
    );

    return (
      <ReactTextareaAutocomplete<AutocompleteEntity>
        ref={ref}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyPress={onKeyPress}
        placeholder={placeholder}
        className="agor-textarea"
        minRows={autoSize?.minRows || 2}
        maxRows={autoSize?.maxRows || 10}
        loadingComponent={LoadingComponent}
        trigger={{
          '@': {
            dataProvider: (token) => {
              debouncedSearchFiles(token);
              return buildAutocompleteOptions(token);
            },
            component: AutocompleteItem,
            output: (item) => {
              // Convert entity to output string
              if (item.path) {
                return quoteIfNeeded(item.path);
              }
              if (item.name) {
                return `@${item.name}`;
              }
              return '';
            },
          },
        }}
      />
    );
  }
);

AutocompleteTextarea.displayName = 'AutocompleteTextarea';
