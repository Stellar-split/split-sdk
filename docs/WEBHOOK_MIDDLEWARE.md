# Webhook Middleware Guide

## Overview

The StellarSplit SDK provides a secure, production-ready webhook middleware for receiving and verifying incoming invoice webhooks. The middleware implements industry-standard security practices including HMAC-SHA256 signature verification, replay attack prevention, and timing attack mitigation.

## Features

- ✅ **HMAC-SHA256 Signature Verification**: Cryptographic verification using constant-time comparison
- ✅ **Replay Attack Prevention**: Nonce-based deduplication with configurable LRU cache
- ✅ **Timestamp Validation**: Configurable tolerance window to prevent old requests
- ✅ **Express/Next.js Compatible**: Standard middleware interface for Node.js frameworks
- ✅ **TypeScript Support**: Fully typed with comprehensive type definitions
- ✅ **Secure by Default**: Follows OWASP best practices for webhook security

## Installation

```bash
npm install @stellar-split/sdk
```

## Quick Start

### Express.js

```typescript
import express from 'express';
import { createWebhookMiddleware } from '@stellar-split/sdk';

const app = express();

// IMPORTANT: Use express.raw() to preserve the raw body for signature verification
app.use('/webhooks/stellarsplit', express.raw({ type: 'application/json' }));

// Apply webhook middleware with your secret key
app.post(
  '/webhooks/stellarsplit',
  createWebhookMiddleware(process.env.STELLARSPLIT_WEBHOOK_SECRET!, {
    toleranceSeconds: 300,      // 5 minutes
    nonceWindowSize: 1000,       // Track 1000 recent nonces
  }),
  (req, res) => {
    // Webhook has been verified - safe to process
    const { event, data } = req.webhookPayload;
    
    console.log(`Received ${event} webhook:`, data);
    
    // Process the webhook based on event type
    switch (event) {
      case 'invoice.created':
        handleInvoiceCreated(data);
        break;
      case 'invoice.paid':
        handleInvoicePaid(data);
        break;
      case 'invoice.released':
        handleInvoiceReleased(data);
        break;
      case 'invoice.failed':
        handleInvoiceFailed(data);
        break;
      case 'invoice.refunded':
        handleInvoiceRefunded(data);
        break;
      case 'invoice.cancelled':
        handleInvoiceCancelled(data);
        break;
      case 'invoice.expired':
        handleInvoiceExpired(data);
        break;
    }
    
    res.status(200).json({ received: true });
  }
);

app.listen(3000);
```

### Next.js (API Routes)

```typescript
// pages/api/webhooks/stellarsplit.ts
import type { NextApiRequest, NextApiResponse } from 'next';
import { createWebhookMiddleware, type WebhookRequest } from '@stellar-split/sdk';

const webhookMiddleware = createWebhookMiddleware(
  process.env.STELLARSPLIT_WEBHOOK_SECRET!,
  { toleranceSeconds: 300 }
);

// Disable body parsing to preserve raw body
export const config = {
  api: {
    bodyParser: false,
  },
};

// Helper to convert Next.js API handler to Express-style
function runMiddleware(req: NextApiRequest, res: NextApiResponse, fn: Function) {
  return new Promise((resolve, reject) => {
    fn(req, res, (result: any) => {
      if (result instanceof Error) {
        return reject(result);
      }
      return resolve(result);
    });
  });
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // Read raw body
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    }
    req.body = Buffer.concat(chunks);

    // Run webhook verification middleware
    await runMiddleware(req, res, webhookMiddleware);

    // Access verified webhook payload
    const { event, data } = (req as WebhookRequest).webhookPayload;

    // Process webhook
    console.log(`Received ${event}:`, data);

    res.status(200).json({ received: true });
  } catch (error) {
    console.error('Webhook error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}
```

## Configuration Options

```typescript
interface WebhookOptions {
  /**
   * Maximum allowed clock drift for timestamp validation in seconds.
   * Requests with timestamps outside this window will be rejected.
   * @default 300 (5 minutes)
   */
  toleranceSeconds?: number;

  /**
   * Maximum size for the in-memory LRU cache that tracks seen nonces.
   * This prevents replay attacks by remembering recently used nonces.
   * @default 1000
   */
  nonceWindowSize?: number;

  /**
   * Header name containing the HMAC signature.
   * @default "x-stellarsplit-signature"
   */
  signatureHeader?: string;

  /**
   * Header name containing the timestamp.
   * @default "x-stellarsplit-timestamp"
   */
  timestampHeader?: string;

  /**
   * Header name containing the unique nonce.
   * @default "x-stellarsplit-nonce"
   */
  nonceHeader?: string;
}
```

