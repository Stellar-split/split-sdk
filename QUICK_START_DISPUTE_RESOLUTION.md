# Quick Start: Dispute Resolution Flow

Get the dispute resolution interface running in your app in under 5 minutes.

---

## Installation

```bash
npm install @stellar-split/sdk react react-dom
```

---

## Basic Setup

### 1. Import Components

```typescript
import { InvoiceDetailPage } from '@stellar-split/sdk/ui';
import { StellarSplitClient } from '@stellar-split/sdk';
```

### 2. Initialize SDK Client

```typescript
const client = new StellarSplitClient({
  rpcUrl: 'https://soroban-testnet.stellar.org',
  networkPassphrase: 'Test SDF Network ; September 2015',
  contractId: 'YOUR_CONTRACT_ID',
});
```

### 3. Setup IPFS Integration

```typescript
import { create } from 'ipfs-http-client';

const ipfs = create({ url: 'https://ipfs.infura.io:5001' });

const handleIPFSUpload = async (file: File): Promise<string> => {
  const result = await ipfs.add(file);
  return result.path; // Returns CID
};
```

### 4. Render Component

```typescript
function MyInvoicePage() {
  const userAddress = "GABC...XYZ"; // From wallet connection
  
  return (
    <InvoiceDetailPage
      invoiceId="123"
      client={client}
      userAddress={userAddress}
      uploadToIPFS={handleIPFSUpload}
    />
  );
}
```

---

## Styling

### Option 1: Use Default Styles

```typescript
import '@stellar-split/sdk/ui/styles/dispute.css';
```

### Option 2: Custom Styles

Override CSS variables:

```css
:root {
  --dispute-warning-color: #f59e0b;
  --dispute-success-color: #10b981;
  --dispute-danger-color: #ef4444;
}
```

Or provide custom classes:

```typescript
<InvoiceDetailPage
  className="my-custom-invoice-page"
  // ... other props
/>
```

---

## Features Overview

### ✅ What You Get Out of the Box

1. **Real-time Updates**
   - Automatic polling every 5 seconds
   - SSE support (when available)
   - Manual refresh capability

2. **Dispute Panel** (appears only when disputed)
   - Dispute information (reason, timestamp, arbitrator)
   - Evidence upload to IPFS
   - Arbitrator voting (approve/reject)
   - Real-time resolution display

3. **Timeline**
   - Chronological event history
   - Evidence CIDs with metadata
   - Vote tracking
   - Transaction hashes

4. **Security**
   - Wallet-based arbitrator verification
   - File validation (10MB max)
   - Transaction signing with user wallet

---

## Advanced Configuration

### Custom Polling Interval

```typescript
import { useInvoiceStream } from '@stellar-split/sdk/ui';

const { invoice, disputeStatus } = useInvoiceStream({
  invoiceId: '123',
  client,
  pollingInterval: 10000, // 10 seconds
  onDisputeUpdate: (status) => {
    console.log('Dispute updated:', status);
  },
});
```

### Handle Timeline Events

```typescript
<InvoiceDetailPage
  invoiceId="123"
  client={client}
  userAddress={userAddress}
  uploadToIPFS={handleIPFSUpload}
  // Custom handlers
  onVote={async (approve) => {
    console.log('Vote cast:', approve);
    // Analytics, notifications, etc.
  }}
  onEvidenceUploaded={(cid) => {
    console.log('Evidence CID:', cid);
    // Track evidence submissions
  }}
/>
```

---

## Common Use Cases

### 1. Read-Only View (No User Interaction)

```typescript
<InvoiceDetailPage
  invoiceId="123"
  client={client}
  // No userAddress = read-only mode
  uploadToIPFS={async () => ''}
/>
```

### 2. Arbitrator Dashboard

```typescript
<InvoiceDetailPage
  invoiceId="123"
  client={client}
  userAddress={arbitratorAddress}
  uploadToIPFS={handleIPFSUpload}
/>
```

### 3. Participant View (Can Upload Evidence)

```typescript
<InvoiceDetailPage
  invoiceId="123"
  client={client}
  userAddress={participantAddress}
  uploadToIPFS={handleIPFSUpload}
/>
```

---

## Wallet Integration Examples

### With Freighter

```typescript
import { connectWallet } from '@stellar-split/sdk';

const userAddress = await connectWallet();

<InvoiceDetailPage
  invoiceId="123"
  client={client}
  userAddress={userAddress}
  uploadToIPFS={handleIPFSUpload}
/>
```

### With WalletConnect

```typescript
const client = new StellarSplitClient({
  rpcUrl: 'https://soroban-testnet.stellar.org',
  networkPassphrase: 'Test SDF Network ; September 2015',
  contractId: 'YOUR_CONTRACT_ID',
  adapter: walletConnectAdapter, // Your WalletConnect adapter
});
```

---

## IPFS Provider Examples

### Infura

```typescript
import { create } from 'ipfs-http-client';

const ipfs = create({
  host: 'ipfs.infura.io',
  port: 5001,
  protocol: 'https',
  headers: {
    authorization: 'Basic ' + btoa(projectId + ':' + projectSecret),
  },
});

const uploadToIPFS = async (file: File) => {
  const result = await ipfs.add(file);
  return result.path;
};
```

