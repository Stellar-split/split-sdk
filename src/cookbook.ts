/**
 * SDK Cookbook — common usage patterns (#1198)
 *
 * Provides a registry of recipes (code snippets) with search, copy-paste
 * tracking, ratings, and comment threads.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A recipe's numeric rating (1 = worst, 5 = best). */
export type RecipeRating = 1 | 2 | 3 | 4 | 5;

/** Core recipe data. */
export interface Recipe {
  /** Unique identifier. */
  id: string;
  /** Short display title. */
  title: string;
  /** Longer explanation of what the recipe demonstrates. */
  description: string;
  /** Category label (e.g. "invoices", "payments", "webhooks"). */
  category: string;
  /** Searchable tags. */
  tags: string[];
  /** The code snippet. */
  code: string;
  /** Language identifier for syntax highlighting (e.g. "typescript"). */
  language: string;
  /** Optional author name. */
  author?: string;
  /** Current average rating (1–5), or undefined if no ratings. */
  rating?: number;
  /** User comments. */
  comments?: string[];
}

/** A recipe stored in the cookbook registry (extends Recipe with usage stats). */
export interface CookbookEntry extends Recipe {
  /** Number of times the snippet was copied. */
  copyCount: number;
  /** Total rating score (sum of all submitted ratings). */
  ratingTotal: number;
  /** Number of ratings submitted. */
  ratingCount: number;
}

// ---------------------------------------------------------------------------
// SdkCookbook
// ---------------------------------------------------------------------------

/**
 * Registry of SDK usage patterns with search, copy-paste tracking,
 * ratings, and comment support.
 *
 * @example
 * ```ts
 * const cookbook = new SdkCookbook();
 * const recipe = cookbook.getRecipe('create-invoice');
 * const code = cookbook.copySnippet('create-invoice');
 * ```
 */
export class SdkCookbook {
  private readonly registry = new Map<string, CookbookEntry>();

  constructor() {
    for (const recipe of BUILTIN_RECIPES) {
      this.registry.set(recipe.id, {
        ...recipe,
        copyCount: 0,
        ratingTotal: 0,
        ratingCount: 0,
        comments: recipe.comments ? [...recipe.comments] : [],
      });
    }
  }

  // -------------------------------------------------------------------------
  // CRUD
  // -------------------------------------------------------------------------

  /**
   * Register a new recipe (or overwrite an existing one with the same id).
   *
   * @param recipe - Recipe to add.
   */
  addRecipe(recipe: Recipe): void {
    const existing = this.registry.get(recipe.id);
    this.registry.set(recipe.id, {
      ...recipe,
      copyCount: existing?.copyCount ?? 0,
      ratingTotal: existing?.ratingTotal ?? 0,
      ratingCount: existing?.ratingCount ?? 0,
      comments: recipe.comments ? [...recipe.comments] : (existing?.comments ?? []),
    });
  }

  /**
   * Remove a recipe by id.
   *
   * @param id - Recipe id to remove.
   * @returns `true` if a recipe was removed, `false` if not found.
   */
  removeRecipe(id: string): boolean {
    return this.registry.delete(id);
  }

  /**
   * Retrieve a recipe by id.
   *
   * @param id - Recipe id.
   * @returns The CookbookEntry, or `undefined` if not found.
   */
  getRecipe(id: string): CookbookEntry | undefined {
    return this.registry.get(id);
  }

  // -------------------------------------------------------------------------
  // Search & filtering
  // -------------------------------------------------------------------------

  /**
   * Search recipes by title, description, tags, or category.
   *
   * @param query - Case-insensitive search string.
   * @returns Matching entries, ordered by relevance (title match first).
   */
  search(query: string): CookbookEntry[] {
    const q = query.toLowerCase().trim();
    if (!q) return this.listAll();

    const titleMatches: CookbookEntry[] = [];
    const otherMatches: CookbookEntry[] = [];

    for (const entry of this.registry.values()) {
      const inTitle = entry.title.toLowerCase().includes(q);
      const inDesc = entry.description.toLowerCase().includes(q);
      const inTags = entry.tags.some((t) => t.toLowerCase().includes(q));
      const inCategory = entry.category.toLowerCase().includes(q);

      if (inTitle) {
        titleMatches.push(entry);
      } else if (inDesc || inTags || inCategory) {
        otherMatches.push(entry);
      }
    }
    return [...titleMatches, ...otherMatches];
  }

