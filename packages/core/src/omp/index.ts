/**
 * Oh My Pi (OMP) integration primitives shared by the executor adapter and the
 * daemon. Transport, wire types, event translation, and spawn/MCP setup for
 * driving `omp --mode rpc`.
 */

export * from './event-translator.js';
export * from './event-types.js';
export * from './rpc-client.js';
export * from './spawn-config.js';
