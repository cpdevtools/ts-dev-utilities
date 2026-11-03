# JSON Utilities

A thin wrapper over [`jsonc-parser`](https://github.com/microsoft/node-jsonc-parser) for reading
config files that are JSON "with the VS Code rules" — comments and trailing commas — such as
`tsconfig.json`, `.eslintrc.json`, or a hand-maintained `package.json`.

```ts
import {
  parseJson,
  stringifyJson,
  updateJsonText,
  setJsonValue,
} from '@cpdevtools/ts-dev-utilities/json';
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
commented file and stringifying it back drops the comments. To change a file without losing them,
use the two edit functions below.

## `updateJsonText(text, update, options?): string`

```ts
const next = updateJsonText(raw, (pkg) => {
  pkg.scripts.build = 'tsup';
  delete pkg.scripts.prepublish;
});
await writeFile('package.json', next);
```

`update` receives a deep clone of the parsed document. Mutate it and return nothing, or return a
replacement value. The old and new values are diffed and only the differences are written as text
edits, so comments, key order and the formatting of everything else survive.

| Change                           | Edit                                              |
| -------------------------------- | ------------------------------------------------- |
| Primitive changed                | Replaced in place.                                |
| Key added                        | Appended at the end of its object.                |
| Key removed (or set `undefined`) | Removed, with its comma.                          |
| Nested object changed            | Recursed into; only the changed keys are touched. |
| Array grew at the end            | New items appended.                               |
| Array shrank at the end          | Trailing items removed.                           |
| Array changed otherwise          | Whole array replaced.                             |

| Option   | Default                          | Description                          |
| -------- | -------------------------------- | ------------------------------------ |
| `spaces` | Detected from the text, else `2` | Indentation width for inserted text. |

Inserted text is formatted by `jsonc-parser`, which reflows the container it writes into —
appending to a single-line array turns it multi-line. A trailing newline in the input is kept.

Because it only needs the text, it works the same on a virtual file tree (an Angular schematics
`Tree`, say) as on the disk.

## `setJsonValue(text, path, value, options?): string`

```ts
setJsonValue(raw, ['compilerOptions', 'strict'], true);
setJsonValue(raw, ['scripts', 'postinstall'], undefined); // removes the key
```

One edit at a known path, for callers that do not need a diff. Missing intermediate objects are
created, and `undefined` removes the entry. Takes the same `spaces` option.

Source:
[`src/json/jsonc.ts`](https://github.com/cpdevtools/ts-dev-utilities/blob/main/packages/ts-dev-utilities/src/json/jsonc.ts) ·
[`src/json/edit.ts`](https://github.com/cpdevtools/ts-dev-utilities/blob/main/packages/ts-dev-utilities/src/json/edit.ts)
