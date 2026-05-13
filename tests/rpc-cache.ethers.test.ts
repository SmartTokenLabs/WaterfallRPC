/**
 * Ethers: WaterfallRpc.createProvider uses catalog cache — first run fetches, second uses storage.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRpcStorage, WaterfallRpc } from '../src/waterfallRpc';
import { CHAINLIST_PAYLOAD, installCatalogFetchMock, MOCK_CHAIN_ID } from './rpc-cache.fixtures';

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

describe('catalog from rankings only (no chainlist merge)', () => {
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
                    return new Response(JSON.stringify({ chains: [] }), { status: 200 });
                }
                if (url.includes('rpc-rankings')) {
                    return new Response(
                        JSON.stringify([
                            { chainId: MOCK_CHAIN_ID, rpcs: [{ url: 'https://ranked.example/rpc' }] },
                        ]),
                        { status: 200 }
                    );
                }
                if (url.includes('chainlist.org')) {
                    return new Response(JSON.stringify(CHAINLIST_PAYLOAD), { status: 200 });
                }
                return new Response('not found', { status: 404 });
            }
        );
    });

    afterEach(() => {
        fetchMock.mockRestore();
    });

    it('does not fetch chainlist when rpc-rankings includes the chain', async () => {
        const storage = new MemoryRpcStorage();
        await WaterfallRpc.createProvider(MOCK_CHAIN_ID, () => undefined, { storage });

        expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('chainlist.org'))).toBe(false);
        expect(storage.read()?.entries[MOCK_CHAIN_ID]?.rpcs?.[0]?.url).toBe('https://ranked.example/rpc');
    });
});

describe('OPK catalog chain: skip rpc-rankings download', () => {
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

    it('does not request rpc-rankings when createProvider chainId is in OPK set', async () => {
        const storage = new MemoryRpcStorage();
        await WaterfallRpc.createProvider(1, () => undefined, { storage });

        expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('rpc-rankings'))).toBe(false);
        expect(storage.read()?.entries[1]?.rpcs?.[0]?.url).toBe('https://opk.example/rpc');
    });
});
