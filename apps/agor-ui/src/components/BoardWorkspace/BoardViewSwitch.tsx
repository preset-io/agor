import { ApartmentOutlined, AppstoreOutlined } from '@ant-design/icons';
import { Segmented } from 'antd';
import { type BoardView, useBoardViewPreferences } from './useBoardViewPreferences';

export function BoardViewControl({
  view,
  onChange,
}: {
  view: BoardView;
  onChange: (view: BoardView) => void;
}) {
  return (
    <Segmented<BoardView>
      aria-label="Board view"
      value={view}
      onChange={onChange}
      options={[
        { value: 'tree', label: 'Tree', icon: <ApartmentOutlined aria-hidden /> },
        { value: 'board', label: 'Board', icon: <AppstoreOutlined aria-hidden /> },
      ]}
    />
  );
}
/** Shared by both shells; changes presentation, never shared board geometry. */
export function BoardViewSwitch({ userId, boardId }: { userId: string; boardId: string }) {
  const [preferences, updatePreferences] = useBoardViewPreferences(userId, boardId);
  return (
    <BoardViewControl view={preferences.view} onChange={(view) => updatePreferences({ view })} />
  );
}
