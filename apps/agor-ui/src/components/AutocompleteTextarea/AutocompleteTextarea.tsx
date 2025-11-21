/**
 * AutocompleteTextarea
 *
 * Textarea with autocomplete for:
 * - @ mentions for files, folders, and users
 * - : emoji shortcodes
 * Uses Ant Design Popover for dropdown and native textarea for input.
 * Highlights @ mentions with a background overlay.
 */

import type { AgorClient } from '@agor/core/api';
import type { SessionID, User } from '@agor/core/types';
import { Input, Popover, Spin, Typography, theme } from 'antd';
import React, { useCallback, useMemo, useRef, useState } from 'react';
import { useEmojiAutocomplete } from '@/hooks/useEmojiAutocomplete';
import { mapToArray } from '@/utils/mapHelpers';
import './AutocompleteTextarea.css';

const { TextArea } = Input;
const { Text } = Typography;

// Constants
const _MAX_FILE_RESULTS = 10;
const MAX_USER_RESULTS = 5;
const MAX_EMOJI_RESULTS = 15;
const DEBOUNCE_MS = 300;

interface FileResult {
  path: string;
  type: 'file' | 'folder';
}

interface UserResult {
  name: string;
  email: string;
  type: 'user';
}

interface EmojiResult {
  emoji: string;
  shortcode: string;
  type: 'emoji';
}

type AutocompleteResult = FileResult | UserResult | EmojiResult | { heading: string };

interface AutocompleteTextareaProps {
  value: string;
  onChange: (value: string) => void;
  onKeyPress?: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  placeholder?: string;
  client: AgorClient | null;
  sessionId: SessionID | null;
  userById: Map<string, User>;
  autoSize?: {
    minRows?: number;
    maxRows?: number;
  };
}

/**
 * Extract text at cursor position before a trigger character (@ or :)
 */
const getTriggerQuery = (
  text: string,
  position: number,
  trigger: '@' | ':'
): { query: string; triggerIndex: number } | null => {
  const textBeforeCursor = text.substring(0, position);
  const lastTriggerIndex = textBeforeCursor.lastIndexOf(trigger);

  if (lastTriggerIndex === -1) {
    return null;
  }

  // Check if trigger is at start or after whitespace
  const charBeforeTrigger = lastTriggerIndex > 0 ? textBeforeCursor[lastTriggerIndex - 1] : ' ';
  const isValidTrigger =
    charBeforeTrigger === ' ' || charBeforeTrigger === '\n' || lastTriggerIndex === 0;

  if (!isValidTrigger) {
    return null;
  }

  const query = textBeforeCursor.substring(lastTriggerIndex + 1);

  // Don't trigger if query contains whitespace
  if (query.includes(' ') || query.includes('\n')) {
    return null;
  }

  return { query, triggerIndex: lastTriggerIndex };
};

/**
 * Add quotes around text if it contains spaces
 */
const quoteIfNeeded = (text: string): string => {
  return text.includes(' ') ? `"${text}"` : text;
};

/**
 * Highlight @ mentions in text
 * Returns JSX with highlighted mentions
 */
