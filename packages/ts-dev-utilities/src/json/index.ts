/**
 * JSON utilities module
 * Parse and stringify JSON with comments support, and edit it without losing them
 */

export { parseJson, stringifyJson, type StringifyOptions } from './jsonc.js';
export { updateJsonText, setJsonValue, type JsonEditOptions } from './edit.js';
