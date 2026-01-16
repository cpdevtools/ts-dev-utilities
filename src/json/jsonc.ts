import * as jsoncParser from 'jsonc-parser';

/**
 * Parse JSON string with optional comments (JSONC format)
 * 
 * @param text - JSON or JSONC string to parse
 * @returns Parsed JavaScript value
 * 
 * @example
 * ```typescript
 * const data = parseJson('{ "key": "value" /* comment *\/ }');
 * console.log(data.key); // "value"
 * ```
 */
export function parseJson(text: string): unknown {
  const errors: jsoncParser.ParseError[] = [];
  const result = jsoncParser.parse(text, errors, {
    allowTrailingComma: true,
    allowEmptyContent: false,
  });

  if (errors.length > 0) {
    const error = errors[0];
    throw new Error(
      `JSON parse error at offset ${error.offset}: ${jsoncParser.printParseErrorCode(error.error)}`,
    );
  }

  return result;
}

export interface StringifyOptions {
  /** Number of spaces for indentation */
  spaces?: number;
  
  /** Insert final newline */
  insertFinalNewline?: boolean;
}

/**
 * Stringify JavaScript value to JSON
 * 
 * @param value - Value to stringify
 * @param options - Formatting options
 * @returns JSON string
 * 
 * @example
 * ```typescript
 * const json = stringifyJson({ key: 'value' }, { spaces: 2 });
 * ```
 */
export function stringifyJson(value: unknown, options: StringifyOptions = {}): string {
  const { spaces = 2, insertFinalNewline = true } = options;
  
  let json = JSON.stringify(value, null, spaces);
  
  if (insertFinalNewline && !json.endsWith('\n')) {
    json += '\n';
  }
  
  return json;
}
