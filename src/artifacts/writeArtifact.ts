import { writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { stringify } from 'yaml';
import type { ProjectArtifactDescriptor } from './types.js';

/**
 * Write an artifact descriptor to {PROJECT_NAME}.artifact.yml
 * 
 * This function should be called from a project's pack script to generate
 * the artifact descriptor file. It uses environment variables set by the workflow.
 * 
 * @param descriptor - The project artifact descriptor to write
 * @throws Error if required environment variables are missing
 * 
 * @example
 * ```typescript
 * import { writeArtifact } from '@cpdevtools/ts-dev-utilities';
 * 
 * await writeArtifact({
 *   project: '@myorg/my-package',
 *   artifacts: [
 *     {
 *       type: 'npm',
 *       name: '@myorg/my-package',
 *       path: 'dist/myorg-my-package-1.2.3.tgz',
 *       registries: ['npm-public']
 *     }
 *   ]
 * });
 * ```
 */
export async function writeArtifact(descriptor: ProjectArtifactDescriptor): Promise<void> {
  const artifactOutputDir = process.env.ARTIFACT_OUTPUT_DIR;
  const projectName = process.env.PROJECT_NAME;

  if (!artifactOutputDir) {
    throw new Error(
      'ARTIFACT_OUTPUT_DIR environment variable is required. ' +
      'This should be set by the workflow.'
    );
  }

  if (!projectName) {
    throw new Error(
      'PROJECT_NAME environment variable is required. ' +
      'This should be set by the workflow.'
    );
  }

  const artifactPath = join(artifactOutputDir, `${projectName}.artifact.yml`);

  // Ensure output directory exists
  await mkdir(dirname(artifactPath), { recursive: true });

  // Write YAML file
  const yamlContent = stringify(descriptor, {
    indent: 2,
    lineWidth: 0, // Don't wrap lines
  });

  await writeFile(artifactPath, yamlContent, 'utf-8');

  console.log(`✓ Generated artifact descriptor: ${artifactPath}`);
}
