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

const opkMainnetChain = defineChain({
    id: 1,
    name: 'Ethereum',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: ['https://placeholder.invalid'] } },
});

describe('createWaterfallTransport: OPK chain skips rpc-rankings', () => {
    let fetchMock: ReturnType<typeof vi.spyOn<typeof globalThis, 'fetch'>>;

    beforeEach(() => {
        fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(
            async (input: RequestInfo | URL, _init?: RequestInit) => {
                const url =
                    typeof input === 'string'
                        ? input
                        : input instanceof URL
                          ? input.href
                          : (input as Request).url;

                if (url.includes('opk-rankings')) {
                    return new Response(
                        JSON.stringify({
                            chains: [{ chainId: 1, rpcs: [{ url: 'https://opk.example/rpc' }] }],
                        }),
                        { status: 200 }
                    );
                }
                if (url.includes('rpc-rankings')) {
                    return new Response(
                        JSON.stringify([{ chainId: 1, rpcs: [{ url: 'https://full.example/rpc' }] }]),
                        { status: 200 }
                    );
                }
                if (url.includes('chainlist.org')) {
                    return new Response(JSON.stringify([]), { status: 200 });
                }
                return new Response('not found', { status: 404 });
            }
        );
    });

    afterEach(() => {
        fetchMock.mockRestore();
    });

    it('does not request rpc-rankings when chain.id is in OPK set', async () => {
        const storage = new MemoryRpcStorage();
        await createWaterfallTransport(opkMainnetChain, { storage });

        expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('rpc-rankings'))).toBe(false);
        expect(storage.read()?.entries[1]?.rpcs?.[0]?.url).toBe('https://opk.example/rpc');
    });
});
