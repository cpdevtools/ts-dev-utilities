# JSON Utilities

A thin wrapper over [`jsonc-parser`](https://github.com/microsoft/node-jsonc-parser) for reading
config files that are JSON "with the VS Code rules" — comments and trailing commas — such as
`tsconfig.json`, `.eslintrc.json`, or a hand-maintained `package.json`.

```ts
import { parseJson, stringifyJson } from '@cpdevtools/ts-dev-utilities/json';
```

This is the parser [project discovery](Project-Discovery) uses for every `package.json`, which is
why a commented manifest does not break the runner.

## `parseJson(text): unknown`

```ts
const config = parseJson(await readFile('tsconfig.json', 'utf-8'));
```

- Comments (`//` and `/* */`) are allowed.
- Trailing commas are allowed.
- **Empty content is not** — an empty string is a parse error, not `undefined`.
- On failure it throws with the offset and the parser's error code:
  `JSON parse error at offset 42: PropertyNameExpected`. Only the first error is reported.

The return type is `unknown`, so cast at the call site:

```ts
const pkg = parseJson(raw) as PackageJson;
```

## `stringifyJson(value, options?): string`

```ts
const json = stringifyJson(data, { spaces: 2 });
```

| Option               | Default | Description                                   |
| -------------------- | ------- | --------------------------------------------- |
| `spaces`             | `2`     | Indentation width.                            |
| `insertFinalNewline` | `true`  | Append a trailing newline if there isn't one. |

This is plain `JSON.stringify` underneath — it does **not** round-trip comments. Parsing a
commented file and stringifying it back drops the comments. If you need to preserve them, edit the
text with `jsonc-parser`'s own edit API instead.

Source:
[`src/json/jsonc.ts`](https://github.com/cpdevtools/ts-dev-utilities/blob/main/packages/ts-dev-utilities/src/json/jsonc.ts)
