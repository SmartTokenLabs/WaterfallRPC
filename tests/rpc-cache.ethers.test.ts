/**
 * Ethers: WaterfallRpc.createProvider uses catalog cache — first run fetches, second uses storage.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRpcStorage, WaterfallRpc } from '../src/waterfallRpc';
import { installCatalogFetchMock, MOCK_CHAIN_ID } from './rpc-cache.fixtures';

vi.mock('../src/rpcProbe', () => ({
    probeWorkingHttpsRpcUrls: vi.fn(async (urls: string[]) => [...urls]),
}));

describe('catalog cache (ethers / WaterfallRpc)', () => {
    let fetchMock: ReturnType<typeof installCatalogFetchMock>;

    beforeEach(() => {
        fetchMock = installCatalogFetchMock();
    });

    afterEach(() => {
        fetchMock.mockRestore();
    });

    it('first createProvider loads catalog via fetch and persists to storage', async () => {
        const storage = new MemoryRpcStorage();
        expect(storage.exists()).toBe(false);

        await WaterfallRpc.createProvider(MOCK_CHAIN_ID, () => undefined, { storage });

        expect(fetchMock).toHaveBeenCalled();
        expect(storage.exists()).toBe(true);
        expect(storage.read()?.entries[MOCK_CHAIN_ID]?.rpcs?.[0]?.url).toBe('https://example.invalid/rpc');
    });

    it('second createProvider with the same storage does not re-fetch the catalog', async () => {
        const storage = new MemoryRpcStorage();

        await WaterfallRpc.createProvider(MOCK_CHAIN_ID, () => undefined, { storage });
        expect(fetchMock).toHaveBeenCalled();
        fetchMock.mockClear();

        await WaterfallRpc.createProvider(MOCK_CHAIN_ID, () => undefined, { storage });

        expect(fetchMock).not.toHaveBeenCalled();
    });
});