## Webhook Event Types

The middleware validates and processes the following event types:

| Event Type | Description | Data Type |
|------------|-------------|-----------|
| `invoice.created` | New invoice created | `InvoiceCreatedData` |
| `invoice.paid` | Payment received toward invoice | `InvoicePaidData` |
| `invoice.released` | Invoice funds released to recipients | `InvoiceReleasedData` |
| `invoice.failed` | Invoice failed to meet conditions | `InvoiceFailedData` |
| `invoice.refunded` | Invoice refunded to payers | `InvoiceRefundedData` |
| `invoice.cancelled` | Invoice cancelled by creator | `InvoiceCancelledData` |
| `invoice.expired` | Invoice deadline expired | `InvoiceExpiredData` |

### Event Data Types

```typescript
interface InvoiceCreatedData {
  invoiceId: string;
  creator: string;
  recipients: Array<{ address: string; amount: string }>;
  token: string;
  deadline: number;
  totalAmount: string;
}

interface InvoicePaidData {
  invoiceId: string;
  payer: string;
  amount: string;
  funded: string;
  remaining: string;
  txHash: string;
}

interface InvoiceReleasedData {
  invoiceId: string;
  totalAmount: string;
  recipients: Array<{ address: string; amount: string; txHash: string }>;
  releasedAt: number;
}

interface InvoiceFailedData {
  invoiceId: string;
  reason: string;
  failedAt: number;
}

interface InvoiceRefundedData {
  invoiceId: string;
  totalRefunded: string;
  refundedAt: number;
}

interface InvoiceCancelledData {
  invoiceId: string;
  cancelledBy: string;
  cancelledAt: number;
}

interface InvoiceExpiredData {
  invoiceId: string;
  deadline: number;
  expiredAt: number;
}
```

## Security Architecture

### 1. HMAC-SHA256 Signature Verification

Every webhook payload is signed using HMAC-SHA256:

```
signature = HMAC-SHA256(secret, JSON.stringify(payload))
```

The middleware verifies this signature using **constant-time comparison** to prevent timing side-channel attacks.

### 2. Timestamp Validation

Webhooks include a timestamp in the payload and headers. The middleware:

1. Validates the timestamp is within the configured tolerance window (default: 5 minutes)
2. Rejects requests that are too old or too far in the future
3. Prevents replay attacks using old captured requests

### 3. Nonce-Based Replay Protection

Each webhook includes a unique nonce (number used once):

1. The middleware tracks seen nonces in an LRU cache
2. Duplicate nonces are rejected (replay attack detected)
3. Old nonces are automatically evicted when the cache reaches capacity
4. Cache size is configurable (default: 1000 nonces)

### 4. Header Validation

The middleware validates three required headers:

- `x-stellarsplit-signature`: HMAC-SHA256 signature (hex-encoded)
- `x-stellarsplit-timestamp`: Unix timestamp (seconds)
- `x-stellarsplit-nonce`: Unique request identifier

Missing headers result in a `400 Bad Request` response.

## Error Handling

The middleware provides detailed error types for different validation failures:

```typescript
import {
  InvalidSignatureError,
  TimestampOutOfBoundsError,
  ReplayAttackError,
  MissingHeaderError,
  InvalidPayloadError,
  WebhookValidationError,
} from '@stellar-split/sdk';
```

### Error Responses

All validation errors return `400 Bad Request` with a JSON body:

```json
{
  "error": "InvalidSignatureError",
  "message": "Invalid webhook signature",
  "code": "VALIDATION_ERROR"
}
```

Error types:

- **MissingHeaderError**: Required header is missing
- **InvalidSignatureError**: Signature verification failed
- **TimestampOutOfBoundsError**: Timestamp outside tolerance window
- **ReplayAttackError**: Nonce has been seen before (replay detected)
- **InvalidPayloadError**: Payload structure is invalid

## Advanced Usage

### Type Guards

Check if a request has been verified by the webhook middleware:

```typescript
import { isWebhookRequest, type WebhookRequest } from '@stellar-split/sdk';

function handler(req: Request, res: Response) {
  if (isWebhookRequest(req)) {
    // TypeScript knows req is WebhookRequest
    const { event, data } = req.webhookPayload;
    console.log(`Processing ${event}`);
  }
}
```

### Manual Signature Verification

Verify a signature without using the middleware:

```typescript
import { verifyWebhookSignature } from '@stellar-split/sdk';

const isValid = await verifyWebhookSignature(
  rawPayloadString,
  req.headers['x-stellarsplit-signature'],
  process.env.WEBHOOK_SECRET
);

if (!isValid) {
  throw new Error('Invalid signature');
}
```