  /**
   * Return all recipes in the given category.
   *
   * @param category - Category label (case-insensitive match).
   */
  getByCategory(category: string): CookbookEntry[] {
    const c = category.toLowerCase();
    return Array.from(this.registry.values()).filter(
      (e) => e.category.toLowerCase() === c,
    );
  }

  /**
   * List all unique category labels present in the registry.
   */
  listCategories(): string[] {
    return [...new Set(Array.from(this.registry.values()).map((e) => e.category))].sort();
  }

  /**
   * List all registered recipes.
   */
  listAll(): CookbookEntry[] {
    return Array.from(this.registry.values());
  }

  // -------------------------------------------------------------------------
  // Copy-paste
  // -------------------------------------------------------------------------

  /**
   * Return the code snippet for a recipe and increment its copy count.
   *
   * @param id - Recipe id.
   * @returns The code string.
   * @throws {Error} If the recipe does not exist.
   */
  copySnippet(id: string): string {
    const entry = this.registry.get(id);
    if (!entry) throw new Error(`Recipe not found: ${id}`);
    entry.copyCount += 1;
    return entry.code;
  }

  // -------------------------------------------------------------------------
  // Ratings
  // -------------------------------------------------------------------------

  /**
   * Submit a rating for a recipe and update the running average.
   *
   * @param id - Recipe id.
   * @param rating - Integer from 1 to 5.
   * @throws {Error} If the recipe does not exist.
   */
  rateRecipe(id: string, rating: RecipeRating): void {
    const entry = this.registry.get(id);
    if (!entry) throw new Error(`Recipe not found: ${id}`);
    entry.ratingTotal += rating;
    entry.ratingCount += 1;
    entry.rating = entry.ratingTotal / entry.ratingCount;
  }

  // -------------------------------------------------------------------------
  // Comments
  // -------------------------------------------------------------------------

  /**
   * Append a comment to a recipe's comment thread.
   *
   * @param id - Recipe id.
   * @param comment - Comment text to append.
   * @throws {Error} If the recipe does not exist.
   */
  addComment(id: string, comment: string): void {
    const entry = this.registry.get(id);
    if (!entry) throw new Error(`Recipe not found: ${id}`);
    if (!entry.comments) entry.comments = [];
    entry.comments.push(comment);
  }
}

// ---------------------------------------------------------------------------
// Built-in recipes
// ---------------------------------------------------------------------------

