import type { AgorClient, BoardFileItem, BoardFileKind, BoardFileSort } from '@agor-live/client';
import { FilterOutlined, FolderOutlined, SearchOutlined } from '@ant-design/icons';
import VirtualList from '@rc-component/virtual-list';
import { Badge, Button, Flex, Input, Popover, Select, Skeleton, Typography, theme } from 'antd';
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useBoardViewContext } from '../../contexts/BoardViewContext';
import { useBoardFiles } from '../../hooks/useBoardFiles';
import { boardFilePreviewTarget, isPreviewing } from '../../hooks/useBoardPreview';
import { useAgorStore } from '../../store/agorStore';
import { makeBoardSelector, makeBranchSelector } from '../../store/selectors';
import { teammateLabel } from '../../utils/teammateLabels';
import { HomeCard, HomeSectionError } from '../HomePage/HomeSection';
import { homeDivider } from '../HomePage/homeLayout';
import { BoardFileRow, BoardFileTile, LoadMoreSentinel } from './BoardFileRow';

type TypeFilter = BoardFileKind | 'all';
type FilesView = 'list' | 'grid';

const TYPE_OPTIONS: { value: TypeFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'artifact', label: 'Artifacts' },
  { value: 'document', label: 'Documents' },
  { value: 'app', label: 'Apps and pull requests' },
  { value: 'upload', label: 'Uploads' },
];
const SORT_OPTIONS: { value: BoardFileSort; label: string }[] = [
  { value: 'recent', label: 'Recent' },
  { value: 'name', label: 'Name' },
  { value: 'type', label: 'Type' },
];
const VIEW_OPTIONS: { value: FilesView; label: string }[] = [
  { value: 'list', label: 'List' },
  { value: 'grid', label: 'Grid' },
];

/** Under this width the Selects move into the Filters button, like Home's compact toolbar. */
export const BOARD_FILES_COMPACT_WIDTH = 600;
/** A two-line Home row and its hairline; rows are measured, this only seeds the list. */
const ROW_HEIGHT_ESTIMATE = 61;
const SENTINEL = { sentinel: true } as const;

/** The element's content box, kept current. */
function useElementSize(ref: React.RefObject<HTMLElement | null>) {
  const [size, setSize] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => setSize({ width: element.clientWidth, height: element.clientHeight });
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    measure();
    return () => observer.disconnect();
  }, [ref]);
  return size;
}

interface BoardFilesProps {
  client: AgorClient | null;
  boardId: string;
  /** The tab is on screen: the first page reloads and live updates apply. */
  active: boolean;
  /** Phones: Search and Type only, full width, no outer padding. */
  mobile?: boolean;
}

/**
 * The board's Files: everything made or shared on it, in Home's "My work" look.
 * Search, type and sort run on the server, 50 at a time; the List view is
 * virtualised. Items open in the board's preview (a bottom sheet on phones).
 */
