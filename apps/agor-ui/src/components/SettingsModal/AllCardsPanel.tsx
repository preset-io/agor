import type {
  AgorClient,
  Board,
  BoardEntityObject,
  CardType,
  CardWithType,
} from '@agor-live/client';
import { ExportOutlined, PushpinFilled } from '@ant-design/icons';
import { Button, Empty, Input, Space, Table, Tag, Tooltip, Typography } from 'antd';
import { type Key, useCallback, useMemo, useState } from 'react';
import { useAppNavigation } from '@/hooks/useAppNavigation';
import { useSettingsRoute } from '@/hooks/useSettingsRoute';
import { useAgorStore } from '@/store/agorStore';
import { selectBranchById, selectUserById } from '@/store/selectors';
import { mapToArray } from '@/utils/mapHelpers';
import { filterBySettingsSearch } from '@/utils/settingsSearch';
import { getBoardEmoji } from '../BoardTile';
import CardModal from '../CardModal/CardModal';
import { HighlightMatch } from '../HighlightMatch';
import { ListPanelHeader } from './panelPrimitives';
import { SettingsActionGroup } from './SettingsActionGroup';

interface AllCardsPanelProps {
  client: AgorClient | null;
  cardById: Map<string, CardWithType>;
  cardTypeById: Map<string, CardType>;
  boardById: Map<string, Board>;
  boardObjects?: BoardEntityObject[];
  /** Close the parent Settings modal so the board isn't obscured after navigation. */
  onClose?: () => void;
}

