/**
 * Dependency graph utilities for project dependency management
 */

import type { ProjectInfo } from '../project/types.js';

/**
 * A node in the dependency graph
 */
export interface DependencyNode {
  /** Project name */
  name: string;
  /** Project information */
  project: ProjectInfo;
  /** Direct dependencies (project names) */
  dependencies: Set<string>;
  /** Projects that depend on this one */
  dependents: Set<string>;
}

/**
 * Dependency graph for workspace projects
 */
export class DependencyGraph {
  private nodes = new Map<string, DependencyNode>();

  /**
   * Add a project to the graph
   */
  addProject(project: ProjectInfo): void {
    if (!this.nodes.has(project.name)) {
      this.nodes.set(project.name, {
        name: project.name,
        project,
        dependencies: new Set(),
        dependents: new Set(),
      });
    }
  }

  /**
   * Add a dependency edge between two projects
   * @param from - Project that has the dependency
   * @param to - Project that is depended upon
   */
  addDependency(from: string, to: string): void {
    const fromNode = this.nodes.get(from);
    const toNode = this.nodes.get(to);

    if (!fromNode) {
      throw new Error(`Project not found in graph: ${from}`);
    }

    if (!toNode) {
      throw new Error(`Project not found in graph: ${to}`);
    }

    fromNode.dependencies.add(to);
    toNode.dependents.add(from);
  }

  /**
   * Get a project node
   */
  getNode(name: string): DependencyNode | undefined {
    return this.nodes.get(name);
  }

  /**
   * Get all project nodes
   */
  getAllNodes(): DependencyNode[] {
    return Array.from(this.nodes.values());
  }

  /**
   * Get all project names
   */
  getAllProjectNames(): string[] {
    return Array.from(this.nodes.keys());
  }

  /**
   * Check if graph has a cycle
   * @returns Array of project names forming a cycle, or undefined if no cycle
   */
  detectCycle(): string[] | undefined {
    const visited = new Set<string>();
    const recursionStack = new Set<string>();
    const path: string[] = [];

    const visit = (name: string): boolean => {
      if (recursionStack.has(name)) {
        // Found a cycle - return true
        return true;
      }

      if (visited.has(name)) {
        return false;
      }

      visited.add(name);
      recursionStack.add(name);
      path.push(name);

      const node = this.nodes.get(name);
      if (node) {
        for (const dep of node.dependencies) {
          if (visit(dep)) {
            return true;
          }
        }
      }

      recursionStack.delete(name);
      path.pop();
      return false;
    };

    for (const name of this.nodes.keys()) {
      if (!visited.has(name)) {
        if (visit(name)) {
          return path;
        }
      }
    }

    return undefined;
  }

  /**
   * Get projects in topological order (dependencies before dependents)
   * @returns Array of batches, where each batch contains projects that can be processed in parallel
   * @throws Error if circular dependency is detected
   */
  getTopologicalBatches(): ProjectInfo[][] {
    // Check for cycles first
    const cycle = this.detectCycle();
    if (cycle) {
      throw new Error(
        `Circular dependency detected: ${cycle.join(' -> ')} -> ${cycle[0]}`
      );
    }

    const batches: ProjectInfo[][] = [];
    const processed = new Set<string>();
    const remaining = new Set(this.nodes.keys());

    while (remaining.size > 0) {
      // Find all projects whose dependencies have been processed
      const batch: ProjectInfo[] = [];

      for (const name of remaining) {
        const node = this.nodes.get(name)!;
        const hasUnprocessedDeps = Array.from(node.dependencies).some(
          (dep) => !processed.has(dep)
        );

        if (!hasUnprocessedDeps) {
          batch.push(node.project);
        }
      }

      if (batch.length === 0) {
        // This shouldn't happen if cycle detection works correctly
        throw new Error(
          'Unable to determine topological order. Possible circular dependency.'
        );
      }

      batches.push(batch);

      // Mark batch as processed
      for (const project of batch) {
        processed.add(project.name);
        remaining.delete(project.name);
      }
    }

    return batches;
  }
}

/**
 * Build a dependency graph from project information
 * @param projects - Array of discovered projects
 * @param workspaceProjects - Set of workspace project names (to filter external deps)
 * @returns Dependency graph
 */
export function buildDependencyGraph(
  projects: ProjectInfo[],
  workspaceProjects?: Set<string>
): DependencyGraph {
  const graph = new DependencyGraph();
  const projectNames = new Set(projects.map((p) => p.name || p.packageJson.name!));

  // Add all projects to graph first
  for (const project of projects) {
    graph.addProject(project);
  }

  // Add dependency edges
  for (const project of projects) {
    const deps = {
      ...project.packageJson.dependencies,
      ...project.packageJson.devDependencies,
    };
    
    for (const depName of Object.keys(deps || {})) {
      // Only add edge if dependency is in the workspace
      if (projectNames.has(depName)) {
        graph.addDependency(project.name || project.packageJson.name!, depName);
      } else if (workspaceProjects?.has(depName)) {
        // Dependency is in workspace but not in discovered projects
        console.warn(
          `Warning: ${project.name || project.packageJson.name} depends on ${depName} which is in workspace but not discovered`
        );
      }
    }
  }

  return graph;
}
