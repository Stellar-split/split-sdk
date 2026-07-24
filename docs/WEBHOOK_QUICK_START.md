# Webhook Middleware - Quick Start Guide

## 5-Minute Setup

### 1. Install Dependencies
```bash
npm install @stellar-split/sdk
npm install --save-dev @types/express  # If using TypeScript
```

### 2. Basic Express Setup
```typescript
import express from 'express';
import { createWebhookMiddleware } from '@stellar-split/sdk';

const app = express();

// IMPORTANT: Use raw body parser for webhook route
app.use('/webhooks/stellarsplit', express.raw({ type: 'application/json' }));

// Apply webhook middleware
app.post(
  '/webhooks/stellarsplit',
  createWebhookMiddleware(process.env.WEBHOOK_SECRET!),
  (req, res) => {
    const { event, data } = req.webhookPayload;
    console.log(`Received ${event}:`, data);
    res.status(200).json({ received: true });
  }
);

app.listen(3000);
```

### 3. Set Environment Variable
```bash
export WEBHOOK_SECRET="your_secret_key_here"
```

### 4. Test It
```bash
# Run the example
node webhook-server.js

# Send test webhook (in another terminal)
curl -X POST http://localhost:3000/webhooks/stellarsplit \
  -H "Content-Type: application/json" \
  -H "x-stellarsplit-signature: <signature>" \
  -H "x-stellarsplit-timestamp: <timestamp>" \
  -H "x-stellarsplit-nonce: <nonce>" \
  -d '{"event":"invoice.paid","timestamp":1721318400,"nonce":"test","data":{}}'
```

---

## Common Use Cases

### Handle Different Event Types
```typescript
app.post('/webhooks/stellarsplit', middleware, (req, res) => {
  const { event, data } = req.webhookPayload;
  
  switch (event) {
    case 'invoice.created':
      await handleInvoiceCreated(data);
      break;
    case 'invoice.paid':
      await handleInvoicePaid(data);
      break;
    case 'invoice.released':
      await handleInvoiceReleased(data);
      break;
    default:
      console.warn(`Unknown event: ${event}`);
  }
  
  res.status(200).json({ received: true });
});
```

### Custom Configuration
```typescript
const middleware = createWebhookMiddleware(secret, {
  toleranceSeconds: 600,     // 10 minutes (for slower networks)
  nonceWindowSize: 5000,     // Track 5000 nonces (high volume)
});
```

### Next.js API Route
```typescript
// pages/api/webhooks/stellarsplit.ts
import { createWebhookMiddleware } from '@stellar-split/sdk';

export const config = {
  api: { bodyParser: false },  // Disable body parser
};

const middleware = createWebhookMiddleware(process.env.WEBHOOK_SECRET!);

export default async function handler(req, res) {
  // Read raw body
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.from(chunk));
  }
  req.body = Buffer.concat(chunks);

  // Apply middleware
  await new Promise((resolve, reject) => {
    middleware(req, res, (result) => {
      if (result instanceof Error) reject(result);
      else resolve(result);
    });
  });

  // Process webhook
  const { event, data } = req.webhookPayload;
  res.status(200).json({ received: true });
}
```

### Error Handling
```typescript
app.post('/webhooks/stellarsplit', middleware, (req, res) => {
  try {
    const { event, data } = req.webhookPayload;
    // Process webhook
    res.status(200).json({ received: true });
  } catch (error) {
    console.error('Webhook processing error:', error);
    res.status(200).json({ received: true });  // Still acknowledge
  }
});

// Global error handler
app.use((err, req, res, next) => {
  if (err.name === 'WebhookValidationError') {
    console.error('Webhook validation failed:', err.message);
  }
  next(err);
});
```

---

## Configuration Reference

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `toleranceSeconds` | number | 300 | Max clock drift (seconds) |
| `nonceWindowSize` | number | 1000 | LRU cache size |
| `signatureHeader` | string | "x-stellarsplit-signature" | Signature header name |
| `timestampHeader` | string | "x-stellarsplit-timestamp" | Timestamp header name |
| `nonceHeader` | string | "x-stellarsplit-nonce" | Nonce header name |

---

## Event Types

| Event | Description | Data Type |
|-------|-------------|-----------|
| `invoice.created` | New invoice created | `InvoiceCreatedData` |
| `invoice.paid` | Payment received | `InvoicePaidData` |
| `invoice.released` | Funds distributed | `InvoiceReleasedData` |
| `invoice.failed` | Invoice failed | `InvoiceFailedData` |
| `invoice.refunded` | Funds refunded | `InvoiceRefundedData` |
| `invoice.cancelled` | Invoice cancelled | `InvoiceCancelledData` |
| `invoice.expired` | Deadline passed | `InvoiceExpiredData` |

