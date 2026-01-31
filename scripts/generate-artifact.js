#!/usr/bin/env node
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const index_js_1 = require("../dist/artifacts/index.js");
const promises_1 = require("fs/promises");
const path_1 = require("path");
async function generateArtifact() {
    const pkgPath = (0, path_1.join)(process.cwd(), 'package.json');
    const pkg = JSON.parse(await (0, promises_1.readFile)(pkgPath, 'utf-8'));
    const version = process.env.PROJECT_VERSION || pkg.version;
    // Find the tarball that was created by pnpm pack
    const tarballName = `cpdevtools-ts-dev-utilities-${version}.tgz`;
    await (0, index_js_1.writeArtifact)({
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
