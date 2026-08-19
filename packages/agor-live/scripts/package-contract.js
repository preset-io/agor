/** Dependency-free contract shared by the build, packer, and package tests. */
export const BUNDLED_INTERNAL_PACKAGES = Object.freeze([
  Object.freeze({ name: 'agentic-tool-opencode', distDirectory: 'agentic-tool-opencode' }),
  Object.freeze({ name: 'agentic-tools', distDirectory: 'agentic-tools' }),
  Object.freeze({ name: 'core', distDirectory: 'core' }),
  Object.freeze({ name: 'git', distDirectory: 'git' }),
]);
