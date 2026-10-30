import {
  type BoardPosition,
  ZONE_PLACEMENT_ANCHORS,
  type ZonePlacementAnchor,
} from '@agor/core/types';
import { resolveZoneRelativePosition, toAbsolutePosition } from '@agor/core/utils/board-placement';
import type {
  AgorClient,
  Board,
  BoardEntityObject,
  Branch,
  EffectiveCapabilityPolicyAccess,
} from '@agor-live/client';
import { Alert, Button, Form, InputNumber, Modal, Select, Space, Spin, Typography } from 'antd';
import { useEffect, useRef, useState } from 'react';
import { useServerRead } from '../../hooks/useServerRead';
import { captureLoadLifetime, isLoadLifetimeCurrent } from '../../store/loadLifetime';
import { formatActionError } from '../../utils/connectionErrors';
import { useThemedMessage } from '../../utils/message';

interface Props {
  client: AgorClient;
  branch: Branch;
  open: boolean;
  onClose: () => void;
  afterClose: () => void;
}

/** An explicit placement-only action; it never dispatches zone prompts. */
export function BranchPlacementModal(props: Props) {
  const { client, branch, open } = props;
  const { data, refresh } = useServerRead(
    client,
    `${branch.branch_id}:${branch.board_id ?? ''}`,
    async (client) => {
      try {
        if (!branch.board_id) throw new Error('Save a board for this branch first.');
        const [board, objects, access] = await Promise.all([
          client.service('boards').get(branch.board_id) as Promise<Board>,
          client.service('board-objects').find({
            query: { board_id: branch.board_id, branch_id: branch.branch_id },
          }) as Promise<{
            data: BoardEntityObject[];
          }>,
          client.service('boards/:id/effective-access').find({
            route: { id: branch.board_id },
          }) as unknown as Promise<EffectiveCapabilityPolicyAccess>,
        ]);
        const object = objects.data.find(
          (o) => o.branch_id === branch.branch_id && o.board_id === board.board_id
        );
        if (!object) throw new Error('This branch has no placement on this board.');
        if (!access.capabilities.includes('board.edit') || board.archived)
          throw new Error('You need board edit access to move this branch.');
        return { board, object };
      } catch (error) {
        return { error: formatActionError('load branch placement', error, { idempotent: true }) };
      }
    }
  );
  if (!data || 'error' in data) {
    return (
      <Modal
        title="Move on board"
        open={open}
        onCancel={props.onClose}
        afterClose={props.afterClose}
        footer={null}
      >
        {data ? (
          <Alert
            type="error"
            showIcon
            description={data.error}
            action={<Button onClick={refresh}>Try again</Button>}
          />
        ) : (
          <Spin aria-label="Loading placement" />
        )}
      </Modal>
    );
  }
  return (
    <PlacementForm key={data.object.object_id} {...props} board={data.board} object={data.object} />
  );
}