### Generate Signatures (For Testing)

Generate signatures for testing webhook handlers:

```typescript
import { generateWebhookSignature } from '@stellar-split/sdk';

const payload = {
  event: 'invoice.paid',
  timestamp: Math.floor(Date.now() / 1000),
  nonce: crypto.randomUUID(),
  data: {
    invoiceId: '123',
    payer: 'GABC...',
    amount: '1000000000',
  },
};

const signature = await generateWebhookSignature(payload, secret);

// Use in test request
fetch('http://localhost:3000/webhooks/stellarsplit', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'x-stellarsplit-signature': signature,
    'x-stellarsplit-timestamp': String(payload.timestamp),
    'x-stellarsplit-nonce': payload.nonce,
  },
  body: JSON.stringify(payload),
});
```

### Parse and Validate Payloads

Manually parse and validate webhook payloads:

```typescript
import { parseWebhookPayload } from '@stellar-split/sdk';

try {
  const payload = parseWebhookPayload(rawPayloadString);
  console.log('Valid payload:', payload);
} catch (error) {
  if (error instanceof InvalidPayloadError) {
    console.error('Invalid payload:', error.message);
  }
}
```

## Testing

### Unit Tests

```typescript
import { describe, it, expect } from 'vitest';
import { generateWebhookSignature, verifyWebhookSignature } from '@stellar-split/sdk';

describe('Webhook Signature', () => {
  const secret = 'test_secret';

  it('should generate and verify signatures', async () => {
    const payload = {
      event: 'invoice.paid',
      timestamp: Math.floor(Date.now() / 1000),
      nonce: 'test-nonce',
      data: { invoiceId: '123' },
    };

    const signature = await generateWebhookSignature(payload, secret);
    const isValid = await verifyWebhookSignature(payload, signature, secret);

    expect(isValid).toBe(true);
  });

  it('should reject invalid signatures', async () => {
    const payload = {
      event: 'invoice.paid',
      timestamp: Math.floor(Date.now() / 1000),
      nonce: 'test-nonce',
      data: { invoiceId: '123' },
    };

    const isValid = await verifyWebhookSignature(
      payload,
      'invalid_signature',
      secret
    );

    expect(isValid).toBe(false);
  });
});
```

### Integration Tests

```typescript
import request from 'supertest';
import app from './app';
import { generateWebhookSignature } from '@stellar-split/sdk';

describe('Webhook Endpoint', () => {
  const secret = process.env.WEBHOOK_SECRET!;

  it('should accept valid webhook', async () => {
    const payload = {
      event: 'invoice.paid',
      timestamp: Math.floor(Date.now() / 1000),
      nonce: `test-${Date.now()}`,
      data: {
        invoiceId: '123',
        payer: 'GABC...',
        amount: '1000000000',
      },
    };

    const signature = await generateWebhookSignature(payload, secret);

    const response = await request(app)
      .post('/webhooks/stellarsplit')
      .set('x-stellarsplit-signature', signature)
      .set('x-stellarsplit-timestamp', String(payload.timestamp))
      .set('x-stellarsplit-nonce', payload.nonce)
      .send(payload);

    expect(response.status).toBe(200);
    expect(response.body.received).toBe(true);
  });

  it('should reject webhook with invalid signature', async () => {
    const payload = {
      event: 'invoice.paid',
      timestamp: Math.floor(Date.now() / 1000),
      nonce: `test-${Date.now()}`,
      data: { invoiceId: '123' },
    };

    const response = await request(app)
      .post('/webhooks/stellarsplit')
      .set('x-stellarsplit-signature', 'invalid')
      .set('x-stellarsplit-timestamp', String(payload.timestamp))
      .set('x-stellarsplit-nonce', payload.nonce)
      .send(payload);

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('InvalidSignatureError');
  });

  it('should reject replayed webhook', async () => {
    const payload = {
      event: 'invoice.paid',
      timestamp: Math.floor(Date.now() / 1000),
      nonce: 'same-nonce',
      data: { invoiceId: '123' },
    };

    const signature = await generateWebhookSignature(payload, secret);

    // First request should succeed
    await request(app)
      .post('/webhooks/stellarsplit')
      .set('x-stellarsplit-signature', signature)
      .set('x-stellarsplit-timestamp', String(payload.timestamp))
      .set('x-stellarsplit-nonce', payload.nonce)
      .send(payload);

    // Second request with same nonce should be rejected
    const response = await request(app)
      .post('/webhooks/stellarsplit')
      .set('x-stellarsplit-signature', signature)
      .set('x-stellarsplit-timestamp', String(payload.timestamp))
      .set('x-stellarsplit-nonce', payload.nonce)
      .send(payload);

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('ReplayAttackError');
  });
});
```

