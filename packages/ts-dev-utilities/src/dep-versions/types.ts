export interface DepChange {
  /** Absolute path to the file containing the drift */
  file: string;
  /** Package / image / action name */
  name: string;
  /** Version currently in the file */
  from: string;
  /** Target version from the deps file */
  to: string;
}

export interface DepVersionHandler {
  /** Key matching the YAML section name (e.g. 'npm', 'github-actions') */
  readonly name: string;
  /** Return all entries whose version differs from the target — does not write */
  check(cwd: string, deps: Record<string, string>): Promise<DepChange[]>;
  /** Apply target versions, return what was changed */
  fix(cwd: string, deps: Record<string, string>): Promise<DepChange[]>;
}

export interface DepsFile {
  npm?: Record<string, string>;
  dotnet?: Record<string, string>;
  docker?: Record<string, string>;
  'github-actions'?: Record<string, string>;
  [section: string]: Record<string, string> | undefined;
}
