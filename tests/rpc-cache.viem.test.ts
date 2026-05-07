/**
 * Viem: createWaterfallTransport uses the same catalog cache — first run fetches, second uses storage.
 */
import { defineChain } from 'viem';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRpcStorage } from '../src/waterfallRpc';
import { createWaterfallTransport } from '../src/waterfallViem';
import { installCatalogFetchMock, MOCK_CHAIN_ID } from './rpc-cache.fixtures';

vi.mock('../src/rpcProbe', () => ({
    probeWorkingHttpsRpcUrls: vi.fn(async (urls: string[]) => [...urls]),
}));

const mockChain = defineChain({
    id: MOCK_CHAIN_ID,
    name: 'Mock Chain',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: ['https://example.invalid/rpc'] } },
});

describe('catalog cache (viem / createWaterfallTransport)', () => {
    let fetchMock: ReturnType<typeof installCatalogFetchMock>;

    beforeEach(() => {
        fetchMock = installCatalogFetchMock();
    });

    afterEach(() => {
        fetchMock.mockRestore();
    });

    it('first createWaterfallTransport loads catalog via fetch and persists to storage', async () => {
        const storage = new MemoryRpcStorage();
        expect(storage.exists()).toBe(false);

        await createWaterfallTransport(mockChain, { storage });

        expect(fetchMock).toHaveBeenCalled();
        expect(storage.exists()).toBe(true);
        expect(storage.read()?.entries[MOCK_CHAIN_ID]?.rpcs?.[0]?.url).toBe('https://example.invalid/rpc');
    });

    it('second createWaterfallTransport with the same storage does not re-fetch the catalog', async () => {
        const storage = new MemoryRpcStorage();

        await createWaterfallTransport(mockChain, { storage });
        expect(fetchMock).toHaveBeenCalled();
        fetchMock.mockClear();

        await createWaterfallTransport(mockChain, { storage });

        expect(fetchMock).not.toHaveBeenCalled();
    });
});
