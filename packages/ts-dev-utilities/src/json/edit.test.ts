import { describe, it, expect } from 'vitest';
import { setJsonValue, updateJsonText } from './edit.js';

describe('updateJsonText', () => {
  it('should preserve comments and trailing commas on untouched siblings', () => {
    const text = `{
  // keep me
  "name": "pkg", // trailing
  "scripts": {
    "build": "tsup",
  },
}
`;

    const result = updateJsonText(text, (pkg) => {
      pkg.version = '1.0.0';
    });

    expect(result).toBe(`{
  // keep me
  "name": "pkg", // trailing
  "scripts": {
    "build": "tsup",
  },
  "version": "1.0.0",
}
`);
  });

  it('should replace a changed primitive in place', () => {
    const text = `{
  "a": 1, // one
  "b": 2
}
`;

    const result = updateJsonText(text, (v) => {
      v.a = 5;
    });

    expect(result).toBe(`{
  "a": 5, // one
  "b": 2
}
`);
  });

  it('should add a nested key at the end of its object', () => {
    const text = `{
  "a": {
    "b": 1
  }
}
`;

    const result = updateJsonText(text, (v) => {
      v.a.c = 2;
    });

    expect(result).toBe(`{
  "a": {
    "b": 1,
    "c": 2
  }
}
`);
  });

  it('should remove a key', () => {
    const text = `{
  // one
  "a": 1,
  "b": 2
}
`;

    const result = updateJsonText(text, (v) => {
      delete v.b;
    });

    expect(result).toBe(`{
  // one
  "a": 1
}
`);
  });

  it('should append items to an array', () => {
    const text = `{
  "list": [
    1, // first
    2
  ]
}
`;

    const result = updateJsonText(text, (v) => {
      v.list.push(3, 4);
    });

    expect(result).toBe(`{
  "list": [
    1, // first
    2,
    3,
    4
  ]
}
`);
  });

  it('should remove trailing items from an array', () => {
    const text = `{
  "list": [1, 2, 3], // c
  "x": true
}
`;

    const result = updateJsonText(text, (v) => {
      v.list = [1];
    });

    expect(result).toBe(`{
  "list": [1], // c
  "x": true
}
`);
  });

  it('should replace an array whose items changed', () => {
    const text = `{
  "list": [1, 2],
  "x": true // keep
}
`;

    const result = updateJsonText(text, (v) => {
      v.list = [2, 1];
    });

    expect(result).toBe(`{
  "list": [
    2,
    1
  ],
  "x": true // keep
}
`);
  });

  it('should keep the indentation of a 4-space file', () => {
    const text = `{
    "a": 1
}
`;

    const result = updateJsonText(text, (v) => {
      v.b = { c: 2 };
    });

    expect(result).toBe(`{
    "a": 1,
    "b": {
        "c": 2
    }
}
`);
  });

  it('should add the first key to an empty object', () => {
    expect(
      updateJsonText('{}', (v) => {
        v.x = 1;
      }),
    ).toBe('{\n  "x": 1\n}');
  });

  it('should keep a trailing newline only when the input had one', () => {
    const add = (v: { b?: number }) => {
      v.b = 2;
    };
    expect(updateJsonText('{ "a": 1 }\n', add)).toMatch(/\n$/);
    expect(updateJsonText('{ "a": 1 }', add)).not.toMatch(/\n$/);
  });

  it('should use the value returned by update', () => {
    const result = updateJsonText('{\n  "a": 1\n}\n', () => ({ a: 1, b: 2 }));
    expect(result).toBe('{\n  "a": 1,\n  "b": 2\n}\n');
  });

  it('should return the text unchanged when nothing changed', () => {
    const text = '{\n  // c\n  "a": [1, 2],\n}\n';
    expect(updateJsonText(text, () => {})).toBe(text);
  });
});

describe('setJsonValue', () => {
  it('should set a nested value in place', () => {
    const text = `{
  "compilerOptions": {
    "strict": false // tmp
  }
}
`;

    expect(setJsonValue(text, ['compilerOptions', 'strict'], true)).toBe(`{
  "compilerOptions": {
    "strict": true // tmp
  }
}
`);
  });

  it('should remove the entry when the value is undefined', () => {
    expect(setJsonValue('{\n  "a": 1,\n  "b": 2\n}\n', ['b'], undefined)).toBe('{\n  "a": 1\n}\n');
  });

  it('should create missing intermediate objects', () => {
    expect(setJsonValue('{}\n', ['a', 'b'], 1)).toBe('{\n  "a": {\n    "b": 1\n  }\n}\n');
  });
});