### Pinata

```typescript
import { PinataSDK } from '@pinata/sdk';

const pinata = new PinataSDK({ apiKey, apiSecret });

const uploadToIPFS = async (file: File) => {
  const result = await pinata.pinFileToIPFS(file);
  return result.IpfsHash;
};
```

### NFT.Storage

```typescript
import { NFTStorage } from 'nft.storage';

const storage = new NFTStorage({ token: API_TOKEN });

const uploadToIPFS = async (file: File) => {
  const cid = await storage.storeBlob(file);
  return cid;
};
```

---

## Error Handling

### Handle Upload Failures

```typescript
const uploadToIPFS = async (file: File): Promise<string> => {
  try {
    const cid = await ipfsClient.add(file);
    return cid.path;
  } catch (error) {
    console.error('IPFS upload failed:', error);
    throw new Error('Failed to upload to IPFS. Please try again.');
  }
};
```

### Handle Voting Failures

```typescript
const handleVote = async (approve: boolean) => {
  try {
    await client.voteDispute({
      invoiceId,
      arbiter: userAddress,
      approve,
    });
  } catch (error) {
    console.error('Vote failed:', error);
    // Show user-friendly error message
  }
};
```

---

## TypeScript Types

### Component Props

```typescript
interface InvoiceDetailPageProps {
  invoiceId: string;
  client: StellarSplitClient;
  userAddress?: string;
  uploadToIPFS: (file: File) => Promise<string>;
  className?: string;
}
```

### Dispute Status

```typescript
interface DisputeStatus {
  invoiceId: string;
  disputed: boolean;
  arbiter: string;
  resolved: boolean;
  resolution: 'approved' | 'rejected' | null;
  reason?: string;
  openedBy?: string;
  openedAt?: number;
}
```

### Timeline Event

```typescript
interface DisputeTimelineEvent {
  id: string;
  type: 'dispute_opened' | 'evidence_submitted' | 'vote_cast' | 'dispute_resolved';
  timestamp: number;
  actor: string;
  description: string;
  metadata?: {
    evidenceCid?: string;
    vote?: 'approve' | 'reject';
    resolution?: 'approved' | 'rejected';
    txHash?: string;
  };
}
```

---

## Testing

### Mock IPFS Upload

```typescript
const mockUploadToIPFS = async (file: File): Promise<string> => {
  await new Promise(resolve => setTimeout(resolve, 500));
  return 'QmMockCID123ABC';
};
```

### Mock SDK Client

```typescript
import { createMockClient } from '@stellar-split/sdk/testing';

const mockClient = createMockClient({
  getDisputeStatus: async () => ({
    invoiceId: '123',
    disputed: true,
    arbiter: 'GABC...ARBITER',
    resolved: false,
    resolution: null,
  }),
});
```

---

## Performance Tips

1. **Lazy Load Component**
   ```typescript
   const InvoiceDetailPage = lazy(() => import('@stellar-split/sdk/ui'));
   ```

2. **Memoize Upload Handler**
   ```typescript
   const uploadToIPFS = useCallback(async (file: File) => {
     return await ipfs.add(file);
   }, [ipfs]);
   ```

3. **Debounce Polling**
   ```typescript
   pollingInterval: 10000 // Increase for less frequent updates
   ```

---

## Troubleshooting

### "Dispute panel not showing"
- ✅ Check invoice status is disputed
- ✅ Verify `disputeStatus` is being fetched
- ✅ Check browser console for errors

### "Vote buttons not appearing"
- ✅ Ensure `userAddress` is provided
- ✅ Verify user is the assigned arbitrator
- ✅ Check dispute is not already resolved

### "Evidence upload failing"
- ✅ Check file size (< 10MB)
- ✅ Verify IPFS service is reachable
- ✅ Check API credentials
- ✅ Review browser console for CORS errors

### "Real-time updates not working"
- ✅ Check polling is enabled
- ✅ Verify client is properly initialized
- ✅ Check network connectivity
- ✅ Look for errors in useInvoiceStream hook

---

## Next Steps

1. **Customize Styling**: Override CSS variables or provide custom classes
2. **Add Notifications**: Hook into `onDisputeUpdate` for push notifications
3. **Extend Timeline**: Add custom event types for your use case
4. **Integrate Analytics**: Track dispute metrics and user behavior

---

## Resources

- 📖 [Full Implementation Guide](./DISPUTE_RESOLUTION_IMPLEMENTATION.md)
- 📋 [Verification Checklist](./VERIFICATION_CHECKLIST.md)
- 📊 [Implementation Summary](./IMPLEMENTATION_SUMMARY.md)
- 🧪 [Test Examples](./test/ui/)
- 🎨 [Style Guide](./src/ui/styles/dispute.css)

---

## Support

- **Documentation**: `docs/API.md`
- **Examples**: `examples/`
- **Issues**: GitHub Issues
- **Discord**: StellarSplit Community

---

**That's it!** You now have a fully functional dispute resolution interface. 🎉

Start with the basic setup and gradually customize as needed. The component handles all the complex state management, real-time updates, and security checks automatically.
