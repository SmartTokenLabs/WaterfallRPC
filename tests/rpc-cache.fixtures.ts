import { vi } from 'vitest';

export const MOCK_CHAIN_ID = 424242;

export const CHAINLIST_PAYLOAD = [
    {
        chainId: MOCK_CHAIN_ID,
        name: 'Mock Chain',
        chainSlug: 'mock',
        nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
        rpc: [{ url: 'https://example.invalid/rpc' }],
    },
];

/** Mocks opk / rpc-rankings / chainlist fetches only (rankings + catalog). */
export function installCatalogFetchMock(): ReturnType<typeof vi.spyOn<typeof globalThis, 'fetch'>> {
    return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, _init?: RequestInit) => {
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
            return new Response(JSON.stringify([]), { status: 200 });
        }
        if (url.includes('chainlist.org')) {
            return new Response(JSON.stringify(CHAINLIST_PAYLOAD), { status: 200 });
        }
        return new Response('not found', { status: 404 });
    });
}
