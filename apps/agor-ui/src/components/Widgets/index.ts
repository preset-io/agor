/**
 * In-conversation widgets — UI barrel.
 *
 * Importing this module side-effect-registers every concrete widget
 * component with the `WidgetBlock` dispatcher. Each component file calls
 * `registerWidgetComponent(type, Component)` at module load.
 *
 * See `docs/internal/in-conversation-widgets-design-2026-05-19.md`.
 */

// Side-effect imports — each file registers its widget component on load.
import './EnvVarRequestWidget';

export { EnvVarRequestWidget } from './EnvVarRequestWidget';
