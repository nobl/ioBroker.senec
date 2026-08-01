// ioBroker eslint template configuration file for js and ts files
// Please note that esm or react based modules need additional modules loaded.
import config from '@iobroker/eslint-config';
import globals from 'globals';

export default [
    ...config,
    {
        // specify files to exclude from linting here
        ignores: [
            '.dev-server/',
            '.vscode/',
            '*.config.mjs',
            'build',
            'dist',
            'admin/build', 
            'admin/words.js',
            'admin/admin.d.ts',
            'admin/blockly.js',
            '**/adapter-config.d.ts',
            '**/*.d.ts',
        ],
    },
    {
        // The test suites run under mocha, whose describe/it/before/after are injected into
        // the global scope. Declaring them keeps no-undef doing its job everywhere else
        // instead of switching it off wholesale.
        files: ['test/**/*.js', '*.test.js'],
        languageOptions: {
            globals: {
                ...globals.mocha,
            },
        },
        rules: {
            // Test doubles stand in for arbitrary collaborators, so `any` and `Function` are
            // frequently the honest annotation rather than an imprecise one: a stub replacing
            // a module export really does have the signature `Function`, and a helper taking
            // a caller-supplied body really does accept `() => any`. Editors still read the
            // surrounding JSDoc, so the documentation value is unaffected — only the demand
            // for a narrower type is lifted, and only here.
            'jsdoc/reject-any-type': 'off',
            'jsdoc/reject-function-type': 'off',
        },
    },
    {
        // you may disable some 'jsdoc' warnings - but using jsdoc is highly recommended
        // as this improves maintainability. jsdoc warnings will not block buiuld process.
        rules: {
            // 'jsdoc/require-jsdoc': 'off',
            // 'jsdoc/require-param': 'off',
            // 'jsdoc/require-param-description': 'off',
            // 'jsdoc/require-returns-description': 'off',
            // 'jsdoc/require-returns-check': 'off',
        },
    },
];