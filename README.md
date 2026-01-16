# @cpdevtools/ts-dev-utilities

TypeScript development utilities for project discovery, JSON operations, and common tooling.

## Installation

```bash
npm install @cpdevtools/ts-dev-utilities
```

## Features

### Project Discovery

Find and analyze projects in a workspace:

```typescript
import { discoverProjects } from '@cpdevtools/ts-dev-utilities/project';

const projects = await discoverProjects({
  cwd: process.cwd(),
  patterns: ['packages/*/package.json'],
});
```

### JSON Utilities

Parse JSON with comments (JSONC):

```typescript
import { parseJson, stringifyJson } from '@cpdevtools/ts-dev-utilities/json';

const data = parseJson('{ "key": "value" /* comment */ }');
const json = stringifyJson(data, { spaces: 2 });
```

### Re-exports

Common utilities re-exported for convenience:

```typescript
import { globby } from '@cpdevtools/ts-dev-utilities';
import * as changeCase from '@cpdevtools/ts-dev-utilities';
```

## Development

```bash
# Install dependencies
npm install

# Run tests
npm test

# Build
npm run build

# Lint
npm run lint

# Format
npm run format
```

## License

MIT
