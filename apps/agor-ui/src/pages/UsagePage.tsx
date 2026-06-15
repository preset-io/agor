import type { LeaderboardBucket, LeaderboardEntry, LeaderboardResult } from '@agor/core/types';
import type { AgorClient, User } from '@agor-live/client';
import { ArrowLeftOutlined } from '@ant-design/icons';
import {
  Alert,
  Button,
  Card,
  DatePicker,
  Empty,
  Layout,
  Segmented,
  Space,
  Spin,
  Typography,
  theme,
} from 'antd';
import dayjs, { type Dayjs } from 'dayjs';
import type React from 'react';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Area,
  AreaChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
  Tooltip as RechartsTooltip,
  ResponsiveContainer,
  XAxis,
  YAxis,
} from 'recharts';
import { BrandLogo } from '../components/BrandLogo';
import { GlobalUserMenu } from '../components/GlobalUserMenu';
import { ThemeSwitcher } from '../components/ThemeSwitcher';
import {
  buildAggregates,
  buildChartSeries,
  CHART_COLORS,
  type DateRange,
  DIMENSION_ORDER,
  DIMENSIONS,
  type DimensionKey,
  fmtCompact,
  fmtHours,
  fmtInt,
  fmtMoney,
  METRIC_ORDER,
  METRICS,
  type MetricKey,
  OTHER_COLOR,
  type RankedRow,
  type UsageData,
  WINDOWS,
  type WindowKey,
} from './usage/usageTransforms';

const { Header, Content } = Layout;
const { Text } = Typography;

/* ------------------------------------------------------------------ */
/*  Data fetching                                                     */
/* ------------------------------------------------------------------ */

function findLeaderboard(
  client: AgorClient,
  query: Record<string, string | number | undefined>
): Promise<LeaderboardResult> {
  return client.service('leaderboard').find({ query }) as unknown as Promise<LeaderboardResult>;
}

function useUsageData(
  client: AgorClient | null,
  dim: DimensionKey,
  bucket: LeaderboardBucket,
  range: DateRange
): { data: UsageData | null; loading: boolean; error: string | null } {
  const [data, setData] = useState<UsageData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!client) return;
    let cancelled = false;
    setLoading(true);
    setError(null);

    const seriesPromise = findLeaderboard(client, {
      groupBy: dim,
      bucket,
      ...range,
      limit: 10000,
    });
    const overviewPromises = DIMENSION_ORDER.map((d) =>
      findLeaderboard(client, { groupBy: d, ...range, limit: 500 })
    );

    Promise.all([seriesPromise, ...overviewPromises])
      .then(([series, ...overviews]) => {
        if (cancelled) return;
        const overview = Object.fromEntries(
          DIMENSION_ORDER.map((d, i) => [d, overviews[i].data])
        ) as Record<DimensionKey, LeaderboardEntry[]>;
        setData({ series: series.data, overview });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [client, dim, bucket, range]);

  return { data, loading, error };
}

/* ------------------------------------------------------------------ */
/*  Page                                                              */
/* ------------------------------------------------------------------ */

interface UsagePageProps {
  client: AgorClient | null;
  currentUser?: User | null;
  onUserSettingsClick?: () => void;
  onLogout?: () => void;
}

