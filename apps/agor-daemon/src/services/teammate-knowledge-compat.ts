/**
 * Deprecated compatibility exports for the pre-rename assistant knowledge helper.
 * Canonical code should import from ./teammate-knowledge.js.
 */
export {
  ensureTeammateKnowledgeNamespace as ensureAssistantKnowledgeNamespace,
  TEAMMATE_MEMORY_PATH_TEMPLATE as ASSISTANT_MEMORY_PATH_TEMPLATE,
  TEAMMATE_NAMESPACE_MISSING_MESSAGE as ASSISTANT_NAMESPACE_MISSING_MESSAGE,
} from './teammate-knowledge.js';
