import { describe, it, expect } from 'vitest';
import { parseJson, stringifyJson } from './jsonc.js';

describe('parseJson', () => {
  it('should parse valid JSON', () => {
    const result = parseJson('{"key": "value"}');
    expect(result).toEqual({ key: 'value' });
  });

  it('should parse JSON with comments', () => {
    const json = `{
      "key": "value", // inline comment
      /* block comment */
      "number": 42
    }`;
    
    const result = parseJson(json);
    expect(result).toEqual({ key: 'value', number: 42 });
  });

  it('should parse JSON with trailing commas', () => {
    const json = `{
      "key": "value",
      "array": [1, 2, 3,],
    }`;
    
    const result = parseJson(json);
    expect(result).toEqual({ key: 'value', array: [1, 2, 3] });
  });

  it('should throw on invalid JSON', () => {
    expect(() => parseJson('not valid json {')).toThrow();
  });

  it('should parse arrays', () => {
    const result = parseJson('[1, 2, 3]');
    expect(result).toEqual([1, 2, 3]);
  });

  it('should parse nested objects', () => {
    const json = '{"outer": {"inner": {"deep": true}}}';
    const result = parseJson(json);
    expect(result).toEqual({ outer: { inner: { deep: true } } });
  });
});

describe('stringifyJson', () => {
  it('should stringify objects with default formatting', () => {
    const result = stringifyJson({ key: 'value' });
    expect(result).toBe('{\n  "key": "value"\n}\n');
  });

  it('should respect spaces option', () => {
    const result = stringifyJson({ key: 'value' }, { spaces: 4 });
    expect(result).toBe('{\n    "key": "value"\n}\n');
  });

  it('should add final newline by default', () => {
    const result = stringifyJson({ key: 'value' });
    expect(result.endsWith('\n')).toBe(true);
  });

  it('should skip final newline when option is false', () => {
    const result = stringifyJson({ key: 'value' }, { insertFinalNewline: false });
    expect(result).toBe('{\n  "key": "value"\n}');
  });

  it('should stringify arrays', () => {
    const result = stringifyJson([1, 2, 3]);
    expect(result).toBe('[\n  1,\n  2,\n  3\n]\n');
  });

  it('should handle null and primitives', () => {
    expect(stringifyJson(null)).toBe('null\n');
    expect(stringifyJson(42)).toBe('42\n');
    expect(stringifyJson('string')).toBe('"string"\n');
    expect(stringifyJson(true)).toBe('true\n');
  });
});