## Best Practices

### 1. Secure Secret Management

```typescript
// ❌ DON'T hardcode secrets
const middleware = createWebhookMiddleware('my_secret_key');

// ✅ DO use environment variables
const middleware = createWebhookMiddleware(process.env.WEBHOOK_SECRET!);

// ✅ DO validate secret exists at startup
if (!process.env.WEBHOOK_SECRET) {
  throw new Error('WEBHOOK_SECRET environment variable is required');
}
```

### 2. Use Raw Body Parser

```typescript
// ❌ DON'T use JSON parser for webhook route
app.use(express.json()); // Parses body and loses raw content

// ✅ DO use raw body parser for webhook route
app.use('/webhooks/stellarsplit', express.raw({ type: 'application/json' }));
```

### 3. Process Webhooks Asynchronously

```typescript
app.post('/webhooks/stellarsplit', webhookMiddleware, async (req, res) => {
  // ✅ Acknowledge immediately
  res.status(200).json({ received: true });

  // ✅ Process asynchronously
  setImmediate(async () => {
    try {
      await processWebhook(req.webhookPayload);
    } catch (error) {
      console.error('Webhook processing error:', error);
      // Log error, send to monitoring system, etc.
    }
  });
});
```

### 4. Implement Idempotency

```typescript
const processedWebhooks = new Set<string>();

async function processWebhook(payload: WebhookPayload) {
  // Use nonce as idempotency key
  if (processedWebhooks.has(payload.nonce)) {
    console.log('Webhook already processed:', payload.nonce);
    return;
  }

  // Process webhook
  await handleWebhookEvent(payload);

  // Mark as processed
  processedWebhooks.add(payload.nonce);
}
```

### 5. Monitor and Alert

```typescript
import { WebhookValidationError } from '@stellar-split/sdk';

app.post('/webhooks/stellarsplit', webhookMiddleware, (req, res) => {
  // Success case
  metrics.increment('webhook.received', { event: req.webhookPayload.event });
  res.status(200).json({ received: true });
});

// Error handler
app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
  if (err instanceof WebhookValidationError) {
    metrics.increment('webhook.validation_failed', { error: err.name });
    logger.warn('Webhook validation failed', { error: err.message });
  }
  next(err);
});
```

## Troubleshooting

### Issue: "Invalid webhook signature"

**Cause**: Signature verification failed.

**Solutions**:
1. Verify the webhook secret matches between sender and receiver
2. Ensure raw body is used for signature verification (not parsed JSON)
3. Check for middleware ordering issues (raw parser must come before webhook middleware)

### Issue: "Timestamp outside tolerance window"

**Cause**: Clock drift between sender and receiver.

**Solutions**:
1. Increase `toleranceSeconds` option (default: 300 seconds)
2. Sync server clocks using NTP
3. Check for timezone configuration issues

### Issue: "Nonce has already been used (replay attack detected)"

**Cause**: Duplicate nonce detected.

**Solutions**:
1. This is expected behavior for replay attempts (security feature working correctly)
2. If legitimate, ensure webhook sender generates unique nonces per request
3. Increase `nonceWindowSize` if you have high webhook volume

### Issue: Body parser conflicts

**Cause**: Body already parsed by another middleware.

**Solution**: Use route-specific middleware:

```typescript
// ✅ Apply raw parser only to webhook route
app.use('/webhooks/stellarsplit', express.raw({ type: 'application/json' }));
app.use('/webhooks/stellarsplit', webhookMiddleware);

// ✅ Use JSON parser for other routes
app.use(express.json());
```

## Performance Considerations

### Memory Usage

The LRU cache stores nonces in memory. Memory usage: approximately `50 bytes × nonceWindowSize`

- Default (1000 nonces): ~50 KB
- Large deployment (10,000 nonces): ~500 KB

### Throughput

Signature verification is computationally intensive. Benchmarks:

- ~10,000 verifications/second on modern hardware
- Non-blocking (uses async crypto operations)

For high-throughput scenarios, consider:
1. Horizontal scaling (multiple server instances)
2. Rate limiting on webhook endpoints
3. Queue-based processing

## Related Documentation

- [API Documentation](./API.md)
- [Webhook Replay](./TELEMETRY_HOOKS.md)
- [Security Best Practices](../README.md#security)

## Support

For issues or questions:
- GitHub Issues: https://github.com/stellar-split/split-sdk/issues
- Documentation: https://docs.stellarsplit.io
- Discord: https://discord.gg/stellarsplit
