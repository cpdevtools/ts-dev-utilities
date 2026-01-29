/**
 * Project discovery and analysis types
 */

export interface Project {
  /** Path to package.json file */
  packageJsonPath: string;
  
  /** Directory containing the package.json */
  directory: string;
  
  /** Parsed package.json contents */
  packageJson: PackageJson;
  
  /** Project name (from package.json) */
  name: string;
  
  /** Project dependencies */
  dependencies?: Record<string, string>;
  
  /** Project devDependencies */
  devDependencies?: Record<string, string>;
}

/** Alias for backward compatibility */
export type ProjectInfo = Project;

export interface PackageJson {
  name?: string;
  version?: string;
  private?: boolean;
  workspaces?: string[] | { packages: string[] };
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
  [key: string]: unknown;
}

export interface ProjectDiscoveryOptions {
  /** Working directory to start search from (defaults to process.cwd()) */
  cwd?: string;
  
  /** Glob patterns to find package.json files */
  patterns?: string[];
  
  /** Patterns to exclude */
  ignore?: string[];
}