const highlightMentions = (text: string, highlightColor: string): React.ReactNode[] => {
  // Match @ followed by either:
  // 1. Quoted text: @"anything including spaces"
  // 2. Unquoted text: @word (until space/newline)
  const mentionRegex = /@(?:"[^"]*"|[^\s]+)/g;
  const parts: React.ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null = mentionRegex.exec(text);

  while (match !== null) {
    // Add text before mention
    if (match.index > lastIndex) {
      parts.push(text.substring(lastIndex, match.index));
    }

    // Add highlighted mention
    parts.push(
      <span
        key={`mention-${match.index}`}
        style={{
          backgroundColor: highlightColor,
          borderRadius: '3px',
          padding: '0 2px',
          fontWeight: 600,
        }}
      >
        {match[0]}
      </span>
    );

    lastIndex = match.index + match[0].length;
    match = mentionRegex.exec(text);
  }

  // Add remaining text
  if (lastIndex < text.length) {
    parts.push(text.substring(lastIndex));
  }

  return parts;
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
      placeholder = 'Send a prompt, fork, or create a subsession... (type @ for files/users, : for emojis)',
      client,
      sessionId,
      userById,
      autoSize,
    },
    ref
  ) => {
    const { token } = theme.useToken();
    const textareaRef = useRef<{ current: HTMLTextAreaElement | null }>({ current: null });
    const popoverContentRef = useRef<HTMLDivElement>(null);
    const debounceTimerRef = useRef<NodeJS.Timeout | null>(null);
    const { searchEmojis } = useEmojiAutocomplete();

    // Autocomplete state
    const [showPopover, setShowPopover] = useState(false);
    const [triggerType, setTriggerType] = useState<'@' | ':' | null>(null);
    const [triggerIndex, setTriggerIndex] = useState(-1);
    const [query, setQuery] = useState('');
    const [isLoading, setIsLoading] = useState(false);
    const [fileResults, setFileResults] = useState<FileResult[]>([]);
    const [emojiResults, setEmojiResults] = useState<EmojiResult[]>([]);
    const [highlightedIndex, setHighlightedIndex] = useState(-1);

    // Scroll synchronization state
    const [scrollTop, setScrollTop] = useState(0);
    const overlayRef = useRef<HTMLDivElement>(null);

    /**
     * Synchronize overlay scroll with textarea scroll
     */
    React.useEffect(() => {
      const textarea = textareaRef.current?.current;
      if (!textarea) return;

      const handleScroll = () => {
        setScrollTop(textarea.scrollTop);
      };

      textarea.addEventListener('scroll', handleScroll);
      return () => {
        textarea.removeEventListener('scroll', handleScroll);
      };
    }, []);

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
          const result = await client.service('files').find({
            query: { sessionId, search: searchQuery },
          });

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
        return mapToArray(userById)
          .filter(
            (u: User) =>
              u.name?.toLowerCase().includes(lowercaseQuery) ||
              u.email.toLowerCase().includes(lowercaseQuery)
          )
          .slice(0, MAX_USER_RESULTS)
          .map((u: User) => ({
            name: u.name || u.email,
            email: u.email,
            type: 'user' as const,
          }));
      },
      [userById]
    );

    /**
     * Build autocomplete options with categories
     */
    const autocompleteOptions = useMemo(() => {
      const options: AutocompleteResult[] = [];

      if (triggerType === '@') {
        // @ trigger: show files and users
        if (fileResults.length > 0) {
          options.push({ heading: 'FILES & FOLDERS' });
          options.push(...fileResults);
        }

        const userResults = filterUsers(query);
        if (userResults.length > 0) {
          options.push({ heading: 'USERS' });
          options.push(...userResults);
        }
      } else if (triggerType === ':') {
        // : trigger: show emojis
        if (emojiResults.length > 0) {
          options.push({ heading: 'EMOJIS' });
          options.push(...emojiResults);
        }
      }

      return options;
    }, [triggerType, fileResults, emojiResults, query, filterUsers]);

    /**
     * Auto-highlight first selectable item when options change
     */
    React.useEffect(() => {
      if (autocompleteOptions.length > 0 && showPopover) {
        // Find first non-heading item and highlight it
        const firstItemIndex = autocompleteOptions.findIndex((item) => !('heading' in item));
        if (firstItemIndex >= 0) {
          setHighlightedIndex(firstItemIndex);
        }
      } else {
        setHighlightedIndex(-1);
      }
    }, [autocompleteOptions, showPopover]);

    /**
     * Clamp highlighted index when options list changes to prevent out of bounds access
     */
    React.useEffect(() => {
      if (highlightedIndex >= autocompleteOptions.length) {
        // Find last selectable item
        let lastSelectableIndex = -1;
        for (let i = autocompleteOptions.length - 1; i >= 0; i--) {
          if (!('heading' in autocompleteOptions[i])) {
            lastSelectableIndex = i;
            break;
          }
        }
        setHighlightedIndex(lastSelectableIndex);
      }
    }, [autocompleteOptions, highlightedIndex]);

    /**
     * Handle textarea change
     */
    const handleChange = useCallback(
      (e: React.ChangeEvent<HTMLTextAreaElement>) => {
        const newValue = e.target.value;
        onChange(newValue);

        const cursorPos = e.target.selectionStart || 0;

        // Check for @ trigger first
        const atTrigger = getTriggerQuery(newValue, cursorPos, '@');
        if (atTrigger) {
          setTriggerType('@');
          setQuery(atTrigger.query);
          setTriggerIndex(atTrigger.triggerIndex);
          setEmojiResults([]);

          // Debounced search for files
          if (debounceTimerRef.current) {
            clearTimeout(debounceTimerRef.current);
          }
          debounceTimerRef.current = setTimeout(() => {
            searchFiles(atTrigger.query);
          }, DEBOUNCE_MS);

          setShowPopover(true);
          return;
        }

        // Check for : trigger (emoji)
        const colonTrigger = getTriggerQuery(newValue, cursorPos, ':');
        if (colonTrigger) {
          setTriggerType(':');
          setQuery(colonTrigger.query);
          setTriggerIndex(colonTrigger.triggerIndex);
          setFileResults([]);
          setIsLoading(false); // Reset loading state when switching to emoji trigger

          // Instant emoji search (no debounce needed)
          const emojis = searchEmojis(colonTrigger.query);
          setEmojiResults(
            emojis.slice(0, MAX_EMOJI_RESULTS).map((e) => ({
              emoji: e.emoji,
              shortcode: e.shortcode,
              type: 'emoji' as const,
            }))
          );

          setShowPopover(true);
          return;
        }

        // No trigger detected
        setShowPopover(false);
        setTriggerType(null);
        setFileResults([]);
        setEmojiResults([]);
        setHighlightedIndex(-1);
      },
      [onChange, searchFiles, searchEmojis]
    );

    /**
     * Handle item selection
     */
    const handleSelect = useCallback(
      (item: FileResult | UserResult | EmojiResult) => {
        if (triggerIndex === -1) return;

        const cursorPos = textareaRef.current.current?.selectionStart || 0;
        const textBeforeCursor = value.substring(0, cursorPos);
        const queryLength = textBeforeCursor.substring(triggerIndex + 1).length;

        let insertText = '';
        let addTrailingSpace = true;

        if ('emoji' in item) {
          // Emoji selection - just insert the emoji character
          insertText = item.emoji;
          addTrailingSpace = false; // Don't add space after emoji to match Slack behavior
        } else if ('path' in item) {
          // File selection
          insertText = `@${quoteIfNeeded(item.path)}`;
        } else {
          // User selection
          insertText = `@${item.name}`;
        }

        const newValue =
          value.substring(0, triggerIndex) +
          insertText +
          (addTrailingSpace ? ' ' : '') +
          value.substring(triggerIndex + 1 + queryLength);

        onChange(newValue);
        setShowPopover(false);
        setTriggerType(null);
        setFileResults([]);
        setEmojiResults([]);
        setHighlightedIndex(-1);

        // Move cursor after inserted value
        setTimeout(() => {
          const newCursorPos = triggerIndex + insertText.length + (addTrailingSpace ? 1 : 0);
          textareaRef.current.current?.setSelectionRange(newCursorPos, newCursorPos);
          textareaRef.current.current?.focus();
        }, 0);
      },
      [triggerIndex, value, onChange]
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
              setHighlightedIndex((prev) => {
                // Find next non-heading item
                let nextIndex = prev + 1;
                while (nextIndex < autocompleteOptions.length) {
                  if (!('heading' in autocompleteOptions[nextIndex])) {
                    return nextIndex;
                  }
                  nextIndex++;
                }
                return prev; // No more selectable items
              });
            }
            break;

          case 'ArrowUp':
            if (isPopoverOpen) {
              e.preventDefault();
              e.stopPropagation();
              setHighlightedIndex((prev) => {
                // Find previous non-heading item
                let prevIndex = prev - 1;
                while (prevIndex >= 0) {
                  if (!('heading' in autocompleteOptions[prevIndex])) {
                    return prevIndex;
                  }
                  prevIndex--;
                }
                return -1; // No more selectable items, reset to nothing highlighted
              });
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
                const firstItem = autocompleteOptions.find((item) => !('heading' in item));
                if (firstItem) {
                  const idx = autocompleteOptions.indexOf(firstItem);
                  setHighlightedIndex(idx);
                }
              }
            }
            break;

          case 'Enter':
            if (isPopoverOpen) {
              e.preventDefault();
              e.stopPropagation();

              // If something is highlighted, select it
              if (highlightedIndex >= 0) {
                const item = autocompleteOptions[highlightedIndex];
                if (!('heading' in item)) {
                  handleSelect(item as FileResult | UserResult | EmojiResult);
                }
              } else {
                // Nothing highlighted - select first non-heading item (like Slack)
                const firstItem = autocompleteOptions.find((item) => !('heading' in item));
                if (firstItem) {
                  handleSelect(firstItem as FileResult | UserResult | EmojiResult);
                }
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

            // Determine label based on item type
            let label = '';
            let itemKey = '';
            let isFolder = false;

            if ('emoji' in item) {
              label = `${item.emoji} :${item.shortcode}:`;
              itemKey = `emoji-${item.shortcode}`;
            } else if ('path' in item) {
              label = item.path;
              itemKey = `file-${item.path}`;
              isFolder = item.type === 'folder';
            } else {
              label = `${item.name} (${item.email})`;
              itemKey = `user-${item.name}`;
            }

            const isHighlighted = highlightedIndex === idx;

            return (
              <div
                key={itemKey}
                onClick={() => handleSelect(item)}
                style={{
                  padding: `${token.paddingXS}px ${token.paddingSM}px`,
                  cursor: 'pointer',
                  transition: 'background-color 0.2s',
                  fontSize: token.fontSize,
                  lineHeight: 1.4,
                  backgroundColor: isHighlighted ? token.colorPrimaryBg : 'transparent',
                  color: isHighlighted ? token.colorPrimary : token.colorText,
                  display: 'flex',
                  alignItems: 'center',
                  gap: token.paddingXS,
                }}
                onMouseEnter={(e) => {
                  setHighlightedIndex(idx);
                  e.currentTarget.style.backgroundColor = token.colorBgTextHover;
                }}
                onMouseLeave={(e) => {
                  setHighlightedIndex(-1);
                  e.currentTarget.style.backgroundColor = 'transparent';
                }}
              >
                {/* Show emoji larger if it's an emoji result */}
                {'emoji' in item && (
                  <span style={{ fontSize: 20, lineHeight: 1 }}>{item.emoji}</span>
                )}
                {/* Show folder icon for folders */}
                {isFolder && <span style={{ opacity: 0.6 }}>📁</span>}
                <Text ellipsis style={{ flex: 1 }}>
                  {'emoji' in item ? `:${item.shortcode}:` : label}
                </Text>
              </div>
            );
          })}
      </div>
    );

    // Compute highlighted text
    const highlightColor = token.colorBgTextHover;
    const hasHighlights = value?.includes('@') ?? false;

    return (
      <Popover
        content={popoverContent}
        open={showPopover && autocompleteOptions.length > 0}
        trigger={[]}
        placement="bottomLeft"
        overlayStyle={{ paddingTop: 4 }}
      >
        <div style={{ position: 'relative', width: '100%' }}>
          {/* Highlighting overlay (behind textarea) */}
          {hasHighlights && (
            <div
              ref={overlayRef}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                right: 0,
                bottom: 0,
                pointerEvents: 'none',
                whiteSpace: 'pre-wrap',
                wordWrap: 'break-word',
                color: 'transparent',
                overflow: 'hidden',
                fontFamily: token.fontFamily,
                fontSize: token.fontSize,
                lineHeight: token.lineHeight,
                padding: '4px 11px',
                border: '1px solid transparent',
                borderRadius: token.borderRadius,
                zIndex: 0,
              }}
              aria-hidden="true"
            >
              <div
                style={{
                  transform: `translateY(-${scrollTop}px)`,
                }}
              >
                {highlightMentions(value, highlightColor)}
              </div>
            </div>
          )}

          {/* Textarea (with transparent background to show highlights) */}
          <TextArea
            ref={(node) => {
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
            className="agor-textarea agor-textarea-with-highlights"
            style={{
              borderColor: token.colorBorder,
              backgroundColor: hasHighlights ? 'transparent' : undefined,
              position: 'relative',
              zIndex: 1,
            }}
          />
        </div>
      </Popover>
    );
  }
);

AutocompleteTextarea.displayName = 'AutocompleteTextarea';