export const BoardFiles: React.FC<BoardFilesProps> = ({
  client,
  boardId,
  active,
  mobile = false,
}) => {
  const { token } = theme.useToken();
  const boardView = useBoardViewContext();
  const [q, setQ] = useState('');
  const [kind, setKind] = useState<TypeFilter>('all');
  const [sort, setSort] = useState<BoardFileSort>('recent');
  const [view, setView] = useState<FilesView>('list');
  const filters = useMemo(() => ({ q, kind, sort }), [q, kind, sort]);
  const files = useBoardFiles({ client, boardId, filters, active });

  const rootRef = useRef<HTMLDivElement>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const root = useElementSize(rootRef);
  const compact = mobile || (root.width > 0 && root.width < BOARD_FILES_COMPACT_WIDTH);
  const padding = mobile ? 0 : token.paddingSM;
  const listHeight = Math.max(
    ROW_HEIGHT_ESTIMATE * 3,
    root.height - 2 * padding - (toolbarRef.current?.offsetHeight ?? 49) - 2
  );

  const board = useAgorStore(useMemo(() => makeBoardSelector(boardId), [boardId]));
  const teammate = useAgorStore(
    useMemo(() => makeBranchSelector(board?.primary_teammate_id), [board?.primary_teammate_id])
  );

  const openItem = useCallback(
    (item: BoardFileItem) => boardView?.openPreview(boardFilePreviewTarget(item)),
    [boardView]
  );
  const openConversation = useCallback(
    (sessionId: string) => boardView?.openConversation(sessionId),
    [boardView]
  );
  const previewTarget = boardView?.previewTarget ?? null;

  const activeFilters =
    Number(kind !== 'all') + Number(sort !== 'recent') + Number(view !== 'list');
  const typeSelect = (
    <Select<TypeFilter>
      value={kind}
      onChange={setKind}
      prefix="Type"
      aria-label="Type"
      styles={{ prefix: { color: token.colorTextSecondary } }}
      popupMatchSelectWidth={false}
      style={{ flex: '0 0 auto' }}
      options={TYPE_OPTIONS}
    />
  );
  const sortSelect = (
    <Select<BoardFileSort>
      value={sort}
      onChange={setSort}
      prefix="Sort"
      aria-label="Sort"
      styles={{ prefix: { color: token.colorTextSecondary } }}
      popupMatchSelectWidth={false}
      style={{ flex: '0 0 auto' }}
      options={SORT_OPTIONS}
    />
  );
  const viewSelect = (
    <Select<FilesView>
      value={view}
      onChange={setView}
      prefix="View"
      aria-label="View"
      styles={{ prefix: { color: token.colorTextSecondary } }}
      popupMatchSelectWidth={false}
      style={{ flex: '0 0 auto' }}
      options={VIEW_OPTIONS}
    />
  );

  const filtered = !!files.appliedQuery.trim() || kind !== 'all';
  const teammateName = teammate ? teammateLabel(teammate) : 'your teammate';
  const showGrid = view === 'grid' && !mobile;
  const listData = useMemo(
    () => (files.hasMore ? [...files.items, SENTINEL] : files.items),
    [files.items, files.hasMore]
  );

  const loadMore = (
    <LoadMoreSentinel
      key={files.nextSkip}
      onVisible={files.loadMore}
      onRetry={files.loadMoreFailed ? files.retryMore : undefined}
    />
  );

  let body: React.ReactNode;
  if (files.error && files.items.length === 0) {
    body = (
      <div style={{ padding: token.paddingSM }}>
        <HomeSectionError message="Files could not be loaded." onRetry={files.retry} />
      </div>
    );
  } else if (files.loading && files.items.length === 0) {
    body = (
      <Skeleton active title={false} paragraph={{ rows: 4 }} style={{ padding: token.paddingSM }} />
    );
  } else if (files.items.length === 0) {
    body = (
      <Flex
        vertical
        align="center"
        gap={token.marginXS}
        style={{ padding: `${token.paddingXL}px ${token.paddingLG}px`, textAlign: 'center' }}
      >
        <Typography.Text type="secondary" style={{ fontSize: token.fontSizeHeading3 }}>
          {filtered ? <SearchOutlined /> : <FolderOutlined />}
        </Typography.Text>
        <Typography.Text type="secondary">
          {filtered
            ? 'No files match. Try another word or type.'
            : `Nothing here yet. Things ${teammateName} makes and files you share show up here.`}
        </Typography.Text>
      </Flex>
    );
  } else if (showGrid) {
    body = (
      <div style={{ maxHeight: listHeight, overflowY: 'auto' }}>
        <ul
          style={{
            listStyle: 'none',
            margin: 0,
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(168px, 1fr))',
            gap: token.marginXS,
            padding: token.paddingSM,
          }}
        >
          {files.items.map((item) => (
            <li key={`${item.kind}:${item.id}`}>
              <BoardFileTile
                item={item}
                selected={isPreviewing(previewTarget, item)}
                onOpen={openItem}
              />
            </li>
          ))}
        </ul>
        {files.hasMore && loadMore}
      </div>
    );
  } else {
    body = (
      <VirtualList<BoardFileItem | typeof SENTINEL>
        data={listData}
        height={listHeight}
        itemHeight={ROW_HEIGHT_ESTIMATE}
        itemKey={(entry) => ('sentinel' in entry ? 'sentinel' : `${entry.kind}:${entry.id}`)}
        fullHeight={false}
      >
        {(entry, index) =>
          'sentinel' in entry ? (
            <div style={{ borderTop: homeDivider(token) }}>{loadMore}</div>
          ) : (
            <div style={index ? { borderTop: homeDivider(token) } : undefined}>
              <BoardFileRow
                item={entry}
                selected={isPreviewing(previewTarget, entry)}
                compact={compact}
                onOpen={openItem}
                onOpenConversation={openConversation}
              />
            </div>
          )
        }
      </VirtualList>
    );
  }

  return (
    <div
      ref={rootRef}
      style={{
        height: '100%',
        overflow: 'hidden',
        padding,
        background: mobile ? token.colorBgContainer : token.colorBgLayout,
      }}
    >
      <HomeCard>
        <Flex
          ref={toolbarRef}
          align="center"
          gap={token.marginXS}
          style={{
            padding: `${token.paddingXS}px ${token.paddingSM}px`,
            borderBottom: homeDivider(token),
          }}
        >
          <Input
            allowClear
            value={q}
            onChange={(event) => setQ(event.target.value)}
            prefix={<SearchOutlined style={{ color: token.colorTextTertiary }} />}
            placeholder="Search files"
            aria-label="Search files"
            style={{ flex: 1, minWidth: 0 }}
          />
          {mobile ? (
            typeSelect
          ) : compact ? (
            <Popover
              trigger="click"
              placement="bottomRight"
              content={
                <Flex vertical gap={token.marginSM} style={{ minWidth: 220 }}>
                  {typeSelect}
                  {sortSelect}
                  {viewSelect}
                </Flex>
              }
            >
              <Badge count={activeFilters} size="small">
                <Button icon={<FilterOutlined />}>Filters</Button>
              </Badge>
            </Popover>
          ) : (
            <>
              {typeSelect}
              {sortSelect}
              {viewSelect}
            </>
          )}
        </Flex>
        {body}
      </HomeCard>
    </div>
  );
};
