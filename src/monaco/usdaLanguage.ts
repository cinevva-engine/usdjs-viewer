import type * as monaco from 'monaco-editor/esm/vs/editor/editor.api';

let registered = false;

export function registerUsdaLanguage(m: typeof monaco) {
  if (registered) return;
  registered = true;

  const id = 'usda';

  m.languages.register({
    id,
    extensions: ['.usda', '.usd', '.usdc', '.usdz'],
    aliases: ['USDA', 'usd', 'usda'],
  });

  m.languages.setLanguageConfiguration(id, {
    comments: { lineComment: '#' },
    brackets: [
      ['{', '}'],
      ['[', ']'],
      ['(', ')'],
    ],
    autoClosingPairs: [
      { open: '{', close: '}' },
      { open: '[', close: ']' },
      { open: '(', close: ')' },
      { open: '"', close: '"' },
      { open: '<', close: '>' },
      { open: '@', close: '@' },
    ],
    surroundingPairs: [
      { open: '{', close: '}' },
      { open: '[', close: ']' },
      { open: '(', close: ')' },
      { open: '"', close: '"' },
      { open: '<', close: '>' },
      { open: '@', close: '@' },
    ],
  });

  // Minimal, practical Monarch tokenizer for USDA.
  m.languages.setMonarchTokensProvider(id, {
    defaultToken: '',

    keywords: [
      'def',
      'over',
      'class',
      'variantSet',
      'variant',
      'inherits',
      'references',
      'payload',
      'relocates',
      'specializes',
      'custom',
      'uniform',
      'varying',
      'prepend',
      'append',
      'delete',
      'add',
      'none',
      'true',
      'false',
    ],

    // Common USD scalar/array types (not exhaustive)
    types: [
      'bool',
      'uchar',
      'int',
      'uint',
      'int64',
      'uint64',
      'half',
      'float',
      'double',
      'string',
      'token',
      'asset',
      'matrix2d',
      'matrix3d',
      'matrix4d',
      'quatd',
      'quatf',
      'quath',
      'color3f',
      'color4f',
      'color3d',
      'color4d',
      'point3f',
      'point3d',
      'vector3f',
      'vector3d',
      'normal3f',
      'normal3d',
      'float2',
      'float3',
      'float4',
      'double2',
      'double3',
      'double4',
    ],

    tokenizer: {
      root: [
        // Whitespace
        { include: '@whitespace' },

        // USDA header
        [/#usda\b/, 'keyword'],

        // Comments
        [/#.*$/, 'comment'],

        // Paths: </World/Prim.prop>
        [/</, { token: 'delimiter.angle', next: '@path' }],

        // Asset paths: @file@ or @./file@
        [/@[^@]*@/, 'string.special'],

        // Strings
        [/"/, { token: 'string.quote', next: '@string' }],

        // Numbers (incl sci notation)
        [/[+-]?\d+(\.\d+)?([eE][+-]?\d+)?/, 'number'],

        // Identifiers (keywords/types)
        [/[A-Za-z_]\w*/, { cases: { '@keywords': 'keyword', '@types': 'type', '@default': 'identifier' } }],

        // Prim/property names can include ':' and '.'
        [/[A-Za-z_][\w:.]*/, 'identifier'],

        // Punctuation
        [/[{}()[\],=]/, 'delimiter'],
      ],

      whitespace: [[/\s+/, 'white']],

      string: [
        [/[^\\"]+/, 'string'],
        [/\\./, 'string.escape'],
        [/"/, { token: 'string.quote', next: '@pop' }],
      ],

      path: [
        [/[^>]+/, 'string.special'],
        [/>/, { token: 'delimiter.angle', next: '@pop' }],
      ],
    },
  });
}


