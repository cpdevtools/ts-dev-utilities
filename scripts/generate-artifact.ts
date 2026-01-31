#!/usr/bin/env node
import { writeArtifact } from '../dist/artifacts/index.js';
import { readFile } from 'fs/promises';
import { join } from 'path';

async function generateArtifact() {
  const pkgPath = join(process.cwd(), 'package.json');
  const pkg = JSON.parse(await readFile(pkgPath, 'utf-8'));
  
  const version = process.env.PROJECT_VERSION || pkg.version;
  
  // Ensure PROJECT_NAME is set (filesystem-safe name without @ and /)
  if (!process.env.PROJECT_NAME) {
    process.env.PROJECT_NAME = pkg.name.replace(/^@/, '').replace(/\//g, '-');
  }
  
  // Ensure ARTIFACT_OUTPUT_DIR is set
  if (!process.env.ARTIFACT_OUTPUT_DIR) {
    process.env.ARTIFACT_OUTPUT_DIR = '.artifacts';
  }
  
  // Find the tarball that was created by pnpm pack
  const tarballName = `${process.env.PROJECT_NAME}-${version}.tgz`;
  
  await writeArtifact({
    project: pkg.name,
    artifacts: [
      {
        type: 'npm',
        name: pkg.name,
        path: tarballName,
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