---

## Error Types

| Error | Status | Cause |
|-------|--------|-------|
| `MissingHeaderError` | 400 | Required header missing |
| `InvalidSignatureError` | 400 | Signature verification failed |
| `TimestampOutOfBoundsError` | 400 | Timestamp outside tolerance |
| `ReplayAttackError` | 400 | Duplicate nonce (replay) |
| `InvalidPayloadError` | 400 | Malformed payload |

---

## Testing

### Generate Test Signature
```typescript
import { generateWebhookSignature } from '@stellar-split/sdk';

const payload = {
  event: 'invoice.paid',
  timestamp: Math.floor(Date.now() / 1000),
  nonce: crypto.randomUUID(),
  data: { invoiceId: '123', amount: '1000' },
};

const signature = await generateWebhookSignature(payload, secret);
console.log('Signature:', signature);
```

### Send Test Webhook
```typescript
const response = await fetch('http://localhost:3000/webhooks/stellarsplit', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'x-stellarsplit-signature': signature,
    'x-stellarsplit-timestamp': String(payload.timestamp),
    'x-stellarsplit-nonce': payload.nonce,
  },
  body: JSON.stringify(payload),
});

console.log('Status:', response.status);
console.log('Response:', await response.json());
```

### Verify Signature Manually
```typescript
import { verifyWebhookSignature } from '@stellar-split/sdk';

const isValid = await verifyWebhookSignature(
  rawBody,
  req.headers['x-stellarsplit-signature'],
  secret
);

console.log('Valid:', isValid);
```

---

## Best Practices

### ✅ DO

- Use environment variables for secrets
- Use raw body parser for webhook routes
- Acknowledge webhooks immediately (200 OK)
- Process webhooks asynchronously
- Implement idempotency checks
- Log validation failures
- Monitor replay attack attempts
- Use HTTPS in production

### ❌ DON'T

- Hardcode secrets in code
- Use JSON parser before middleware
- Block webhook response with long processing
- Retry webhooks on validation failure
- Log sensitive data (secrets, full payloads)
- Expose validation errors to attackers

---

## Troubleshooting

### "Invalid webhook signature"
**Solution**: Verify secret matches, use raw body parser

### "Timestamp outside tolerance window"
**Solution**: Increase `toleranceSeconds`, sync server clocks

### "Nonce has already been used"
**Solution**: Expected for replays. Increase `nonceWindowSize` if needed

### "Missing required header"
**Solution**: Check header names match configuration

---

## Production Checklist

- [ ] Set `WEBHOOK_SECRET` environment variable
- [ ] Use HTTPS (TLS 1.2+)
- [ ] Configure rate limiting
- [ ] Set up monitoring/alerting
- [ ] Test with sample webhooks
- [ ] Implement error logging
- [ ] Document webhook URL
- [ ] Configure firewall rules
- [ ] Test replay attack prevention
- [ ] Verify signature generation

---

## Need Help?

- **Documentation**: See `docs/WEBHOOK_MIDDLEWARE.md`
- **Examples**: See `examples/webhook-middleware-example.ts`
- **Tests**: See `test/webhookMiddleware.test.ts`
- **Issues**: https://github.com/stellar-split/split-sdk/issues

---

## Quick API Reference

```typescript
// Main function
createWebhookMiddleware(secret: string, options?: WebhookOptions): RequestHandler

// Utilities
generateWebhookSignature(payload: WebhookPayload, secret: string): Promise<string>
verifyWebhookSignature(payload: string | WebhookPayload, signature: string, secret: string): Promise<boolean>
parseWebhookPayload<T>(rawPayload: string): WebhookPayload<T>

// Type guards
isValidEventType(event: string): event is InvoiceEventType
isWebhookRequest(req: Request): req is WebhookRequest

// Types
interface WebhookOptions { toleranceSeconds?, nonceWindowSize?, ... }
interface WebhookPayload<T> { event, timestamp, nonce, data: T }
interface WebhookRequest extends Request { webhookPayload, rawWebhookBody }

// Errors
class InvalidSignatureError extends WebhookValidationError
class TimestampOutOfBoundsError extends WebhookValidationError
class ReplayAttackError extends WebhookValidationError
class MissingHeaderError extends WebhookValidationError
class InvalidPayloadError extends WebhookValidationError
```

---

**That's it!** You're now ready to receive secure StellarSplit webhooks. 🎉

For complete documentation, see: `docs/WEBHOOK_MIDDLEWARE.md`
