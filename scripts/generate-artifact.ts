#!/usr/bin/env node
import { writeArtifact } from '../dist/artifacts/index.js';
import { readFile } from 'fs/promises';
import { join } from 'path';

async function generateArtifact() {
  const pkgPath = join(process.cwd(), 'package.json');
  const pkg = JSON.parse(await readFile(pkgPath, 'utf-8'));
  
  const version = process.env.PROJECT_VERSION || pkg.version;
  
  // Always set PROJECT_NAME to filesystem-safe name (remove @ and replace / with -)
  process.env.PROJECT_NAME = pkg.name.replace(/^@/, '').replace(/\//g, '-');
  
  // Ensure ARTIFACT_OUTPUT_DIR is set
  if (!process.env.ARTIFACT_OUTPUT_DIR) {
    process.env.ARTIFACT_OUTPUT_DIR = '.artifacts';
  }
  
  // Find the tarball that was created by pnpm pack
  const tarballName = `${process.env.PROJECT_NAME}-${version}.tgz`;
  // Path should be relative to project root
  // Extract just the directory name from ARTIFACT_OUTPUT_DIR (might be absolute or relative)
  const artifactDir = process.env.ARTIFACT_OUTPUT_DIR?.split('/').pop() || '.artifacts';
  const tarballPath = join(artifactDir, tarballName);
  
  await writeArtifact({
    project: pkg.name,
    artifacts: [
      {
        type: 'npm',
        name: pkg.name,
        path: tarballPath,
        registries: ['github-npm']
      }
    ]
  });
  
  console.log(`✅ Generated artifact descriptor for ${pkg.name}@${version}`);
}

generateArtifact().catch((err) => {
  console.error('Failed to generate artifact:', err);
  process.exit(1);
});
