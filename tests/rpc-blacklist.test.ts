import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    BlockedRpcStore,
    extractBaseDomain,
    extractHostname,
    looksLikeRouterBlock,
    MemoryRpcBlacklistStorage,
    UNKNOWN_EXTERNAL_IP,
} from '../src/rpcBlacklist';

describe('extractBaseDomain / extractHostname', () => {
    it('reduces subdomains to the last two labels', () => {
        expect(extractHostname('https://eth.drpc.org/path')).toBe('eth.drpc.org');
        expect(extractBaseDomain('https://eth.drpc.org')).toBe('drpc.org');
        expect(extractBaseDomain('https://solana.drpc.org')).toBe('drpc.org');
        expect(extractBaseDomain('https://rpc.mevblocker.io')).toBe('mevblocker.io');
        expect(extractBaseDomain('https://eth.llamarpc.com')).toBe('llamarpc.com');
    });

    it('leaves IPs and single-label hosts alone', () => {
        expect(extractBaseDomain('https://127.0.0.1:8545')).toBe('127.0.0.1');
        expect(extractBaseDomain('localhost')).toBe('localhost');
    });
});

describe('looksLikeRouterBlock', () => {
    it('detects TLS / certificate style errors from the cause chain', () => {
        expect(
            looksLikeRouterBlock(
                Object.assign(new Error('socket hang up'), {
                    cause: Object.assign(new Error('write EPROTO'), {
                        code: 'EPROTO',
                        message: 'wrong version number',
                    }),
                })
            )
        ).toBe(true);

        expect(
            looksLikeRouterBlock(
                Object.assign(new Error('handshake failed'), {
                    name: 'SSLHandshakeException',
                })
            )
        ).toBe(true);

        expect(looksLikeRouterBlock(new Error('plaintext http on 443'))).toBe(true);
    });

    it('does not treat ordinary RPC failures as router blocks', () => {
        expect(looksLikeRouterBlock(new Error('timeout'))).toBe(false);
        expect(looksLikeRouterBlock(new Error('502 Bad Gateway'))).toBe(false);
        expect(looksLikeRouterBlock({ code: -32000, message: 'server error' })).toBe(false);
    });
});

describe('BlockedRpcStore', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('persists base domain under external IP and covers sibling subdomains', async () => {
        const storage = new MemoryRpcBlacklistStorage();
        const store = new BlockedRpcStore({
            storage,
            fetchExternalIp: async () => '203.0.113.10',
        });

        store.recordFailureIfBlocked(
            'https://eth.drpc.org',
            Object.assign(new Error('tls'), { code: 'EPROTO', message: 'wrong version number' })
        );

        expect(store.isBlocked('https://eth.drpc.org')).toBe(true);
        expect(store.isBlocked('https://solana.drpc.org')).toBe(true);
        expect(store.isBlocked('https://rpc.mevblocker.io')).toBe(false);

        await vi.waitFor(() => {
            expect(storage.read()?.entries['203.0.113.10']).toContain('drpc.org');
        });
    });

    it('uses a separate domain set when external IP changes', async () => {
        const storage = new MemoryRpcBlacklistStorage();
        storage.write({
            entries: {
                '203.0.113.10': ['drpc.org'],
                '198.51.100.7': ['llamarpc.com'],
            },
        });

        const storeA = new BlockedRpcStore({
            storage,
            fetchExternalIp: async () => '203.0.113.10',
        });
        await storeA.getExternalIp();

        expect(storeA.isBlocked('https://eth.drpc.org')).toBe(true);
        expect(storeA.isBlocked('https://eth.llamarpc.com')).toBe(false);

        const storeB = new BlockedRpcStore({
            storage,
            fetchExternalIp: async () => '198.51.100.7',
        });
        await storeB.getExternalIp();

        expect(storeB.isBlocked('https://eth.drpc.org')).toBe(false);
        expect(storeB.isBlocked('https://eth.llamarpc.com')).toBe(true);
    });

    it('filterBlocked never returns an empty list when all URLs are blocked', () => {
        const storage = new MemoryRpcBlacklistStorage();
        const store = new BlockedRpcStore({
            storage,
            fetchExternalIp: async () => UNKNOWN_EXTERNAL_IP,
        });
        store.recordBlocked('https://a.drpc.org', 'test');
        store.recordBlocked('https://b.mevblocker.io', 'test');

        const urls = ['https://a.drpc.org', 'https://b.mevblocker.io'];
        expect(store.filterBlocked(urls)).toEqual(urls);
    });

    it('skips a blocked domain on the next failover pass without re-trying it', async () => {
        const storage = new MemoryRpcBlacklistStorage();
        const store = new BlockedRpcStore({
            storage,
            fetchExternalIp: async () => '203.0.113.10',
        });

        const urls = ['https://bad.drpc.org', 'https://good.publicnode.com'];
        const attempted: string[] = [];

        async function roundRobin(): Promise<string> {
            const errors: unknown[] = [];
            for (let i = 0; i < urls.length; i++) {
                const url = urls[i];
                if (store.isBlocked(url)) continue;
                attempted.push(url);
                try {
                    if (url.includes('drpc.org')) {
                        const err = Object.assign(new Error('wrong version number'), { code: 'EPROTO' });
                        store.recordFailureIfBlocked(url, err);
                        throw err;
                    }
                    return 'ok';
                } catch (e) {
                    errors.push(e);
                }
            }
            throw errors[0];
        }

        await expect(roundRobin()).resolves.toBe('ok');
        attempted.length = 0;
        await expect(roundRobin()).resolves.toBe('ok');
        expect(attempted).toEqual(['https://good.publicnode.com']);
    });
});