const BUILTIN_RECIPES: Recipe[] = [
  // 1. Creating an invoice
  {
    id: 'create-invoice',
    title: 'Create a split invoice',
    description:
      'Create a new split invoice that divides a payment among multiple recipients on the Stellar network.',
    category: 'invoices',
    tags: ['invoice', 'create', 'split', 'recipients'],
    language: 'typescript',
    author: 'StellarSplit Team',
    code: `import { StellarSplitClient } from '@stellar-split/sdk';

const client = new StellarSplitClient({
  rpcUrl: 'https://soroban-testnet.stellar.org',
  networkPassphrase: 'Test SDF Network ; September 2015',
  contractId: 'YOUR_CONTRACT_ID',
});

const result = await client.createInvoice({
  amount: '100.00',
  asset: 'USDC',
  recipients: [
    { address: 'GDEST1...', share: 60 },
    { address: 'GDEST2...', share: 40 },
  ],
  memo: 'Invoice #1001',
});

console.log('Invoice created:', result.invoiceId);`,
  },

  // 2. Splitting a payment
  {
    id: 'split-payment',
    title: 'Split a payment across recipients',
    description:
      'Pay an existing invoice and distribute funds proportionally to all listed recipients in one transaction.',
    category: 'payments',
    tags: ['payment', 'split', 'pay', 'invoice'],
    language: 'typescript',
    author: 'StellarSplit Team',
    code: `import { StellarSplitClient } from '@stellar-split/sdk';

const client = new StellarSplitClient({ /* config */ });

// Pay invoice — the SDK splits the amount per the invoice's recipient shares
const receipt = await client.pay({
  invoiceId: 'inv_abc123',
  payerKeypair: payerKeypair,
});

console.log('Transaction hash:', receipt.txHash);
console.log('Payments made:', receipt.payments.length);`,
  },

  // 3. Multi-sig approval
  {
    id: 'multisig-approval',
    title: 'Multi-signature invoice approval',
    description:
      'Require multiple signers to approve an invoice before it can be paid, using the approval workflow sequencer.',
    category: 'security',
    tags: ['multisig', 'approval', 'signing', 'threshold'],
    language: 'typescript',
    author: 'StellarSplit Team',
    code: `import { StellarSplitClient, ApprovalWorkflowSequencer } from '@stellar-split/sdk';

const client = new StellarSplitClient({ /* config */ });

const sequencer = new ApprovalWorkflowSequencer({
  requiredSigners: ['GPUB1...', 'GPUB2...', 'GPUB3...'],
  threshold: 2, // 2-of-3 signatures required
  timeoutMs: 3600_000, // 1-hour window
  notificationAdapter: {
    notify: async (signer, session) => {
      console.log(\`Requesting signature from \${signer}\`);
    },
  },
  signatureApplier: {
    apply: async (xdr, keypair) => keypair.sign(xdr),
  },
});

const session = await sequencer.start({ invoiceId: 'inv_abc123' });
console.log('Approval session started:', session.id);`,
  },

  // 4. Using the recommendation engine / smart grouping
  {
    id: 'smart-grouping',
    title: 'Group invoices by pattern with smart grouping',
    description:
      'Use the smart grouping utility to cluster invoices by detected patterns, useful for dashboard analytics.',
    category: 'analytics',
    tags: ['grouping', 'analytics', 'cluster', 'recommendation'],
    language: 'typescript',
    author: 'StellarSplit Team',
    code: `import { groupInvoicesByPattern } from '@stellar-split/sdk';

// invoices: Invoice[] loaded from your data source
const clusters = groupInvoicesByPattern(invoices, {
  windowDays: 30,
  minClusterSize: 2,
});

for (const cluster of clusters) {
  console.log(\`Cluster "\${cluster.label}": \${cluster.invoiceIds.length} invoices\`);
  console.log('  Total:', cluster.totalAmount, cluster.asset);
}`,
  },

  // 5. Webhook setup
  {
    id: 'webhook-setup',
    title: 'Verify an incoming webhook signature',
    description:
      'Validate the HMAC-SHA256 signature on a webhook payload to ensure it originated from StellarSplit.',
    category: 'webhooks',
    tags: ['webhook', 'signature', 'security', 'hmac'],
    language: 'typescript',
    author: 'StellarSplit Team',
    code: `import { validateWebhookSignaturePayload } from '@stellar-split/sdk';

// In your Express / Fastify / etc. route handler:
async function handleWebhook(req: Request, res: Response) {
  const rawBody = await readRawBody(req);
  const signature = req.headers['x-stellarsplit-signature'] as string;

  const result = validateWebhookSignaturePayload({
    payload: rawBody,
    signature,
    secret: process.env.WEBHOOK_SECRET!,
  });

  if (!result.valid) {
    return res.status(401).json({ error: 'Invalid signature' });
  }

  const event = JSON.parse(rawBody.toString());
  console.log('Received event:', event.type);
  res.status(200).json({ received: true });
}`,
  },

  // 6. Fee estimation
  {
    id: 'fee-estimation',
    title: 'Estimate transaction fee before submitting',
    description:
      'Use the fee estimator to calculate the expected Stellar network fee for a given payment amount.',
    category: 'fees',
    tags: ['fee', 'estimate', 'cost', 'stroops'],
    language: 'typescript',
    author: 'StellarSplit Team',
    code: `import { estimateFeeForAmount, formatAmount } from '@stellar-split/sdk';

const estimate = await estimateFeeForAmount({
  amount: '250.00',
  asset: 'USDC',
  recipientCount: 3,
  networkCongestion: 'medium', // 'low' | 'medium' | 'high'
});

console.log('Base fee (stroops):', estimate.baseFee);
console.log('Surge fee (stroops):', estimate.surgeFee);
console.log('Total fee:', formatAmount(String(estimate.totalFee), 'XLM'), 'XLM');
console.log('Estimated ledgers:', estimate.estimatedLedgers);`,
  },
];
