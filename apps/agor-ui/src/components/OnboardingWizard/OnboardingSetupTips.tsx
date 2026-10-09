import {
  ApiOutlined,
  BarChartOutlined,
  BookOutlined,
  FieldTimeOutlined,
  SlackOutlined,
  TeamOutlined,
} from '@ant-design/icons';
import { Card, Carousel, ConfigProvider, Flex, Typography, theme } from 'antd';
import { usePrefersReducedMotion } from '../../hooks/usePrefersReducedMotion';

/** Shown while completion runs. `name` is mid-sentence, `Name` starts a sentence. */
const SETUP_TIPS = [
  {
    icon: SlackOutlined,
    title: 'Chat in Slack',
    line: (name: string) =>
      `Connect a Slack channel and your team can ask ${name} for help right there.`,
  },
  {
    icon: BarChartOutlined,
    title: 'Build live apps and charts',
    line: (_: string, Name: string) =>
      `Ask for a dashboard, a prototype or a report. ${Name} builds it as an artifact on your board.`,
  },
  {
    icon: FieldTimeOutlined,
    title: 'Put work on repeat',
    line: (name: string) =>
      `Schedule ${name} to send a morning summary or check on things every day.`,
  },
  {
    icon: ApiOutlined,
    title: 'Connect your tools',
    line: (name: string) =>
      `Ask ${name} to help you connect GitHub, Notion and more from the Catalog.`,
  },
  {
    icon: BookOutlined,
    title: 'No need to repeat yourself',
    line: (_: string, Name: string) =>
      `${Name} saves notes and decisions to Knowledge and picks up where you left off.`,
  },
  {
    icon: TeamOutlined,
    title: 'Work as a team',
    line: (name: string) => `Share your board so everyone can work with ${name}.`,
  },
];

export function OnboardingSetupTips({ teammateName }: { teammateName?: string }) {
  const { token } = theme.useToken();
  const reducedMotion = usePrefersReducedMotion();
  const name = teammateName || 'your teammate';
  const Name = teammateName || 'Your teammate';

  return (
    <Card
      size="small"
      style={{ maxWidth: 400, margin: `${token.marginLG}px auto 0`, textAlign: 'left' }}
      styles={{ body: { padding: `${token.paddingSM}px ${token.padding}px 0` } }}
    >
      {/* Carousel dots paint with colorBgContainer, invisible on a dark card. */}
      <ConfigProvider theme={{ components: { Carousel: { colorBgContainer: token.colorText } } }}>
        <Carousel
          effect="fade"
          autoplay={!reducedMotion}
          autoplaySpeed={6000}
          speed={reducedMotion ? 0 : 500}
          pauseOnHover
          pauseOnFocus
          pauseOnDotsHover
          dotPosition="bottom"
        >
          {SETUP_TIPS.map(({ icon: Icon, title, line }) => (
            <div key={title}>
              <Flex
                gap={token.marginSM}
                align="flex-start"
                style={{ paddingBottom: token.paddingXL }}
              >
                <Icon
                  aria-hidden
                  style={{
                    fontSize: token.fontSizeLG,
                    color: token.colorPrimary,
                    // Center on the title's first line.
                    marginTop: (token.fontSize * token.lineHeight - token.fontSizeLG) / 2,
                  }}
                />
                <Flex vertical>
                  <Typography.Text strong>{title}</Typography.Text>
                  <Typography.Text type="secondary">{line(name, Name)}</Typography.Text>
                </Flex>
              </Flex>
            </div>
          ))}
        </Carousel>
      </ConfigProvider>
    </Card>
  );
}
