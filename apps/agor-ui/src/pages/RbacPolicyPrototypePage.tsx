import { ExperimentOutlined, ReloadOutlined, SaveOutlined } from '@ant-design/icons';
import {
  Alert,
  Button,
  Card,
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
  PROTOTYPE_PRINCIPALS,
  PROTOTYPE_SUBJECTS,
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

  return (
    <Layout data-testid="rbac-policy-prototype" style={{ minHeight: '100dvh' }}>
      <Layout.Content>
        <main
          style={{
            width: '100%',
            maxWidth: 1040,
            marginInline: 'auto',
            padding: compact ? token.paddingSM : token.paddingXL,
          }}
        >
          <Flex vertical gap={token.paddingLG}>
            <Flex justify="space-between" align="flex-start" gap={token.paddingSM} wrap>
              <div style={{ minWidth: 0 }}>
                <Flex align="center" gap={token.paddingXS} wrap>
                  <Typography.Title level={2} style={{ margin: 0 }}>
                    Capability policy prototype
                  </Typography.Title>
                  <Tag color="magenta" icon={<ExperimentOutlined />}>
                    Development only
                  </Tag>
                </Flex>
                <Typography.Paragraph type="secondary" style={{ margin: 0, marginTop: 4 }}>
                  Shared editor primitives for the proposed Board and Branch permission model.
                </Typography.Paragraph>
              </div>
            </Flex>

            <Alert
              type="warning"
              showIcon
              title="Interactive design fixture — no persistence or authorization changes"
              description="All people, groups, policies, and effective-access results are static local examples. Apply only updates an on-page notice; refreshing restores the fixture. This route is excluded from production builds."
            />

            <Card>
              <Flex vertical gap={token.paddingSM}>
                <Flex gap={token.paddingSM} align="flex-end" wrap>
                  <Flex vertical gap={token.paddingXXS} style={{ flex: '1 1 280px' }}>
                    <Typography.Text strong>Form context</Typography.Text>
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
                      }}
                    />
                  </Flex>
                  <Flex vertical gap={token.paddingXXS} style={{ flex: '2 1 340px' }}>
                    <Typography.Text strong>Review fixture</Typography.Text>
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
                <Typography.Text type="secondary">
                  {mode === 'board'
                    ? BOARD_PROTOTYPE_FIXTURES[boardFixtureId].description
                    : BRANCH_PROTOTYPE_FIXTURES[branchFixtureId].description}
                </Typography.Text>
                <Flex gap={token.paddingXS} justify="flex-end" wrap>
                  <Button icon={<ReloadOutlined />} onClick={reset}>
                    Reset fixture
                  </Button>
                  <Button
                    type="primary"
                    icon={<SaveOutlined />}
                    onClick={() => setLocalApplyNotice(true)}
                  >
                    Apply locally (prototype only)
                  </Button>
                </Flex>
                {localApplyNotice && (
                  <Alert
                    type="success"
                    showIcon
                    closable
                    onClose={() => setLocalApplyNotice(false)}
                    title="Local prototype state applied"
                    description="Nothing was sent to the daemon, database, realtime layer, or authorization system."
                  />
                )}
              </Flex>
            </Card>

            <section key={`${mode}:${formKey}`} aria-label={`${mode} capability policy form`}>
              {mode === 'board' ? (
                <BoardCapabilityPolicyForm
                  value={boardDraft}
                  onChange={setBoardDraft}
                  principals={PROTOTYPE_PRINCIPALS}
                  subjects={PROTOTYPE_SUBJECTS}
                  sampleBranchOwnerUserId={PROTOTYPE_USERS.leo}
                />
              ) : (
                <BranchCapabilityPolicyForm
                  value={branchDraft}
                  onChange={setBranchDraft}
                  principals={PROTOTYPE_PRINCIPALS}
                  subjects={PROTOTYPE_SUBJECTS}
                />
              )}
            </section>

            <Card title="Review prompts for Max and Kasia" size="small">
              <ul style={{ margin: 0, paddingInlineStart: token.paddingLG }}>
                <li>Are Board access and live Branch defaults separated clearly enough?</li>
                <li>Are Manager versus Prompt / execute boundaries understandable at a glance?</li>
                <li>Should Others remain a fallback for unmatched active workspace members?</li>
                <li>Do Inherit and Override communicate live updates and replacement semantics?</li>
                <li>
                  Which capability names, presets, warnings, or advanced controls need simpler copy?
                </li>
              </ul>
            </Card>
          </Flex>
        </main>
      </Layout.Content>
    </Layout>
  );
};
