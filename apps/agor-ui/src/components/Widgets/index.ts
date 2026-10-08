/**
 * In-conversation widgets — UI barrel.
 *
 * Importing this module side-effect-registers every concrete widget
 * component with the `WidgetBlock` dispatcher. Each component file calls
 * `registerWidgetComponent(type, Component)` at module load.
 */

// Side-effect imports — each file registers its widget component on load.
import './EnvVarRequestWidget';
import './GatewayTokenWidget';
import './OAuthConnectWidget';

export { EnvVarRequestWidget } from './EnvVarRequestWidget';
export { GatewayTokenWidget } from './GatewayTokenWidget';
export { OAuthConnectWidget } from './OAuthConnectWidget';
