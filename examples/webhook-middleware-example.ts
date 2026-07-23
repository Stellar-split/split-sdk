/**
 * Complete example of implementing StellarSplit webhook receiver
 * with secure signature verification and replay attack prevention.
 * 
 * This example demonstrates:
 * - Express.js integration
 * - Signature verification
 * - Event handling
 * - Error handling
 * - Testing utilities
 */

import express, { Request, Response, NextFunction } from "express";
import {
  createWebhookMiddleware,
  generateWebhookSignature,
  type WebhookRequest,
  type InvoicePaidData,
  type InvoiceReleasedData,
  type InvoiceCreatedData,
  WebhookValidationError,
} from "@stellar-split/sdk";

// ============================================================================
// Configuration
// ============================================================================

const WEBHOOK_SECRET = process.env.STELLARSPLIT_WEBHOOK_SECRET || "your_webhook_secret_here";
const PORT = process.env.PORT || 3000;

if (!process.env.STELLARSPLIT_WEBHOOK_SECRET) {
  console.warn("⚠️  STELLARSPLIT_WEBHOOK_SECRET not set, using default (NOT FOR PRODUCTION)");
}

// ============================================================================
// Express App Setup
// ============================================================================

const app = express();

// IMPORTANT: Use express.raw() for webhook route to preserve raw body
// This is required for signature verification
app.use("/webhooks/stellarsplit", express.raw({ type: "application/json" }));

// Use JSON parser for other routes
app.use(express.json());

// ============================================================================
// Webhook Handlers
// ============================================================================

async function handleInvoiceCreated(data: InvoiceCreatedData) {
  console.log("📝 Invoice created:", {
    invoiceId: data.invoiceId,
    creator: data.creator,
    totalAmount: data.totalAmount,
    recipientCount: data.recipients.length,
  });

  // Example: Store invoice in database
  // await db.invoices.create({
  //   id: data.invoiceId,
  //   creator: data.creator,
  //   totalAmount: data.totalAmount,
  //   status: 'pending',
  // });
}

async function handleInvoicePaid(data: InvoicePaidData) {
  console.log("💰 Payment received:", {
    invoiceId: data.invoiceId,
    payer: data.payer,
    amount: data.amount,
    funded: data.funded,
    remaining: data.remaining,
    txHash: data.txHash,
  });

  // Example: Update invoice funding status
  // await db.invoices.update(data.invoiceId, {
  //   funded: data.funded,
  //   lastPayment: {
  //     payer: data.payer,
  //     amount: data.amount,
  //     txHash: data.txHash,
  //     timestamp: Date.now(),
  //   },
  // });

  // Example: Send notification to invoice creator
  // await sendNotification(data.invoiceId, {
  //   type: 'payment_received',
  //   amount: data.amount,
  //   payer: data.payer,
  // });
}

async function handleInvoiceReleased(data: InvoiceReleasedData) {
  console.log("✅ Invoice released:", {
    invoiceId: data.invoiceId,
    totalAmount: data.totalAmount,
    recipientCount: data.recipients.length,
    releasedAt: new Date(data.releasedAt * 1000).toISOString(),
  });

  // Example: Update invoice status and record distributions
  // await db.invoices.update(data.invoiceId, {
  //   status: 'released',
  //   releasedAt: data.releasedAt,
  // });

  // for (const recipient of data.recipients) {
  //   await db.distributions.create({
  //     invoiceId: data.invoiceId,
  //     recipient: recipient.address,
  //     amount: recipient.amount,
  //     txHash: recipient.txHash,
  //   });
  // }

  // Example: Send notifications to all recipients
  // await sendBulkNotifications(data.recipients, {
  //   type: 'funds_released',
  //   invoiceId: data.invoiceId,
  // });
}

async function handleInvoiceFailed(data: any) {
  console.log("❌ Invoice failed:", data);
}

async function handleInvoiceRefunded(data: any) {
  console.log("🔙 Invoice refunded:", data);
}

async function handleInvoiceCancelled(data: any) {
  console.log("🚫 Invoice cancelled:", data);
}

async function handleInvoiceExpired(data: any) {
  console.log("⏰ Invoice expired:", data);
}

// ============================================================================
// Webhook Endpoint
// ============================================================================

app.post(
  "/webhooks/stellarsplit",
  createWebhookMiddleware(WEBHOOK_SECRET, {
    toleranceSeconds: 300,    // 5 minutes
    nonceWindowSize: 1000,     // Track 1000 recent nonces
  }),
  async (req: Request, res: Response) => {
    // At this point, the webhook has been verified and is safe to process
    const webhookReq = req as WebhookRequest;
    const { event, data, timestamp, nonce } = webhookReq.webhookPayload;

    console.log(`\n📨 Webhook received: ${event}`);
    console.log(`   Timestamp: ${new Date(timestamp * 1000).toISOString()}`);
    console.log(`   Nonce: ${nonce.substring(0, 20)}...`);

    try {
      // Route to appropriate handler based on event type
      switch (event) {
        case "invoice.created":
          await handleInvoiceCreated(data as InvoiceCreatedData);
          break;
        case "invoice.paid":
          await handleInvoicePaid(data as InvoicePaidData);
          break;
        case "invoice.released":
          await handleInvoiceReleased(data as InvoiceReleasedData);
          break;
        case "invoice.failed":
          await handleInvoiceFailed(data);
          break;
        case "invoice.refunded":
          await handleInvoiceRefunded(data);
          break;
        case "invoice.cancelled":
          await handleInvoiceCancelled(data);
          break;
        case "invoice.expired":
          await handleInvoiceExpired(data);
          break;
        default:
          console.warn(`⚠️  Unknown event type: ${event}`);
      }

      // Always acknowledge receipt immediately
      res.status(200).json({
        received: true,
        event,
        processedAt: new Date().toISOString(),
      });
    } catch (error) {
      console.error("Error processing webhook:", error);
      
      // Still acknowledge receipt to prevent retries
      // Log error for investigation
      res.status(200).json({
        received: true,
        error: "Processing error logged",
      });
    }
  }
);

