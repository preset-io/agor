/**
 * AutocompleteTextarea
 *
 * Textarea with @ mentions autocomplete for files and users.
 * Uses Ant Design Popover for dropdown and native textarea for input.
 */

import type { AgorClient } from '@agor/core/api';
import type { SessionID, User } from '@agor/core/types';
import { Input, Popover, Spin, Typography, theme } from 'antd';
import React, { useCallback, useMemo, useRef, useState } from 'react';
import './AutocompleteTextarea.css';

const { TextArea } = Input;
const { Text } = Typography;

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

type AutocompleteResult = FileResult | UserResult | { heading: string };

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

  // Don't trigger if query contains whitespace
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
    const textareaRef = useRef<{ current: HTMLTextAreaElement | null }>({ current: null });
    const popoverContentRef = useRef<HTMLDivElement>(null);
    const debounceTimerRef = useRef<NodeJS.Timeout | null>(null);

    // Autocomplete state
    const [showPopover, setShowPopover] = useState(false);
    const [atIndex, setAtIndex] = useState(-1);
    const [query, setQuery] = useState('');
    const [isLoading, setIsLoading] = useState(false);
    const [fileResults, setFileResults] = useState<FileResult[]>([]);
    const [highlightedIndex, setHighlightedIndex] = useState(-1);

    /**
     * Scroll highlighted item into view
     */
    React.useEffect(() => {
      if (highlightedIndex >= 0 && popoverContentRef.current) {
        const children = popoverContentRef.current.children;
        if (highlightedIndex < children.length) {
          const highlightedElement = children[highlightedIndex];
          if (highlightedElement) {
            highlightedElement.scrollIntoView({
              behavior: 'smooth',
              block: 'nearest',
            });
          }
        }
      }
    }, [highlightedIndex]);

    /**
     * Search files in session's worktree
     */
    const searchFiles = useCallback(
      async (searchQuery: string) => {
        if (!client || !sessionId || !searchQuery.trim()) {
          setFileResults([]);
          return;
        }

        setIsLoading(true);

        try {
          console.log('[AutocompleteTextarea] Calling files service:', {
            sessionId,
            search: searchQuery,
          });
          const result = await client.service('files').find({
            query: { sessionId, search: searchQuery },
          });

          console.log('[AutocompleteTextarea] Got result:', result);
          setFileResults(
            Array.isArray(result) ? (result as FileResult[]) : (result?.data as FileResult[]) || []
          );
        } catch (error) {
          console.error('File search error:', error);
          setFileResults([]);
        } finally {
          setIsLoading(false);
        }
      },
      [client, sessionId]
    );

    /**
     * Filter users by query
     */
    const filterUsers = useCallback(
      (searchQuery: string): UserResult[] => {
        if (!searchQuery.trim()) {
          return [];
        }

        const lowercaseQuery = searchQuery.toLowerCase();
        return users
          .filter(
            u =>
              (u.name && u.name.toLowerCase().includes(lowercaseQuery)) ||
              u.email.toLowerCase().includes(lowercaseQuery)
          )
          .slice(0, MAX_USER_RESULTS)
          .map(u => ({
            name: u.name || u.email,
            email: u.email,
            type: 'user' as const,
          }));
      },
      [users]
    );

    /**
     * Build autocomplete options with categories
     */
    const autocompleteOptions = useMemo(() => {
      const options: AutocompleteResult[] = [];

      if (fileResults.length > 0) {
        options.push({ heading: 'FILES' });
        options.push(...fileResults);
      }

      const userResults = filterUsers(query);
      if (userResults.length > 0) {
        options.push({ heading: 'USERS' });
        options.push(...userResults);
      }

      return options;
    }, [fileResults, query, filterUsers]);

    /**
     * Handle textarea change
     */
    const handleChange = useCallback(
      (e: React.ChangeEvent<HTMLTextAreaElement>) => {
        const newValue = e.target.value;
        onChange(newValue);

        const cursorPos = e.target.selectionStart || 0;
        const atQuery = getAtTokenQuery(newValue, cursorPos);

        if (atQuery !== null) {
          setQuery(atQuery);
          setAtIndex(newValue.lastIndexOf('@'));

          // Debounced search
          if (debounceTimerRef.current) {
            clearTimeout(debounceTimerRef.current);
          }
          debounceTimerRef.current = setTimeout(() => {
            searchFiles(atQuery);
          }, DEBOUNCE_MS);

          setShowPopover(true);
        } else {
          setShowPopover(false);
          setFileResults([]);
          setHighlightedIndex(-1);
        }
      },
      [onChange, searchFiles]
    );

    /**
     * Handle item selection
     */
    const handleSelect = useCallback(
      (item: FileResult | UserResult) => {
        if (atIndex === -1) return;

        const cursorPos = textareaRef.current.current?.selectionStart || 0;
        const textBeforeCursor = value.substring(0, cursorPos);
        const atQueryLength = textBeforeCursor.substring(atIndex + 1).length;

        let insertText = '';
        if ('path' in item) {
          insertText = `@${quoteIfNeeded(item.path)}`;
        } else {
          insertText = `@${item.name}`;
        }

        const newValue =
          value.substring(0, atIndex) +
          insertText +
          ' ' +
          value.substring(atIndex + 1 + atQueryLength);

        onChange(newValue);
        setShowPopover(false);
        setFileResults([]);
        setHighlightedIndex(-1);

        // Move cursor after inserted value
        setTimeout(() => {
          const newCursorPos = atIndex + insertText.length + 1;
          textareaRef.current.current?.setSelectionRange(newCursorPos, newCursorPos);
          textareaRef.current.current?.focus();
        }, 0);
      },
      [atIndex, value, onChange]
    );

    /**
     * Handle keyboard navigation in popover
     */
    const handleKeyDown = useCallback(
      (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        const isPopoverOpen = showPopover && autocompleteOptions.length > 0;

        switch (e.key) {
          case 'ArrowDown':
            if (isPopoverOpen) {
              e.preventDefault();
              e.stopPropagation();
              setHighlightedIndex(prev =>
                prev < autocompleteOptions.length - 1 ? prev + 1 : prev
              );
            }
            break;

          case 'ArrowUp':
            if (isPopoverOpen) {
              e.preventDefault();
              e.stopPropagation();
              setHighlightedIndex(prev => (prev > 0 ? prev - 1 : -1));
            }
            break;

          case 'Tab':
            if (isPopoverOpen) {
              // Tab to select highlighted item (like Enter)
              e.preventDefault();
              e.stopPropagation();
              if (highlightedIndex >= 0) {
                const item = autocompleteOptions[highlightedIndex];
                if (!('heading' in item)) {
                  handleSelect(item as FileResult | UserResult);
                }
              } else if (autocompleteOptions.length > 0) {
                // If nothing highlighted, highlight first non-heading item
                const firstItem = autocompleteOptions.find(item => !('heading' in item));
                if (firstItem) {
                  const idx = autocompleteOptions.indexOf(firstItem);
                  setHighlightedIndex(idx);
                }
              }
            }
            break;

          case 'Enter':
            if (isPopoverOpen && highlightedIndex >= 0) {
              e.preventDefault();
              e.stopPropagation();
              const item = autocompleteOptions[highlightedIndex];
              if (!('heading' in item)) {
                handleSelect(item as FileResult | UserResult);
              }
            } else if (!isPopoverOpen && onKeyPress) {
              // Popover closed, let parent handle Enter to send prompt
              onKeyPress(e);
            }
            break;

          case 'Escape':
            if (isPopoverOpen) {
              e.preventDefault();
              e.stopPropagation();
              setShowPopover(false);
            }
            break;

          default:
            // For other keys, call parent handler if provided
            if (!isPopoverOpen && onKeyPress) {
              onKeyPress(e);
            }
        }
      },
      [showPopover, autocompleteOptions, highlightedIndex, handleSelect, onKeyPress]
    );

    /**
     * Render popover content
     */
    const popoverContent = (
      <div
        ref={popoverContentRef}
        style={{
          maxHeight: '300px',
          overflowY: 'auto',
          minWidth: '250px',
          border: `1px solid ${token.colorBorder}`,
          borderRadius: token.borderRadius,
        }}
      >
        {isLoading && (
          <div
            style={{
              padding: `${token.paddingXS}px ${token.paddingSM}px`,
              textAlign: 'center',
            }}
          >
            <Spin size="small" />
          </div>
        )}

        {!isLoading && autocompleteOptions.length === 0 && (
          <div
            style={{
              padding: `${token.paddingXS}px ${token.paddingSM}px`,
              color: token.colorTextSecondary,
              fontSize: token.fontSizeSM,
            }}
          >
            No results
          </div>
        )}

        {!isLoading &&
          autocompleteOptions.map((item, idx) => {
            if ('heading' in item) {
              return (
                <div
                  key={`heading-${item.heading}`}
                  style={{
                    position: 'sticky',
                    top: 0,
                    padding: `${token.paddingXS}px ${token.paddingSM}px`,
                    fontSize: token.fontSizeSM,
                    fontWeight: 600,
                    color: token.colorTextSecondary,
                    backgroundColor: token.colorBgContainer,
                    textTransform: 'uppercase',
                    borderBottom: `1px solid ${token.colorBorder}`,
                    marginTop: idx > 0 ? token.paddingXS : 0,
                    zIndex: 10,
                  }}
                >
                  {item.heading}
                </div>
              );
            }

            const label = 'path' in item ? item.path : `${item.name} (${item.email})`;
            const isHighlighted = highlightedIndex === idx;

            return (
              <div
                key={label}
                onClick={() => handleSelect(item)}
                style={{
                  padding: `${token.paddingXS}px ${token.paddingSM}px`,
                  cursor: 'pointer',
                  transition: 'background-color 0.2s',
                  fontSize: token.fontSize,
                  lineHeight: 1.4,
                  backgroundColor: isHighlighted ? token.colorPrimaryBg : 'transparent',
                  color: isHighlighted ? token.colorPrimary : token.colorText,
                }}
                onMouseEnter={e => {
                  setHighlightedIndex(idx);
                  e.currentTarget.style.backgroundColor = token.colorBgTextHover;
                }}
                onMouseLeave={e => {
                  setHighlightedIndex(-1);
                  e.currentTarget.style.backgroundColor = 'transparent';
                }}
              >
                <Text ellipsis>{label}</Text>
              </div>
            );
          })}
      </div>
    );

    return (
      <Popover
        content={popoverContent}
        open={showPopover && autocompleteOptions.length > 0}
        trigger={[]}
        placement="bottomLeft"
        overlayStyle={{ paddingTop: 4 }}
      >
        <TextArea
          ref={node => {
            let textarea: HTMLTextAreaElement | null = null;
            if (
              node &&
              typeof node === 'object' &&
              'resizableTextArea' in node &&
              node.resizableTextArea &&
              typeof node.resizableTextArea === 'object' &&
              'textArea' in node.resizableTextArea &&
              node.resizableTextArea.textArea instanceof HTMLTextAreaElement
            ) {
              textarea = node.resizableTextArea.textArea;
            }
            if (textarea) {
              textareaRef.current.current = textarea;
              if (typeof ref === 'function') {
                ref(textarea);
              } else if (ref) {
                try {
                  ref.current = textarea;
                } catch {
                  // Read-only ref, ignore
                }
              }
            }
          }}
          value={value}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          autoSize={autoSize || { minRows: 2, maxRows: 10 }}
          className="agor-textarea"
          style={{
            borderColor: token.colorBorder,
          }}
        />
      </Popover>
    );
  }
);

AutocompleteTextarea.displayName = 'AutocompleteTextarea';