function PlacementForm({
  client,
  branch,
  board,
  object,
  open,
  onClose,
  afterClose,
}: Props & { board: Board; object: BoardEntityObject }) {
  const active = useRef(open);
  active.current = open;
  useEffect(() => {
    active.current = open;
    return () => {
      active.current = false;
    };
  }, [open]);
  const [zoneId, setZoneId] = useState(object.zone_id ?? '');
  const [mode, setMode] = useState<ZonePlacementAnchor | 'coordinates'>('coordinates');
  const [coordinates, setCoordinates] = useState<{ x: number | null; y: number | null }>(
    object.position
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { showSuccess } = useThemedMessage();
  const zone = zoneId ? board.objects?.[zoneId] : undefined;
  const validZone = zone?.type === 'zone' ? zone : undefined;
  const validCoordinates =
    coordinates.x !== null &&
    coordinates.y !== null &&
    Number.isFinite(coordinates.x) &&
    Number.isFinite(coordinates.y);
  const canSave = (!zoneId || !!validZone) && (mode !== 'coordinates' || validCoordinates);
  const preview = canSave
    ? validZone
      ? resolveZoneRelativePosition(
          validZone,
          mode === 'coordinates' ? (coordinates as BoardPosition) : mode
        )
      : (coordinates as BoardPosition)
    : null;

  const move = async () => {
    if (!canSave || saving) return;
    const lifetime = captureLoadLifetime();
    if (!lifetime) return;
    setSaving(true);
    setError(null);
    try {
      // Re-read before writing so a deleted zone or an intervening board move
      // cannot silently reinterpret the draft against a different board.
      const [latest, latestBoard] = await Promise.all([
        client.service('board-objects').get(object.object_id) as Promise<BoardEntityObject>,
        client.service('boards').get(board.board_id) as Promise<Board>,
      ]);
      if (!active.current || !isLoadLifetimeCurrent(lifetime)) return;
      if (
        latest.board_id !== board.board_id ||
        latest.branch_id !== branch.branch_id ||
        latest.zone_id !== object.zone_id ||
        latest.position.x !== object.position.x ||
        latest.position.y !== object.position.y
      ) {
        throw new Error('Placement changed while editing. Close and reopen Move on board.');
      }
      const target = zoneId ? latestBoard.objects?.[zoneId] : undefined;
      if (zoneId && target?.type !== 'zone') throw new Error('That zone is no longer available.');
      const position =
        target?.type === 'zone'
          ? resolveZoneRelativePosition(
              target,
              mode === 'coordinates' ? (coordinates as BoardPosition) : mode
            )
          : (coordinates as BoardPosition);
      // Same authenticated/tenant-scoped patch boundary as canvas drags and MCP.
      await client
        .service('board-objects')
        .patch(object.object_id, { zone_id: zoneId || null, position });
      if (!active.current || !isLoadLifetimeCurrent(lifetime)) return;
      showSuccess('Branch moved.');
      onClose();
    } catch (error) {
      if (active.current && isLoadLifetimeCurrent(lifetime))
        setError(formatActionError('move the branch', error, { idempotent: true }));
    } finally {
      if (active.current) setSaving(false);
    }
  };

  return (
    <Modal
      title="Move on board"
      open={open}
      onCancel={onClose}
      afterClose={afterClose}
      onOk={move}
      okText="Move branch"
      confirmLoading={saving}
      okButtonProps={{ disabled: !canSave }}
      cancelButtonProps={{ disabled: saving }}
      closable={!saving}
      mask={{ closable: false }}
      keyboard={!saving}
    >
      <Form layout="vertical">
        <Form.Item label="Zone" htmlFor="branch-placement-zone">
          <Select
            id="branch-placement-zone"
            value={zoneId}
            disabled={saving}
            options={[
              { value: '', label: 'No zone (canvas)' },
              ...Object.entries(board.objects ?? {}).flatMap(([id, o]) =>
                o.type === 'zone' ? [{ value: id, label: o.label }] : []
              ),
            ]}
            onChange={(id) => {
              if (!id && validZone && preview)
                setCoordinates(toAbsolutePosition(preview, validZone));
              setZoneId(id);
              setMode(id ? 'top-left' : 'coordinates');
            }}
          />
        </Form.Item>
        {zoneId && (
          <Form.Item label="Position" htmlFor="branch-placement-anchor">
            <Select
              id="branch-placement-anchor"
              value={mode}
              disabled={saving}
              onChange={(next) => {
                if (next === 'coordinates' && preview) setCoordinates(preview);
                setMode(next);
              }}
              options={[
                { value: 'coordinates', label: 'Coordinates' },
                ...ZONE_PLACEMENT_ANCHORS.map((value) => ({
                  value,
                  label: value.replaceAll('-', ' ').replace(/^./, (c) => c.toUpperCase()),
                })),
              ]}
            />
          </Form.Item>
        )}
        {mode === 'coordinates' && (
          <Space wrap>
            <Form.Item label="X" htmlFor="branch-placement-x">
              <InputNumber
                id="branch-placement-x"
                value={coordinates.x}
                disabled={saving}
                onChange={(x) => setCoordinates((p) => ({ ...p, x }))}
              />
            </Form.Item>
            <Form.Item label="Y" htmlFor="branch-placement-y">
              <InputNumber
                id="branch-placement-y"
                value={coordinates.y}
                disabled={saving}
                onChange={(y) => setCoordinates((p) => ({ ...p, y }))}
              />
            </Form.Item>
          </Space>
        )}
        <Typography.Paragraph type="secondary">
          {zoneId
            ? 'Coordinates are relative to the zone’s top-left and clamped to fit the branch.'
            : 'Coordinates are absolute canvas positions.'}{' '}
          Zone prompts will not run. This move is saved separately from other branch changes.
        </Typography.Paragraph>
        {preview && (
          <Typography.Paragraph>
            Result: ({preview.x}, {preview.y})
          </Typography.Paragraph>
        )}
        {error && <Alert type="error" showIcon description={error} />}
      </Form>
    </Modal>
  );
}
