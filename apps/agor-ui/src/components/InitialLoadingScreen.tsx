import { Spin, theme } from 'antd';
import type { InitialLoadItem, LoaderPhase } from '../hooks';
import { Tag } from './Tag';

interface Props {
  phase: LoaderPhase;
  connecting: boolean;
  items: InitialLoadItem[];
}

export function InitialLoadingScreen({ phase, connecting, items }: Props) {
  const { token } = theme.useToken();
  const statusMessage = connecting ? 'Connecting to daemon…' : 'Loading workspace…';

  return (
    <div
      style={{
        height: '100vh',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: token.colorBgLayout,
        opacity: phase === 'fading' ? 0 : 1,
        transition: 'opacity 280ms ease-out',
      }}
    >
      <Spin size="large" />
      <div style={{ marginTop: 16, color: 'rgba(255, 255, 255, 0.65)' }}>{statusMessage}</div>
      {!connecting && (
        <div style={{ marginTop: 24, display: 'flex', flexDirection: 'column', gap: 6 }}>
          {items.map(({ key, label, done, count }) => (
            <div
              key={key}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 10,
                minWidth: 200,
                color: done ? 'rgba(255,255,255,0.65)' : 'rgba(255,255,255,0.35)',
              }}
            >
              <span style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span
                  style={{
                    width: 16,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  {done ? (
                    <span style={{ color: token.colorSuccess }}>✓</span>
                  ) : (
                    <Spin size="small" />
                  )}
                </span>
                <span style={{ fontSize: 13 }}>{label}</span>
              </span>
              <Tag
                color={done ? 'success' : 'default'}
                style={{
                  margin: 0,
                  fontSize: 11,
                  lineHeight: '16px',
                  padding: '0 6px',
                  minWidth: 28,
                  textAlign: 'center',
                }}
              >
                {count}
              </Tag>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
