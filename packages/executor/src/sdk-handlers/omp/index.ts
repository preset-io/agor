/**
 * Oh My Pi Tool Module
 *
 * Integration with Oh My Pi (OMP), a terminal coding agent driven over its
 * JSONL RPC protocol (`omp --mode rpc`) rather than an in-process SDK.
 */

export { DEFAULT_OMP_CONTEXT_WINDOW, getOmpContextWindowLimit } from './models.js';
export { OmpNormalizer, type OmpSdkResponse } from './normalizer.js';
export { type OmpConfig, OmpTool } from './omp-tool.js';
