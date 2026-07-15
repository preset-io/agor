import {
  CheckCircleOutlined,
  CloseCircleOutlined,
  LoadingOutlined,
  StopOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import { Spin, theme } from 'antd';
import type { EnvironmentInferredState } from '../../utils/environmentState';

interface EnvironmentStatusIconProps {
  state: EnvironmentInferredState;
  /** Icon font size in px. */
  size?: number;
}

/**
 * Status icon for an environment's inferred state, shared by the environment
 * pill surfaces so they render the same iconography and spinner.
 */
export function EnvironmentStatusIcon({ state, size = 12 }: EnvironmentStatusIconProps) {
  const { token } = theme.useToken();
  switch (state) {
    case 'starting':
    case 'stopping':
      // Match sibling status icons: Spin's default dot indicator ignores
      // fontSize and misaligns against the pills' inherited line-height.
      return (
        <Spin
          size="small"
          indicator={<LoadingOutlined spin style={{ fontSize: size }} />}
          style={{ display: 'inline-flex', alignItems: 'center' }}
        />
      );
    case 'healthy':
      return <CheckCircleOutlined style={{ color: token.colorSuccess, fontSize: size }} />;
    case 'unhealthy':
      return <WarningOutlined style={{ color: token.colorWarning, fontSize: size }} />;
    case 'running':
      return <CheckCircleOutlined style={{ color: token.colorInfo, fontSize: size }} />;
    case 'error':
      return <CloseCircleOutlined style={{ color: token.colorError, fontSize: size }} />;
    default:
      return <StopOutlined style={{ color: token.colorTextDisabled, fontSize: size }} />;
  }
}
