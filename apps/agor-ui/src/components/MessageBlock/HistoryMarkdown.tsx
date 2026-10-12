import { createContext, useContext, useState } from 'react';
import { CollapsibleMarkdown } from '../CollapsibleText/CollapsibleMarkdown';

// Owned by the mounted conversation, not individual text blocks: hydration can
// remount a block or temporarily remove it. Nothing is persisted or shared.
export const HistoryTextChoices = createContext<{
  choices: Map<string, boolean>;
  setChoice: (key: string, expanded: boolean) => void;
} | null>(null);

/** Choice keys name their turn, so the conversation can forget a trimmed turn's choices. */
export const historyTextKey = (taskId: string | undefined, part: string) =>
  `task:${taskId}:${part}`;
export const historyTextKeyTurn = (key: string) => key.split(':')[1];

export function HistoryMarkdown({
  textKey,
  defaultExpanded,
  isStreaming,
  children,
}: {
  textKey: string;
  defaultExpanded: boolean;
  isStreaming: boolean;
  children: string;
}) {
  const history = useContext(HistoryTextChoices);
  const [localChoice, setLocalChoice] = useState<boolean>();
  const choice = history ? history.choices.get(textKey) : localChoice;
  return (
    <CollapsibleMarkdown
      expanded={choice ?? defaultExpanded}
      isStreaming={isStreaming}
      onExpandedChange={(expanded) => {
        if (history) history.setChoice(textKey, expanded);
        else setLocalChoice(expanded);
      }}
    >
      {children}
    </CollapsibleMarkdown>
  );
}
