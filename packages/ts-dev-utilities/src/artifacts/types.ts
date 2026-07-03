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
  /** Path to .tgz file relative to project root */
  path: string;
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
  /** Temporary tag used during Phase 2 (e.g., 'temp-abc1234') */
  tempTag: string;
  /** Final version tag for Phase 3 (e.g., '1.2.3') */
  finalTag: string;
  /** Image digest from registry */
  digest: string;
  /** Registry where temp image is stored */
  registry: string;
  /** ISO timestamp when image was pushed */
  pushedAt: string;
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
 * Union of all artifact types
 */
export type Artifact =
  | NpmArtifact
  | DockerArtifact
  | NuGetArtifact
  | ReleaseAttachment;

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
