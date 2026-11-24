# API Reference Generator

The SDK exports `ApiDocGenerator` for creating API references from TypeScript
source text and JSDoc comments. It can produce complete Markdown and HTML
documents, or a JSON manifest for integration with other documentation tools.

```ts
import { ApiDocGenerator } from '@stellar-split/sdk';

const generator = new ApiDocGenerator({
  version: '1.2.0',
  title: 'SDK API Reference',
  sources: {
    client: clientSourceText,
    wallets: walletSourceText,
  },
  categories: {
    client: 'Core',
    wallets: 'Wallets',
  },
  includeDeprecated: false,
});

const markdown = generator.generate('markdown');
const html = generator.generate('html');
const manifest = generator.generate('json');
```

`generate()` accepts `markdown`, `html`, or `json`. The JSON output is a
serialized `DocManifest` containing the SDK version, parsed entries, navigation
tree, and sorted entry index. `generateManifest()` returns that typed object
directly. `generateModuleMarkdown()`, `generateIndex()`, `search()`, and the
entry accessors are also available for custom documentation workflows.

Sources are keyed by module name and should contain JSDoc comments immediately
before the declarations they describe. Supported metadata includes
`@param`, `@returns`, `@example`, `@deprecated`, and `@since`. Entries default
to the `General` category when no category mapping is provided.
