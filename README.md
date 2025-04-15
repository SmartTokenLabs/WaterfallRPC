# Waterfall RPC

A universal RPC provider with waterfall fallback mechanism for Ethereum networks. This library automatically fetches and manages RPC endpoints from Chainlist, providing a reliable way to interact with various Ethereum networks.

## Features

- Automatically fetches and caches RPC endpoints from Chainlist
- Implements a waterfall fallback mechanism for reliable RPC access
- Supports all Ethereum networks listed on Chainlist
- Automatic RPC endpoint health checking
- Weekly automatic updates of RPC endpoints

## Installation

```bash
npm install waterfall-rpc
```

## Usage

```typescript
import { WaterfallRpc } from 'waterfall-rpc';

// Create a provider for Base Sepolia
const provider = await WaterfallRpc.create(84532);

// Use the provider with ethers.js
const blockNumber = await provider.getBlockNumber();
console.log(`Current block number: ${blockNumber}`);
```

## API Documentation

### WaterfallRpc

The main class that provides a reliable RPC connection with fallback support.

#### Static Methods

- `create(chainId: number): Promise<WaterfallRpc>`
  - Creates a new provider instance for the specified chain ID
  - Automatically checks and filters working RPC endpoints

#### Instance Methods

- All standard ethers.js provider methods are available
- The provider automatically handles RPC failures and retries with different endpoints

## License

ISC
