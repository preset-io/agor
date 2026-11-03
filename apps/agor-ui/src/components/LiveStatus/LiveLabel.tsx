import { ThoughtChain } from '@ant-design/x';
import type React from 'react';
import { useEffect, useState } from 'react';
import { usePrefersReducedMotion } from '../../hooks/usePrefersReducedMotion';

/** Wall-clock time that advances once a second while `active`. */
export function useTickingNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active]);
  return now;
}

/**
 * One line of status text with AntD X's ThoughtChain blink while `active`.
 * The shimmer is decoration only: under reduced motion the text stays static.
 */
export function LiveLabel({
  children,
  active,
  style,
}: {
  children: React.ReactNode;
  active: boolean;
  style?: React.CSSProperties;
}) {
  const reducedMotion = usePrefersReducedMotion();
  return (
    <ThoughtChain.Item
      title={children}
      variant="text"
      blink={active && !reducedMotion}
      style={{ padding: 0, fontSize: 'inherit', color: 'inherit', ...style }}
      styles={{ title: { fontSize: 'inherit', fontWeight: 'inherit', color: 'inherit' } }}
    />
  );
}
