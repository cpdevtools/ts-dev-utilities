import * as jsoncParser from 'jsonc-parser';
import { parseJson } from './jsonc.js';

/** Options for the comment-preserving edit functions. */
export interface JsonEditOptions {
  /**
   * Indentation width for inserted text. When omitted it is detected from the
   * input (the indentation of the first nested line), defaulting to 2.
   */
  spaces?: number;
}

type Change =
  | { kind: 'set'; path: jsoncParser.JSONPath; value: unknown; isArrayInsertion?: boolean }
  | { kind: 'truncate'; path: jsoncParser.JSONPath; keep: number };

/**
 * Update a JSON/JSONC document while preserving comments, key order and the
 * formatting of everything the update does not touch.
 *
 * The text is parsed as JSONC and a deep clone of the value is handed to
 * `update`. The new document value is whatever `update` returns, or the
 * (mutated) clone when it returns `undefined`. Old and new values are diffed
 * and the difference is applied as a minimal set of text edits:
 *
 * - Objects are diffed key by key, recursing into nested objects. A removed key
 *   becomes a removal edit, a new key is appended at the end of its object, and
 *   a changed primitive is replaced in place.
 * - Arrays that only grew get the extra items appended; arrays that only shrank
 *   get the trailing items removed; any other change replaces the whole array.
 *
 * @param text - JSON or JSONC document
 * @param update - Mutates the clone in place, or returns a replacement value
 * @param options - Formatting options
 * @returns The edited document text
 *
 * @example
 * ```typescript
 * const next = updateJsonText(raw, (pkg) => {
 *   pkg.scripts.build = 'tsup';
 * });
 * ```
 */
export function updateJsonText(
  text: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  update: (value: any) => unknown,
  options: JsonEditOptions = {},
): string {
  const original = parseJson(text);
  const draft = structuredClone(original);
  const returned = update(draft);
  const next = returned === undefined ? draft : returned;

  const formattingOptions = resolveFormatting(text, options);
  let result = text;
  for (const change of diff([], original, next)) {
    result = applyChange(result, change, formattingOptions);
  }
  return keepTrailingNewline(text, result);
}

/**
 * Set or remove a single value in a JSON/JSONC document by path, preserving
 * comments and formatting elsewhere. Missing intermediate objects are created.
 *
 * @param text - JSON or JSONC document
 * @param path - Property names and array indices leading to the value
 * @param value - New value; `undefined` removes the entry
 * @param options - Formatting options
 * @returns The edited document text
 *
 * @example
 * ```typescript
 * setJsonValue(raw, ['compilerOptions', 'strict'], true);
 * setJsonValue(raw, ['scripts', 'postinstall'], undefined); // remove
 * ```
 */
export function setJsonValue(
  text: string,
  path: (string | number)[],
  value: unknown,
  options: JsonEditOptions = {},
): string {
  const edits = jsoncParser.modify(text, path, value, {
    formattingOptions: resolveFormatting(text, options),
  });
  return keepTrailingNewline(text, jsoncParser.applyEdits(text, edits));
}

function diff(path: jsoncParser.JSONPath, before: unknown, after: unknown): Change[] {
  if (isPlainObject(before) && isPlainObject(after)) {
    const changes: Change[] = [];
    for (const key of Object.keys(before)) {
      if (!has(after, key)) changes.push({ kind: 'set', path: [...path, key], value: undefined });
    }
    for (const key of Object.keys(after)) {
      if (!has(after, key)) continue;
      if (has(before, key)) changes.push(...diff([...path, key], before[key], after[key]));
      else changes.push({ kind: 'set', path: [...path, key], value: after[key] });
    }
    return changes;
  }

  if (Array.isArray(before) && Array.isArray(after)) {
    if (startsWith(after, before)) {
      return after.slice(before.length).map(
        (item, i): Change => ({
          kind: 'set',
          path: [...path, before.length + i],
          value: item,
          isArrayInsertion: true,
        }),
      );
    }
    if (startsWith(before, after)) {
      return after.length === 0
        ? [{ kind: 'set', path, value: [] }]
        : [{ kind: 'truncate', path, keep: after.length }];
    }
    return [{ kind: 'set', path, value: after }];
  }

  return deepEqual(before, after) ? [] : [{ kind: 'set', path, value: after }];
}

function applyChange(
  text: string,
  change: Change,
  formattingOptions: jsoncParser.FormattingOptions,
): string {
  if (change.kind === 'truncate') return truncateArray(text, change.path, change.keep);
  const edits = jsoncParser.modify(text, change.path, change.value, {
    formattingOptions,
    isArrayInsertion: change.isArrayInsertion,
  });
  return jsoncParser.applyEdits(text, edits);
}

/**
 * Remove every item after the first `keep` of the array at `path`. Done with a
 * single hand-built edit because `modify` mis-computes the removal range of the
 * last item of a single-line array (`[1, 2, 3]` minus index 2 gives `[1, 23]`).
 */
function truncateArray(text: string, path: jsoncParser.JSONPath, keep: number): string {
  const root = jsoncParser.parseTree(text, undefined, { allowTrailingComma: true });
  const node = root && jsoncParser.findNodeAtLocation(root, path);
  const items = node?.type === 'array' ? node.children : undefined;
  if (!items || keep < 1 || items.length <= keep) {
    throw new Error(`Cannot truncate array at ${JSON.stringify(path)} to ${keep} items`);
  }
  const previous = items[keep - 1];
  const last = items[items.length - 1];
  const offset = previous.offset + previous.length;
  return jsoncParser.applyEdits(text, [
    { offset, length: last.offset + last.length - offset, content: '' },
  ]);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Own key with a defined value — `undefined` counts as absent, as `JSON.stringify` treats it. */
function has(obj: Record<string, unknown>, key: string): boolean {
  return Object.hasOwn(obj, key) && obj[key] !== undefined;
}

function startsWith(list: unknown[], prefix: unknown[]): boolean {
  return prefix.length <= list.length && prefix.every((item, i) => deepEqual(item, list[i]));
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, i) => deepEqual(item, b[i]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const keys = Object.keys(a);
    return (
      keys.length === Object.keys(b).length &&
      keys.every((key) => Object.hasOwn(b, key) && deepEqual(a[key], b[key]))
    );
  }
  return false;
}

function resolveFormatting(text: string, options: JsonEditOptions): jsoncParser.FormattingOptions {
  return { insertSpaces: true, tabSize: options.spaces ?? detectIndent(text) ?? 2 };
}

/** Width of the first indented line, which in a formatted document is one indent level. */
function detectIndent(text: string): number | undefined {
  const match = /^( +)\S/m.exec(text);
  return match ? match[1].length : undefined;
}

function keepTrailingNewline(original: string, edited: string): string {
  if (!original.endsWith('\n') || edited.endsWith('\n')) return edited;
  return edited + (original.endsWith('\r\n') ? '\r\n' : '\n');
}
