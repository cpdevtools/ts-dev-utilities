/**
 * Artifact system type definitions for Phase 2 Build & Pack
 */

/**
 * NPM package artifact
 */
export interface NpmArtifact {
  type: 'npm';
  /** Package name (e.g., '@myorg/package-name') */
  name: string;
  /** Path to .tgz file. Populated by `gitflow pack` — omit when declaring in release-artifacts.yml. */
  path?: string;
  /** Registry IDs to publish to (Phase 3 will resolve full configs) */
  registries?: string[];
}

/**
 * Docker image artifact
 */
export interface DockerArtifact {
  type: 'docker';
  /** Full image name including registry (e.g., 'ghcr.io/owner/image') */
  name: string;
  /** Local Docker image tag to push (e.g. 'my-image:latest'). Defaults to name + ':latest'. */
  localTag?: string;
  /** Temporary registry tag. Populated by `gitflow pack` — do not set manually. */
  tempTag?: string;
  /** Final version tag for Phase 3. Populated by `gitflow pack` (= PROJECT_VERSION). */
  finalTag?: string;
  /** Image digest from registry. Populated by `gitflow pack`. */
  digest?: string;
  /** Registry where temp image is stored. Populated by `gitflow pack`. */
  registry?: string;
  /** ISO timestamp when image was pushed. Populated by `gitflow pack`. */
  pushedAt?: string;
  /** Registry IDs to publish to (Phase 3 will resolve full configs) */
  registries?: string[];
}

/**
 * NuGet package artifact
 */
export interface NuGetArtifact {
  type: 'nuget';
  /** Package name */
  name: string;
  /** Path to .nupkg file relative to project root */
  path: string;
  /** Registry IDs to publish to (Phase 3 will resolve full configs) */
  registries?: string[];
}

/**
 * Release attachment artifact
 * For arbitrary files to attach to GitHub releases
 */
export interface ReleaseAttachment {
  type: 'release-attachment';
  /** Display name for the attachment */
  name: string;
  /** Path to file relative to project root */
  path: string;
  /** MIME content type (e.g., 'application/octet-stream', 'text/plain') */
  contentType: string;
}

/**
 * Deploy artifact — a zip bundle produced by `gitflow pack-deploy`
 * that gets uploaded to the draft release for consumption by a deploy service.
 *
 * `name` is the unique identifier for this deploy artifact within the project.
 * It drives all generated names — staging directory, zip file, and env var:
 *   DEPLOY_OUTPUT_DIR = <projectCwd>/.deploy-output/<safeName(name)>
 *   zip              = ARTIFACT_OUTPUT_DIR/<safeName(name)>-deploy.zip
 *
 * A project may declare multiple deploy artifacts (e.g. separate staging/prod
 * bundles) as long as each has a distinct name.
 */
export interface DeployArtifact {
  type: 'deploy';
  /**
   * Unique name for this deploy artifact within the project.
   * Used to derive DEPLOY_OUTPUT_DIR and the output zip filename.
   * Typically matches the package name (e.g. '@org/my-service').
   */
  name: string;
  /**
   * Absolute path to the produced deploy.zip.
   * Optional at declaration time — populated by `gitflow pack-deploy` after the zip is created.
   */
  path?: string;
}

/**
 * Custom / plugin-defined artifact type.
 * Used when a project declares an artifact type that is not built in to git-flow.
 * The plugin package must register a handler via `registerArtifactType` before
 * any artifact of this type is dispatched.
 */
export interface CustomArtifact {
  /** Any string key not matching a built-in type */
  type: string;
  /** Artifact name */
  name: string;
  /** Optional output file path */
  path?: string;
  /** Additional plugin-specific fields */
  [key: string]: unknown;
}

/**
 * Union of all artifact types
 */
export type Artifact =
  | NpmArtifact
  | DockerArtifact
  | NuGetArtifact
  | ReleaseAttachment
  | DeployArtifact
  | CustomArtifact;

/**
 * Project artifact descriptor
 * One per project, contains all artifacts produced by that project
 */
export interface ProjectArtifactDescriptor {
  /** Project name/identifier */
  project: string;
  /** All artifacts produced by this project */
  artifacts: Artifact[];
}
