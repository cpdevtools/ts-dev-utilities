/**
 * Project discovery module
 * Find and analyze projects in a workspace
 */

export { discoverProjects } from './discover.js';
export type { Project, ProjectInfo, ProjectDiscoveryOptions, PackageJson } from './types.js';
export { buildDependencyGraph, DependencyGraph } from './dependencyGraph.js';
export type { DependencyNode } from './dependencyGraph.js';
