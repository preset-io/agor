import { ExperimentOutlined, ReloadOutlined, SaveOutlined } from '@ant-design/icons';
import {
  Alert,
  Button,
  Card,
  Divider,
  Flex,
  Grid,
  Layout,
  Segmented,
  Select,
  Typography,
  theme,
} from 'antd';
import { useState } from 'react';
import {
  BoardCapabilityPolicyForm,
  BranchCapabilityPolicyForm,
} from '@/components/permissions/CapabilityPolicyEditor';
import { Tag } from '@/components/Tag';
import {
  BOARD_PROTOTYPE_FIXTURES,
  type BoardPrototypeFixtureId,
  BRANCH_PROTOTYPE_FIXTURES,
  type BranchPrototypeFixtureId,
  cloneBoardPrototypeFixture,
  cloneBranchPrototypeFixture,
  EFFECTIVE_ACCESS_SUBJECTS,
  PROTOTYPE_PRINCIPALS,
  PROTOTYPE_USERS,
} from './rbac-policy-prototype/fixtures';

type PrototypeMode = 'board' | 'branch';

export const RbacPolicyPrototypePage: React.FC = () => {
  const { token } = theme.useToken();
  const screens = Grid.useBreakpoint();
  const [mode, setMode] = useState<PrototypeMode>('board');
  const [boardFixtureId, setBoardFixtureId] = useState<BoardPrototypeFixtureId>('shared-board');
  const [branchFixtureId, setBranchFixtureId] =
    useState<BranchPrototypeFixtureId>('inherited-branch');
  const [boardDraft, setBoardDraft] = useState(() => cloneBoardPrototypeFixture('shared-board'));
  const [branchDraft, setBranchDraft] = useState(() =>
    cloneBranchPrototypeFixture('inherited-branch')
  );
  const [localApplyNotice, setLocalApplyNotice] = useState(false);
  const [formKey, setFormKey] = useState(0);
  const compact = !screens.sm;

  const loadBoardFixture = (fixtureId: BoardPrototypeFixtureId) => {
    setBoardFixtureId(fixtureId);
    setBoardDraft(cloneBoardPrototypeFixture(fixtureId));
    setLocalApplyNotice(false);
    setFormKey((key) => key + 1);
  };
  const loadBranchFixture = (fixtureId: BranchPrototypeFixtureId) => {
    setBranchFixtureId(fixtureId);
    setBranchDraft(cloneBranchPrototypeFixture(fixtureId));
    setLocalApplyNotice(false);
    setFormKey((key) => key + 1);
  };
  const reset = () => {
    if (mode === 'board') loadBoardFixture(boardFixtureId);
    else loadBranchFixture(branchFixtureId);
  };

  const fixtureDescription =
    mode === 'board'
      ? BOARD_PROTOTYPE_FIXTURES[boardFixtureId].description
      : BRANCH_PROTOTYPE_FIXTURES[branchFixtureId].description;

  return (
    <Layout data-testid="rbac-policy-prototype" style={{ minHeight: '100dvh' }}>
      <Layout.Content>
        <div
          style={{
            width: '100%',
            maxWidth: 900,
            marginInline: 'auto',
            padding: compact ? token.paddingXS : token.paddingXL,
          }}
        >
          <Card
            title={
              <Flex align="center" gap={token.paddingXS} wrap>
                <Typography.Title level={4} style={{ margin: 0 }}>
                  Permissions prototype
                </Typography.Title>
                <Tag color="magenta" icon={<ExperimentOutlined />}>
                  Development only
                </Tag>
              </Flex>
            }
            styles={{ body: { padding: 0 } }}
          >
            <Flex vertical gap={token.paddingSM} style={{ padding: token.paddingMD }}>
              <Alert
                type="warning"
                showIcon
                description="Local fixture; nothing is saved or enforced."
              />
              <Flex gap={token.paddingSM} align="flex-end" wrap>
                <Flex vertical gap={token.paddingXXS} style={{ flex: '1 1 220px', minWidth: 0 }}>
                  <Typography.Text strong>Permissions for</Typography.Text>
                  <Segmented<PrototypeMode>
                    aria-label="Permission form context"
                    block
                    value={mode}
                    options={[
                      { label: 'Board', value: 'board' },
                      { label: 'Branch', value: 'branch' },
                    ]}
                    onChange={(nextMode) => {
                      setMode(nextMode);
                      setLocalApplyNotice(false);
                      setFormKey((key) => key + 1);
                    }}
                  />
                </Flex>
                <Flex vertical gap={token.paddingXXS} style={{ flex: '2 1 320px', minWidth: 0 }}>
                  <Typography.Text strong>Example</Typography.Text>
                  {mode === 'board' ? (
                    <Select<BoardPrototypeFixtureId>
                      aria-label="Board prototype fixture"
                      value={boardFixtureId}
                      onChange={loadBoardFixture}
                      options={Object.entries(BOARD_PROTOTYPE_FIXTURES).map(([id, fixture]) => ({
                        value: id as BoardPrototypeFixtureId,
                        label: fixture.label,
                        title: fixture.description,
                      }))}
                    />
                  ) : (
                    <Select<BranchPrototypeFixtureId>
                      aria-label="Branch prototype fixture"
                      value={branchFixtureId}
                      onChange={loadBranchFixture}
                      options={Object.entries(BRANCH_PROTOTYPE_FIXTURES).map(([id, fixture]) => ({
                        value: id as BranchPrototypeFixtureId,
                        label: fixture.label,
                        title: fixture.description,
                      }))}
                    />
                  )}
                </Flex>
              </Flex>
              <Typography.Text type="secondary">{fixtureDescription}</Typography.Text>
              {localApplyNotice && (
                <Alert
                  type="success"
                  showIcon
                  closable
                  onClose={() => setLocalApplyNotice(false)}
                  description="Fixture updated."
                />
              )}
            </Flex>

            <Divider style={{ margin: 0 }} />

            <section
              key={`${mode}:${formKey}`}
              aria-label={`${mode} capability policy form`}
              style={{
                padding: compact ? token.paddingSM : token.paddingMD,
                maxHeight: compact ? undefined : 'min(68dvh, 720px)',
                overflowY: compact ? undefined : 'auto',
              }}
            >
              {mode === 'board' ? (
                <BoardCapabilityPolicyForm
                  value={boardDraft}
                  onChange={setBoardDraft}
                  principals={PROTOTYPE_PRINCIPALS}
                  subjects={EFFECTIVE_ACCESS_SUBJECTS}
                  sampleBranchOwnerUserId={PROTOTYPE_USERS.leo}
                />
              ) : (
                <BranchCapabilityPolicyForm
                  value={branchDraft}
                  onChange={setBranchDraft}
                  principals={PROTOTYPE_PRINCIPALS}
                  subjects={EFFECTIVE_ACCESS_SUBJECTS}
                />
              )}
            </section>

            <Divider style={{ margin: 0 }} />
            <Flex
              gap={token.paddingXS}
              justify="flex-end"
              wrap
              style={{ padding: token.paddingMD }}
            >
              <Button icon={<ReloadOutlined />} onClick={reset}>
                Reset
              </Button>
              <Button
                type="primary"
                icon={<SaveOutlined />}
                onClick={() => setLocalApplyNotice(true)}
              >
                Apply preview
              </Button>
            </Flex>
          </Card>
        </div>
      </Layout.Content>
    </Layout>
  );
};
