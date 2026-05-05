/**
 * Integration test: uses live RPC ranking + chainlist fetch, then reads mainnet balances.
 *
 * Set TEST_WALLET_ADDRESS in `.env` (copy from `.env.example`) to a wallet that holds ETH and USDC.
 */
import { ethers } from 'ethers';
import { describe, expect, it } from 'vitest';
import { MemoryRpcStorage, WaterfallRpc } from '../src/waterfallRpc';

const CHAIN_ID = 1;
const USDC_MAINNET = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const ERC20_BALANCE_OF = ['function balanceOf(address account) view returns (uint256)'] as const;

const walletAddress = process.env.TEST_WALLET_ADDRESS?.trim();

describe.skipIf(!walletAddress)('integration: ETH and USDC balances via WaterfallRpc', () => {
    it('accepts TEST_WALLET_ADDRESS as a checksummed mainnet account', () => {
        expect(walletAddress).toBeTruthy();
        expect(ethers.isAddress(walletAddress!)).toBe(true);
    });

    it('fetches non-zero ETH and USDC on Ethereum mainnet', async () => {
        const address = ethers.getAddress(walletAddress!);

        const provider = await WaterfallRpc.createProvider(
            CHAIN_ID,
            () => {
                /* quiet — RPC probing can be very chatty */
            },
            { storage: new MemoryRpcStorage() }
        );

        const ethWei = await provider.getBalance(address);
        expect(ethWei).toBeGreaterThan(0n);

        const usdc = new ethers.Contract(USDC_MAINNET, ERC20_BALANCE_OF, provider);
        const rawUsdc = await usdc.balanceOf(address);
        expect(rawUsdc).toBeGreaterThan(0n);

        // eslint-disable-next-line no-console -- local verification
        console.log('[balances]', { eth: ethers.formatEther(ethWei), usdc: ethers.formatUnits(rawUsdc, 6) });
    });
});