export function UsagePage({
  client,
  currentUser = null,
  onUserSettingsClick,
  onLogout,
}: UsagePageProps) {
  const { token } = theme.useToken();
  const navigate = useNavigate();

  const [metric, setMetric] = useState<MetricKey>('cost');
  const [dim, setDim] = useState<DimensionKey>('user');
  const [bucket, setBucket] = useState<LeaderboardBucket>('week');
  const [win, setWin] = useState<WindowKey>('90d');
  const [customRange, setCustomRange] = useState<[Dayjs, Dayjs] | null>(null);

  const range = useMemo<DateRange>(() => {
    if (win === 'custom') {
      if (!customRange) return {};
      return {
        startDate: customRange[0].startOf('day').toISOString(),
        endDate: customRange[1].endOf('day').toISOString(),
      };
    }
    const days = WINDOWS[win].days;
    if (!days) return {};
    return { startDate: dayjs().subtract(days, 'day').startOf('day').toISOString() };
  }, [win, customRange]);

  const { data, loading, error } = useUsageData(client, dim, bucket, range);

  /* ---- pivot bucketed rows into stacked series ---- */
  const chart = useMemo(
    () => (data ? buildChartSeries(data, metric, dim, bucket) : { rows: [], keys: [] }),
    [data, metric, dim, bucket]
  );

  /* ---- aggregate overview rows for KPIs / leaderboards / donuts ---- */
  const agg = useMemo(() => (data ? buildAggregates(data, metric) : null), [data, metric]);

  const M = METRICS[metric];
  const cardStyle: React.CSSProperties = { background: token.colorBgContainer };

  return (
    <Layout style={{ minHeight: '100vh', background: token.colorBgLayout }}>
      <Header
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          height: 56,
          padding: '0 16px',
          background: token.colorBgContainer,
          borderBottom: `1px solid ${token.colorBorderSecondary}`,
        }}
      >
        <Space size={12}>
          <Button type="text" icon={<ArrowLeftOutlined />} onClick={() => navigate('/')} />
          <BrandLogo level={5} />
          <Text strong style={{ fontSize: 15 }}>
            Usage
          </Text>
        </Space>
        <Space size={8}>
          <ThemeSwitcher />
          <GlobalUserMenu
            user={currentUser}
            onUserSettingsClick={onUserSettingsClick}
            onLogout={onLogout}
          />
        </Space>
      </Header>

      <Content style={{ padding: 16, maxWidth: 1280, width: '100%', margin: '0 auto' }}>
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          {/* Controls */}
          <Space wrap size={8} style={{ justifyContent: 'space-between', width: '100%' }}>
            <Space wrap size={8}>
              <Segmented
                options={(Object.keys(WINDOWS) as Exclude<WindowKey, 'custom'>[])
                  .map((k) => ({ label: WINDOWS[k].label, value: k as WindowKey }))
                  .concat([{ label: 'Custom', value: 'custom' }])}
                value={win}
                onChange={(v) => setWin(v as WindowKey)}
              />
              {win === 'custom' && (
                <DatePicker.RangePicker
                  value={customRange}
                  onChange={(values) =>
                    setCustomRange(values?.[0] && values?.[1] ? [values[0], values[1]] : null)
                  }
                  allowClear
                />
              )}
            </Space>
            <Space wrap size={8}>
              <Segmented
                options={DIMENSION_ORDER.map((k) => ({ label: DIMENSIONS[k].label, value: k }))}
                value={dim}
                onChange={(v) => setDim(v as DimensionKey)}
              />
              <Segmented
                options={[
                  { label: 'Day', value: 'day' },
                  { label: 'Week', value: 'week' },
                  { label: 'Month', value: 'month' },
                ]}
                value={bucket}
                onChange={(v) => setBucket(v as LeaderboardBucket)}
              />
            </Space>
          </Space>

          {error && (
            <Alert type="error" showIcon message="Failed to load usage data" description={error} />
          )}

          {!data && !error && (
            <div style={{ padding: 80, textAlign: 'center' }}>
              <Spin size="large" />
            </div>
          )}

          {data && agg && (
            <Spin spinning={loading}>
              <Space direction="vertical" size={12} style={{ width: '100%' }}>
                {/* KPI strip */}
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
                    gap: 12,
                  }}
                >
                  <KpiCard
                    label="Total Cost"
                    value={fmtMoney(agg.kpis.totalCost)}
                    color={METRICS.cost.color}
                    active={metric === 'cost'}
                    onClick={() => setMetric('cost')}
                    token={token}
                  />
                  <KpiCard
                    label="Prompts"
                    value={fmtInt(agg.kpis.totalPrompts)}
                    color={METRICS.prompts.color}
                    active={metric === 'prompts'}
                    onClick={() => setMetric('prompts')}
                    token={token}
                  />
                  <KpiCard
                    label="Sessions"
                    value={fmtInt(agg.kpis.totalSessions)}
                    color={METRICS.sessions.color}
                    active={metric === 'sessions'}
                    onClick={() => setMetric('sessions')}
                    token={token}
                  />
                  <KpiCard
                    label="Output Tokens"
                    value={fmtCompact(agg.kpis.totalTokens)}
                    color={METRICS.tokens.color}
                    active={metric === 'tokens'}
                    onClick={() => setMetric('tokens')}
                    token={token}
                  />
                  <KpiCard
                    label="Agent Hours"
                    value={fmtHours(agg.kpis.totalMs)}
                    color={METRICS.hours.color}
                    active={metric === 'hours'}
                    onClick={() => setMetric('hours')}
                    token={token}
                  />
                </div>

                {/* Derived stats */}
                <Card size="small" style={cardStyle}>
                  <Space size={24} wrap>
                    <DerivedStat
                      label="$ / prompt"
                      value={
                        agg.kpis.totalPrompts
                          ? `$${(agg.kpis.totalCost / agg.kpis.totalPrompts).toFixed(3)}`
                          : '—'
                      }
                      token={token}
                    />
                    <DerivedStat
                      label="Prompts / session"
                      value={
                        agg.kpis.totalSessions
                          ? (agg.kpis.totalPrompts / agg.kpis.totalSessions).toFixed(1)
                          : '—'
                      }
                      token={token}
                    />
                    <DerivedStat
                      label="Avg session"
                      value={
                        agg.kpis.totalSessions
                          ? `${(agg.kpis.totalMs / agg.kpis.totalSessions / 60000).toFixed(1)} min`
                          : '—'
                      }
                      token={token}
                    />
                    <DerivedStat
                      label="Opus cost share"
                      value={
                        agg.kpis.totalCost
                          ? `${Math.round((agg.kpis.opusCost / agg.kpis.totalCost) * 100)}%`
                          : '—'
                      }
                      token={token}
                    />
                    <DerivedStat
                      label="Active users"
                      value={fmtInt(agg.kpis.activeUsers)}
                      token={token}
                    />
                  </Space>
                </Card>

                {/* Time series */}
                <Card
                  size="small"
                  style={cardStyle}
                  title={`${M.label} over time · by ${DIMENSIONS[dim].label.toLowerCase()}`}
                  extra={
                    <Segmented
                      size="small"
                      options={METRIC_ORDER.map((k) => ({ label: METRICS[k].label, value: k }))}
                      value={metric}
                      onChange={(v) => setMetric(v as MetricKey)}
                    />
                  }
                >
                  {chart.rows.length === 0 ? (
                    <Empty description="No usage in this period" />
                  ) : (
                    <ResponsiveContainer width="100%" height={340}>
                      <AreaChart
                        data={chart.rows}
                        margin={{ top: 8, right: 12, left: 4, bottom: 0 }}
                      >
                        <CartesianGrid
                          strokeDasharray="3 3"
                          stroke={token.colorBorderSecondary}
                          vertical={false}
                        />
                        <XAxis
                          dataKey="period"
                          tick={{ fill: token.colorTextTertiary, fontSize: 11 }}
                          tickLine={false}
                          axisLine={{ stroke: token.colorBorderSecondary }}
                        />
                        <YAxis
                          tick={{ fill: token.colorTextTertiary, fontSize: 11 }}
                          tickLine={false}
                          axisLine={false}
                          tickFormatter={(v: number) => M.axis(v)}
                          width={56}
                        />
                        <RechartsTooltip
                          content={<SeriesTooltip metric={metric} token={token} />}
                        />
                        {chart.keys.map((key, i) => (
                          <Area
                            key={key}
                            type="monotone"
                            dataKey={key}
                            stackId="1"
                            stroke={
                              key === 'Other' ? OTHER_COLOR : CHART_COLORS[i % CHART_COLORS.length]
                            }
                            fill={
                              key === 'Other' ? OTHER_COLOR : CHART_COLORS[i % CHART_COLORS.length]
                            }
                            fillOpacity={0.35}
                            strokeWidth={1.4}
                          />
                        ))}
                      </AreaChart>
                    </ResponsiveContainer>
                  )}
                  <ChartLegend keys={chart.keys} token={token} />
                </Card>

                {/* Leaderboards */}
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))',
                    gap: 12,
                  }}
                >
                  <RankedCard
                    title="Top Users"
                    rows={agg.users}
                    metric={metric}
                    showEmoji
                    token={token}
                    style={cardStyle}
                  />
                  <RankedCard
                    title="Top Repos"
                    rows={agg.repos}
                    metric={metric}
                    token={token}
                    style={cardStyle}
                  />
                  <RankedCard
                    title="Top Branches"
                    rows={agg.branches}
                    metric={metric}
                    token={token}
                    style={cardStyle}
                  />
                </div>

                {/* Share donuts */}
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(auto-fit, minmax(360px, 1fr))',
                    gap: 12,
                  }}
                >
                  <ShareCard
                    title={`${M.label} by Agent`}
                    rows={agg.tools}
                    metric={metric}
                    token={token}
                    style={cardStyle}
                  />
                  <ShareCard
                    title={`${M.label} by Model`}
                    rows={agg.models}
                    metric={metric}
                    token={token}
                    style={cardStyle}
                  />
                </div>

                {/* Placeholder: session auto-categorization */}
                <Card size="small" style={cardStyle} title="Usage by Category">
                  <Empty
                    image={Empty.PRESENTED_IMAGE_SIMPLE}
                    description="Session auto-categorization is coming soon — usage will be broken down by what sessions actually work on."
                  />
                </Card>

                <Text type="secondary" style={{ fontSize: 12 }}>
                  Token counts are not comparable across agents — some agents report large token
                  totals with $0 cost, so cost is the only reliable cross-agent metric. "Prompts" =
                  tasks (one user turn each).
                </Text>
              </Space>
            </Spin>
          )}
        </Space>
      </Content>
    </Layout>
  );
}

