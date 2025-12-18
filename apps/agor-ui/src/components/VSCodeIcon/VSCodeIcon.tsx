/**
 * VSCodeIcon Component
 *
 * Displays the VSCode logo as an SVG icon
 */

import Icon from '@ant-design/icons';
import type React from 'react';

export interface VSCodeIconProps {
  /** Optional size in px; if omitted, inherits from parent */
  size?: number;
  /** Additional CSS class (applied to the wrapper span.anticon) */
  className?: string;
  /** Optional vertical offset in px (rarely needed) */
  offsetY?: number;
}

export const VSCodeIcon: React.FC<VSCodeIconProps> = ({ size, className = '', offsetY = 0 }) => {
  const VSCodeSvg: React.FC = () => (
    <svg
      width="1em"
      height="1em"
      viewBox="0 0 128 128"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      focusable="false"
      aria-hidden="true"
      style={{ transform: offsetY ? `translateY(${offsetY}px)` : undefined }}
    >
      <path
        fill="#0065A9"
        d="M123.471 13.82 97.097 1.12A7.973 7.973 0 0 0 88 2.668L1.662 81.387a5.333 5.333 0 0 0 .006 7.887l7.052 6.411a5.333 5.333 0 0 0 6.811.303l103.971-78.875c3.488-2.646 8.498-.158 8.498 4.22v-.306a8.001 8.001 0 0 0-4.529-7.208Z"
      />
      <path
        fill="#007ACC"
        d="m123.471 114.181-26.374 12.698A7.973 7.973 0 0 1 88 125.333L1.662 46.613a5.333 5.333 0 0 1 .006-7.887l7.052-6.411a5.333 5.333 0 0 1 6.811-.303l103.971 78.874c3.488 2.647 8.498.159 8.498-4.219v.306a8.001 8.001 0 0 1-4.529 7.208Z"
      />
      <path
        fill="#1F9CF0"
        d="M97.098 126.882A7.977 7.977 0 0 1 88 125.333c2.952 2.952 8 .861 8-3.314V5.98c0-4.175-5.048-6.266-8-3.313a7.977 7.977 0 0 1 9.098-1.549L123.467 13.8A8 8 0 0 1 128 21.01v85.982a8 8 0 0 1-4.533 7.21l-26.369 12.681Z"
      />
    </svg>
  );

  return (
    <Icon
      component={VSCodeSvg}
      className={className}
      style={size ? { fontSize: size } : undefined}
    />
  );
};