export const AllCardsPanel: React.FC<AllCardsPanelProps> = ({
  client,
  cardById,
  cardTypeById,
  boardById,
  boardObjects,
  onClose,
}) => {
  const branchById = useAgorStore(selectBranchById);
  const userById = useAgorStore(selectUserById);
  const navigation = useAppNavigation({ boardById, branchById });
  // The route's item segment (/settings/cards/<typeId>/) seeds the Type filter —
  // this is the shareable "View cards →" deep-link from a card type.
  const { itemId } = useSettingsRoute();

  const [searchTerm, setSearchTerm] = useState('');
  // Controlled Type filter so a click on a card's type tag narrows the list.
  const [typeFilter, setTypeFilter] = useState<string[]>(itemId ? [itemId] : []);
  const [cardModalCard, setCardModalCard] = useState<CardWithType | null>(null);
  const [cardModalOpen, setCardModalOpen] = useState(false);

  // card_id → zone info (name + color) from board objects.
  const cardZoneInfo = useMemo(() => {
    const map = new Map<string, { zoneName: string; zoneColor?: string }>();
    if (!boardObjects) return map;
    for (const bo of boardObjects) {
      if (!bo.card_id || !bo.zone_id) continue;
      const zoneObj = boardById.get(bo.board_id)?.objects?.[bo.zone_id];
      if (zoneObj && zoneObj.type === 'zone') {
        map.set(bo.card_id, {
          zoneName: zoneObj.label || 'Unknown Zone',
          zoneColor: zoneObj.borderColor || zoneObj.color,
        });
      }
    }
    return map;
  }, [boardObjects, boardById]);

  const cardTypeName = useCallback(
    (card: CardWithType) =>
      card.card_type?.name ??
      (card.card_type_id ? cardTypeById.get(card.card_type_id)?.name : undefined),
    [cardTypeById]
  );

  const cards = useMemo(() => {
    const all = mapToArray(cardById)
      .filter((c) => !c.archived)
      .sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }));
    return filterBySettingsSearch(all, searchTerm, [
      (card) => card.title,
      (card) => cardTypeName(card),
      (card) => {
        const board = boardById.get(card.board_id);
        return [board?.name, board?.slug, card.board_id];
      },
      (card) => cardZoneInfo.get(card.card_id)?.zoneName,
      (card) => {
        const user = card.created_by ? userById.get(card.created_by) : undefined;
        return [user?.name, user?.email, card.created_by];
      },
      (card) => JSON.stringify(card.data ?? {}),
    ]);
  }, [cardById, searchTerm, boardById, cardZoneInfo, userById, cardTypeName]);

  // Type filter options come from the types actually in use, so the dropdown
  // never offers an empty bucket.
  const typeFilters = useMemo(() => {
    const present = new Map<string, string>();
    for (const card of mapToArray(cardById)) {
      if (card.archived) continue;
      const name = cardTypeName(card);
      if (card.card_type_id && name) present.set(card.card_type_id, name);
      else if (!card.card_type_id) present.set('__untyped__', 'Untyped');
    }
    return Array.from(present.entries())
      .sort((a, b) => a[1].localeCompare(b[1]))
      .map(([value, text]) => ({ text, value }));
  }, [cardById, cardTypeName]);

  const boardFilters = useMemo(() => {
    const present = new Map<string, string>();
    for (const card of mapToArray(cardById)) {
      if (card.archived) continue;
      const board = boardById.get(card.board_id);
      if (board) present.set(board.board_id, board.name);
    }
    return Array.from(present.entries())
      .sort((a, b) => a[1].localeCompare(b[1]))
      .map(([value, text]) => ({ text, value }));
  }, [cardById, boardById]);

  const zoneFilters = useMemo(() => {
    const present = new Set<string>();
    for (const card of mapToArray(cardById)) {
      if (card.archived) continue;
      const zone = cardZoneInfo.get(card.card_id);
      if (zone) present.add(zone.zoneName);
    }
    return Array.from(present)
      .sort((a, b) => a.localeCompare(b))
      .map((zoneName) => ({ text: zoneName, value: zoneName }));
  }, [cardById, cardZoneInfo]);

  const openOnBoard = (card: CardWithType) => {
    onClose?.();
    navigation.goToBoard(card.board_id);
  };

  const columns = [
    {
      title: 'Title',
      dataIndex: 'title',
      key: 'title',
      render: (title: string, card: CardWithType) => (
        <Space>
          {card.effective_emoji && <span>{card.effective_emoji}</span>}
          <Typography.Link
            ellipsis
            title={title}
            onClick={() => {
              setCardModalCard(card);
              setCardModalOpen(true);
            }}
          >
            <HighlightMatch text={title} query={searchTerm} />
          </Typography.Link>
        </Space>
      ),
    },
    {
      title: 'Type',
      key: 'type',
      width: 160,
      filters: typeFilters,
      filteredValue: typeFilter.length ? typeFilter : null,
      onFilter: (value: Key | boolean, card: CardWithType) =>
        value === '__untyped__' ? !card.card_type_id : card.card_type_id === value,
      render: (_: unknown, card: CardWithType) => {
        const name = cardTypeName(card);
        if (!name) return <Typography.Text type="secondary">—</Typography.Text>;
        // Clicking a type narrows the list to it (and clears with a second click).
        return (
          <Tooltip title="Filter by this type">
            <Tag
              color={card.effective_color ?? 'default'}
              style={{ cursor: 'pointer' }}
              onClick={() =>
                setTypeFilter((prev) =>
                  prev.length === 1 && prev[0] === card.card_type_id
                    ? []
                    : card.card_type_id
                      ? [card.card_type_id]
                      : []
                )
              }
            >
              {card.effective_emoji ? `${card.effective_emoji} ` : ''}
              <HighlightMatch text={name} query={searchTerm} />
            </Tag>
          </Tooltip>
        );
      },
    },
    {
      title: 'Board',
      dataIndex: 'board_id',
      key: 'board',
      width: 180,
      filters: boardFilters,
      onFilter: (value: Key | boolean, card: CardWithType) => card.board_id === value,
      render: (boardId: string) => {
        const board = boardById.get(boardId);
        if (!board) return <Typography.Text type="secondary">—</Typography.Text>;
        const boardEmoji = getBoardEmoji(board, branchById);
        return (
          <Typography.Text type="secondary">
            <HighlightMatch
              text={`${boardEmoji ? `${boardEmoji} ` : ''}${board.name}`}
              query={searchTerm}
            />
          </Typography.Text>
        );
      },
    },
    {
      title: 'Zone',
      key: 'zone',
      width: 160,
      filters: zoneFilters,
      onFilter: (value: Key | boolean, card: CardWithType) =>
        cardZoneInfo.get(card.card_id)?.zoneName === value,
      render: (_: unknown, card: CardWithType) => {
        const info = cardZoneInfo.get(card.card_id);
        if (!info) return <Typography.Text type="secondary">—</Typography.Text>;
        return (
          <Space size={4}>
            {info.zoneColor && <PushpinFilled style={{ color: info.zoneColor, fontSize: 12 }} />}
            <Typography.Text style={{ fontSize: 13 }}>
              <HighlightMatch text={info.zoneName} query={searchTerm} />
            </Typography.Text>
          </Space>
        );
      },
    },
    {
      title: 'Created',
      dataIndex: 'created_at',
      key: 'created',
      width: 120,
      render: (createdAt: string) => (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {new Date(createdAt).toLocaleDateString()}
        </Typography.Text>
      ),
    },
    {
      title: 'Created by',
      dataIndex: 'created_by',
      key: 'created_by',
      width: 160,
      render: (createdBy: string | undefined) => {
        if (!createdBy || createdBy === 'anonymous') {
          return <Typography.Text type="secondary">—</Typography.Text>;
        }
        const user = userById.get(createdBy);
        const label = user ? user.name?.trim() || user.email : createdBy;
        return (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            <HighlightMatch text={label} query={searchTerm} />
          </Typography.Text>
        );
      },
    },
    {
      title: 'Actions',
      key: 'actions',
      width: 72,
      render: (_: unknown, card: CardWithType) => (
        <SettingsActionGroup>
          <Tooltip title="Open on board">
            <Button
              type="text"
              size="small"
              icon={<ExportOutlined />}
              onClick={() => openOnBoard(card)}
            />
          </Tooltip>
        </SettingsActionGroup>
      ),
    },
  ];

  const cardModalBoard = cardModalCard ? (boardById.get(cardModalCard.board_id) ?? null) : null;

  return (
    <div>
      <ListPanelHeader
        title="All Cards"
        description="Every card across all boards. Filter by type, board, or zone."
        search={
          <Input
            allowClear
            placeholder="Search title, type, board, zone, creator, or data"
            value={searchTerm}
            onChange={(event) => setSearchTerm(event.target.value)}
            style={{ width: 360 }}
          />
        }
      />

      <Table
        dataSource={cards}
        columns={columns}
        rowKey="card_id"
        size="small"
        pagination={{ pageSize: 20, showSizeChanger: true }}
        onChange={(_pagination, filters) => {
          // Keep the controlled Type filter in sync with the column dropdown.
          const next = filters.type as Key[] | null;
          setTypeFilter(next ? next.map(String) : []);
        }}
        locale={{
          emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No cards yet" />,
        }}
      />

      {cardModalCard && (
        <CardModal
          open={cardModalOpen}
          card={cardModalCard}
          board={cardModalBoard}
          client={client}
          onClose={() => setCardModalOpen(false)}
          afterClose={() => setCardModalCard(null)}
          onCardUpdated={(updated) => setCardModalCard(updated)}
          onCardDeleted={() => setCardModalOpen(false)}
        />
      )}
    </div>
  );
};