// ============================================================================
// Error Handling
// ============================================================================

app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
  if (err instanceof WebhookValidationError) {
    console.error(`🔒 Webhook validation failed: ${err.name}`, {
      message: err.message,
      code: err.code,
    });

    // Don't leak sensitive information in production
    return res.status(400).json({
      error: err.name,
      message: process.env.NODE_ENV === "production" 
        ? "Webhook validation failed" 
        : err.message,
    });
  }

  console.error("Unexpected error:", err);
  res.status(500).json({ error: "Internal server error" });
});

// ============================================================================
// Health Check Endpoint
// ============================================================================

app.get("/health", (req, res) => {
  res.status(200).json({
    status: "ok",
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  });
});

// ============================================================================
// Test Endpoint (Development Only)
// ============================================================================

if (process.env.NODE_ENV !== "production") {
  app.post("/test/send-webhook", async (req, res) => {
    const { event, data } = req.body;

    const payload = {
      event: event || "invoice.paid",
      timestamp: Math.floor(Date.now() / 1000),
      nonce: `test_${Date.now()}_${Math.random().toString(36).substring(7)}`,
      data: data || {
        invoiceId: "test_123",
        payer: "GABC...XYZ",
        amount: "1000000000",
        funded: "1000000000",
        remaining: "0",
        txHash: "abc123...",
      },
    };

    const signature = await generateWebhookSignature(payload, WEBHOOK_SECRET);

    // Simulate webhook delivery to own endpoint
    const response = await fetch(`http://localhost:${PORT}/webhooks/stellarsplit`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-stellarsplit-signature": signature,
        "x-stellarsplit-timestamp": String(payload.timestamp),
        "x-stellarsplit-nonce": payload.nonce,
      },
      body: JSON.stringify(payload),
    });

    res.status(200).json({
      sent: true,
      payload,
      signature,
      response: {
        status: response.status,
        body: await response.json(),
      },
    });
  });

  console.log("\n⚠️  Test endpoint enabled at POST /test/send-webhook");
}

// ============================================================================
// Start Server
// ============================================================================

app.listen(PORT, () => {
  console.log(`\n🚀 StellarSplit webhook receiver running on port ${PORT}`);
  console.log(`   Webhook URL: http://localhost:${PORT}/webhooks/stellarsplit`);
  console.log(`   Health check: http://localhost:${PORT}/health`);
  console.log(`   Environment: ${process.env.NODE_ENV || "development"}`);
  console.log("\n✅ Ready to receive webhooks\n");
});

// ============================================================================
// Graceful Shutdown
// ============================================================================

process.on("SIGTERM", () => {
  console.log("\n⚠️  SIGTERM received, shutting down gracefully...");
  process.exit(0);
});

process.on("SIGINT", () => {
  console.log("\n⚠️  SIGINT received, shutting down gracefully...");
  process.exit(0);
});

// ============================================================================
// Example: Testing Signature Generation
// ============================================================================

async function testSignatureGeneration() {
  const testPayload = {
    event: "invoice.paid" as const,
    timestamp: Math.floor(Date.now() / 1000),
    nonce: "test_nonce_12345",
    data: {
      invoiceId: "inv_123",
      payer: "GABC123...",
      amount: "1000000000",
      funded: "1000000000",
      remaining: "0",
      txHash: "tx_hash_123",
    },
  };

  const signature = await generateWebhookSignature(testPayload, WEBHOOK_SECRET);

  console.log("\n🧪 Test Signature Generation:");
  console.log("   Payload:", JSON.stringify(testPayload, null, 2));
  console.log("   Signature:", signature);
  console.log("   Length:", signature.length, "chars (should be 64)");
  console.log("\n   Example cURL command:");
  console.log(`
curl -X POST http://localhost:${PORT}/webhooks/stellarsplit \\
  -H "Content-Type: application/json" \\
  -H "x-stellarsplit-signature: ${signature}" \\
  -H "x-stellarsplit-timestamp: ${testPayload.timestamp}" \\
  -H "x-stellarsplit-nonce: ${testPayload.nonce}" \\
  -d '${JSON.stringify(testPayload)}'
  `);
}

// Run test signature generation in development
if (process.env.NODE_ENV !== "production") {
  testSignatureGeneration().catch(console.error);
}

export default app;
