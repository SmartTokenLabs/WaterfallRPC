# Waterfall RPC

A universal RPC provider with waterfall fallback mechanism for Ethereum networks. This library automatically fetches and manages RPC endpoints from Chainlist, providing a reliable way to interact with various Ethereum networks.

## Features

- Automatically fetches and caches RPC endpoints from Chainlist
- Implements a waterfall fallback mechanism for reliable RPC access
- Supports all Ethereum networks listed on Chainlist
- Automatic RPC endpoint health checking
- Weekly automatic updates of RPC endpoints
- Built-in progress display during RPC validation
- Customizable progress tracking

## Installation

```bash
npm install @smarttokenlabs/waterfall-rpc
```

## Usage

### Basic Usage (with built-in progress display)

#### Display name of USDC

```typescript
import { WaterfallRpc } from "@smarttokenlabs/waterfall-rpc";
import { ethers } from "ethers";

const erc20Abi = [
    "function balanceOf(address owner) view returns (uint256 balance)",
    "function name() view returns (string)"
];

const usdcAddress = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";

const start = async () => {
    const provider = await WaterfallRpc.createProvider(1);
    const contract = new ethers.Contract(usdcAddress, erc20Abi, provider);

    const usdcName = await contract.name();
    console.log('USDC Name:', usdcName);
};

start();
```

#### Get blocknumber for Base Sepolia

```typescript
import { WaterfallRpc } from '@smarttokenlabs/waterfall-rpc';

// Create a provider for Base Sepolia (will show progress automatically)
const provider = await WaterfallRpc.createProvider(84532);

// Use the provider with ethers.js
const blockNumber = await provider.getBlockNumber();
console.log(`Current block number: ${blockNumber}`);
```

### Custom Progress Display

```typescript
import { WaterfallRpc, ProgressCallback } from '@smarttokenlabs/waterfall-rpc';

// Create a custom progress callback
const customProgress: ProgressCallback = (event) => {
    console.log(`Validating RPC ${event.current}/${event.total}: ${event.url}`);
    console.log(`Status: ${event.status}`);
};

// Create a provider with custom progress display
const provider = await WaterfallRpc.createProvider(84532, customProgress);
```

### Disable Progress Display

```typescript
import { WaterfallRpc } from '@smarttokenlabs/waterfall-rpc';

// Create a provider without progress display
const provider = await WaterfallRpc.createProvider(84532, () => {});
```

## API Documentation

### WaterfallRpc

The main class that provides a reliable RPC connection with fallback support.

#### Static Methods

- `createProvider(chainId: number, onProgress?: ProgressCallback): Promise<WaterfallRpc>`
  - Creates a new provider instance for the specified chain ID
  - Automatically checks and filters working RPC endpoints
  - Shows a progress bar by default
  - Optional custom progress callback

#### Types

```typescript
interface ProgressEvent {
    current: number;    // Current RPC being checked (1-based)
    total: number;      // Total number of RPCs to check
    url: string;        // URL of the RPC being checked
    status: 'checking' | 'success' | 'failed';  // Current status of the check
}

type ProgressCallback = (event: ProgressEvent) => void;
```

#### Instance Methods

- All standard ethers.js provider methods are available
- The provider automatically handles RPC failures and retries with different endpoints

## License

MIT