/* ------------------------------------------------------------------ */
/*  Subcomponents                                                     */
/* ------------------------------------------------------------------ */

type ThemeToken = ReturnType<typeof theme.useToken>['token'];

const KpiCard: React.FC<{
  label: string;
  value: string;
  color: string;
  active: boolean;
  onClick: () => void;
  token: ThemeToken;
}> = ({ label, value, color, active, onClick, token }) => (
  <Card
    size="small"
    hoverable
    onClick={onClick}
    style={{
      background: token.colorBgContainer,
      borderColor: active ? color : token.colorBorderSecondary,
    }}
  >
    <Text type="secondary" style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5 }}>
      {label}
    </Text>
    <div style={{ fontSize: 24, fontWeight: 700, color, marginTop: 2 }}>{value}</div>
  </Card>
);

const DerivedStat: React.FC<{ label: string; value: string; token: ThemeToken }> = ({
  label,
  value,
  token,
}) => (
  <div>
    <div style={{ fontSize: 16, fontWeight: 600, color: token.colorText }}>{value}</div>
    <Text type="secondary" style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5 }}>
      {label}
    </Text>
  </div>
);

const ChartLegend: React.FC<{ keys: string[]; token: ThemeToken }> = ({ keys, token }) => (
  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 14px', marginTop: 8 }}>
    {keys.map((key, i) => (
      <Space key={key} size={5} style={{ fontSize: 11, color: token.colorTextSecondary }}>
        <span
          style={{
            width: 9,
            height: 9,
            borderRadius: 2,
            display: 'inline-block',
            background: key === 'Other' ? OTHER_COLOR : CHART_COLORS[i % CHART_COLORS.length],
          }}
        />
        <span
          style={{
            maxWidth: 140,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {key}
        </span>
      </Space>
    ))}
  </div>
);

const RankedCard: React.FC<{
  title: string;
  rows: RankedRow[];
  metric: MetricKey;
  showEmoji?: boolean;
  token: ThemeToken;
  style: React.CSSProperties;
}> = ({ title, rows, metric, showEmoji, token, style }) => {
  const M = METRICS[metric];
  const top = rows.slice(0, 10);
  const max = top.length ? top[0].value : 1;
  return (
    <Card size="small" title={title} style={style}>
      <Space direction="vertical" size={7} style={{ width: '100%' }}>
        {top.map((row, i) => (
          <div
            key={row.name}
            style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}
          >
            <span
              style={{
                width: 16,
                textAlign: 'right',
                color: token.colorTextQuaternary,
                fontSize: 10,
              }}
            >
              {i + 1}
            </span>
            <span
              style={{
                width: 140,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                color: token.colorText,
              }}
              title={row.name}
            >
              {showEmoji && row.emoji ? `${row.emoji} ` : ''}
              {row.name}
            </span>
            <div
              style={{
                flex: 1,
                height: 7,
                background: token.colorFillSecondary,
                borderRadius: 4,
                overflow: 'hidden',
              }}
            >
              <div
                style={{
                  height: '100%',
                  width: `${Math.max(2, (row.value / max) * 100)}%`,
                  background: CHART_COLORS[i % CHART_COLORS.length],
                  borderRadius: 4,
                }}
              />
            </div>
            <span
              style={{
                width: 62,
                textAlign: 'right',
                fontWeight: 600,
                color: token.colorText,
                fontVariantNumeric: 'tabular-nums',
              }}
            >
              {M.fmt(row.value)}
            </span>
          </div>
        ))}
        {!top.length && (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No data in window" />
        )}
      </Space>
    </Card>
  );
};

const ShareCard: React.FC<{
  title: string;
  rows: RankedRow[];
  metric: MetricKey;
  token: ThemeToken;
  style: React.CSSProperties;
}> = ({ title, rows, metric, token, style }) => {
  const M = METRICS[metric];
  const top = rows.slice(0, 8);
  const total = rows.reduce((s, r) => s + r.value, 0);
  return (
    <Card size="small" title={title} style={style}>
      {top.length === 0 ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No data in window" />
      ) : (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <ResponsiveContainer width="50%" height={180}>
            <PieChart>
              <Pie
                data={top}
                dataKey="value"
                nameKey="name"
                cx="50%"
                cy="50%"
                innerRadius={42}
                outerRadius={70}
                paddingAngle={2}
                stroke="none"
              >
                {top.map((row, i) => (
                  <Cell key={row.name} fill={CHART_COLORS[i % CHART_COLORS.length]} />
                ))}
              </Pie>
              <RechartsTooltip content={<ShareTooltip metric={metric} token={token} />} />
            </PieChart>
          </ResponsiveContainer>
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 5 }}>
            {top.map((row, i) => (
              <div
                key={row.name}
                style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11 }}
              >
                <span
                  style={{
                    width: 9,
                    height: 9,
                    borderRadius: 2,
                    flexShrink: 0,
                    background: CHART_COLORS[i % CHART_COLORS.length],
                  }}
                />
                <span
                  style={{
                    flex: 1,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    color: token.colorText,
                  }}
                  title={row.name}
                >
                  {row.name}
                </span>
                <span
                  style={{ color: token.colorTextTertiary, fontVariantNumeric: 'tabular-nums' }}
                >
                  {total ? Math.round((row.value / total) * 100) : 0}%
                </span>
                <span
                  style={{
                    width: 56,
                    textAlign: 'right',
                    fontWeight: 600,
                    color: token.colorText,
                    fontVariantNumeric: 'tabular-nums',
                  }}
                >
                  {M.fmt(row.value)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </Card>
  );
};

/* ------------------------------------------------------------------ */
/*  Chart tooltips                                                    */
/* ------------------------------------------------------------------ */

interface TooltipPayloadItem {
  name: string;
  value: number;
  color?: string;
  payload?: RankedRow;
}

const tooltipBoxStyle = (token: ThemeToken): React.CSSProperties => ({
  background: token.colorBgElevated,
  border: `1px solid ${token.colorBorderSecondary}`,
  borderRadius: token.borderRadius,
  padding: '8px 12px',
  fontSize: 12,
  color: token.colorText,
  boxShadow: token.boxShadowSecondary,
});

const SeriesTooltip: React.FC<{
  metric: MetricKey;
  token: ThemeToken;
  active?: boolean;
  label?: string;
  payload?: TooltipPayloadItem[];
}> = ({ metric, token, active, label, payload }) => {
  if (!active || !payload?.length) return null;
  const M = METRICS[metric];
  const rows = payload.filter((p) => p.value > 0).sort((a, b) => b.value - a.value);
  const total = rows.reduce((s, p) => s + p.value, 0);
  return (
    <div style={tooltipBoxStyle(token)}>
      <div style={{ fontWeight: 600, marginBottom: 6 }}>{label}</div>
      {rows.slice(0, 14).map((p) => (
        <div
          key={p.name}
          style={{ display: 'flex', justifyContent: 'space-between', gap: 16, marginBottom: 2 }}
        >
          <span
            style={{
              color: p.color,
              maxWidth: 160,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {p.name}
          </span>
          <span style={{ fontWeight: 500 }}>{M.fmt(p.value)}</span>
        </div>
      ))}
      <div
        style={{
          borderTop: `1px solid ${token.colorBorderSecondary}`,
          marginTop: 4,
          paddingTop: 4,
          fontWeight: 600,
          display: 'flex',
          justifyContent: 'space-between',
          gap: 16,
        }}
      >
        <span>Total</span>
        <span>{M.fmt(total)}</span>
      </div>
    </div>
  );
};

const ShareTooltip: React.FC<{
  metric: MetricKey;
  token: ThemeToken;
  active?: boolean;
  payload?: TooltipPayloadItem[];
}> = ({ metric, token, active, payload }) => {
  if (!active || !payload?.length) return null;
  const M = METRICS[metric];
  const p = payload[0];
  return (
    <div style={tooltipBoxStyle(token)}>
      <div style={{ fontWeight: 600, marginBottom: 2 }}>{p.payload?.name ?? p.name}</div>
      <div>{M.fmt(p.value)}</div>
    </div>
  );
};
