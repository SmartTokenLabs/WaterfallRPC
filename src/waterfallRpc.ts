// UniversalRPC loads RPC URLs from calibrated rankings (twice daily) when available:
// - https://pub-947f58bf7fb442f7a0d0686fcf757d76.r2.dev/opk-rankings.json (curated chain IDs)
// - https://pub-947f58bf7fb442f7a0d0686fcf757d76.r2.dev/rpc-rankings.json (all chains)
// Falls back to https://chainlist.org/rpcs.json for metadata or when rankings are missing.
// WaterfallRpc provides a working provider for a given chainId.
//
// Default cache: Node writes `.rpcdata` under cwd. For a browser wallet, pass
// `{ useWebCache: true }` or `{ storage: new LocalStorageRpcStorage() }`. Use the package
// `browser` field so `fs` is not pulled into client bundles. Rankings + chainlist need CORS.

import { ethers, PerformActionRequest } from 'ethers';
import { LocalStorageRpcStorage, MemoryRpcStorage, type RpcDataStorage } from './rpcCacheStorage';
import type { ProgressEvent, RPCConfig, RPCData } from './rpcDataTypes';
import { probeWorkingHttpsRpcUrls } from './rpcProbe';

const OPK_RANKINGS_URL =
    'https://pub-947f58bf7fb442f7a0d0686fcf757d76.r2.dev/opk-rankings.json';
const RPC_RANKINGS_URL =
    'https://pub-947f58bf7fb442f7a0d0686fcf757d76.r2.dev/rpc-rankings.json';
const CHAINLIST_RPC_URL = 'https://chainlist.org/rpcs.json';

/** Chains that use the smaller opk-rankings feed when it has data for that chain. */
const OPK_CHAIN_IDS = new Set([1, 8453, 84532, 421613, 42161, 11155111]);

export type { ProgressEvent, RPCConfig, RPCData } from './rpcDataTypes';
export type WaterfallRpcOptions = {
    /**
     * When set, used as the RPC catalog cache. Overrides `useWebCache`.
     * For example `new LocalStorageRpcStorage()` or a custom IndexedDB adapter.
     */
    storage?: RpcDataStorage;
    /**
     * Browser / extension: use `localStorage` (with in-memory fallback if unavailable).
     * Omit on Node backends so the default remains the `.rpcdata` file.
     */
    useWebCache?: boolean;
};
export {
    isBrowserLike,
    LocalStorageRpcStorage,
    MemoryRpcStorage,
    type RpcDataStorage,
} from './rpcCacheStorage';

function resolveRpcStorage(options?: WaterfallRpcOptions): RpcDataStorage {
    if (options?.storage) {
        return options.storage;
    }
    if (options?.useWebCache) {
        try {
            return new LocalStorageRpcStorage();
        } catch {
            return new MemoryRpcStorage();
        }
    }
    // Default: Node — `.rpcdata` under cwd (not loaded in browser bundles that substitute the stub).
    // eslint-disable-next-line @typescript-eslint/no-var-requires -- runtime-only `require` for Node; avoids bundling `fs` in browsers
    const { FilesystemRpcStorage } = require('./rpcCacheStorageNode') as typeof import('./rpcCacheStorageNode');
    return new FilesystemRpcStorage();
}

type ProgressCallback = (event: ProgressEvent) => void;

/** Loads the RPC catalog for a chain, probes endpoints when needed, and returns working HTTPS URLs in ranked order. */
export async function loadWorkingRpcUrlsForChain(
    rpcManager: UniversalRpc,
    chainId: number,
    onProgress?: ProgressCallback
): Promise<string[]> {
    const rpcConfig = rpcManager.getRPC(chainId);
    if (!rpcConfig) {
        throw new Error(`No RPC configuration found for chainId ${chainId}`);
    }
    let urls = rpcConfig.rpcs.map((r) => r.url);
    if (!rpcConfig.checked) {
        urls = await probeWorkingHttpsRpcUrls(urls, onProgress);
        if (urls.length < rpcConfig.rpcs.length) {
            await rpcManager.updateWorkingProviders(chainId, urls);
        }
    }
    return urls;
}

function defaultProgressDisplay(event: ProgressEvent): void {
    const percentage = (event.current / event.total) * 100;
    const barLength = 20;
    const filledLength = Math.round((event.current / event.total) * barLength);
    const bar = '█'.repeat(filledLength) + '░'.repeat(barLength - filledLength);
    const line = `${bar} ${percentage.toFixed(1)}% | ${event.current}/${event.total} | ${event.url} | ${event.status}`;

    const stdout = typeof process !== 'undefined' ? process.stdout : undefined;
    if (stdout && typeof stdout.write === 'function') {
        stdout.write('\r\x1b[K');
        stdout.write(line);
        if (event.current === event.total) {
            stdout.write('\r\x1b[K\x1b[1A\x1b[K');
        }
        return;
    }

    if (event.current === event.total || event.status === 'failed') {
        console.debug('[WaterfallRpc]', line.trimEnd());
    }
}

export class UniversalRpc {
    private readonly storage: RpcDataStorage;
    private readonly updateInterval: number = 7 * 24 * 60 * 60 * 1000; // update every week
    private cachedData: RPCData | null = null;

    private constructor(storage: RpcDataStorage) {
        this.storage = storage;
    }

    public static async getInstance(options?: WaterfallRpcOptions): Promise<UniversalRpc> {
        const instance = new UniversalRpc(resolveRpcStorage(options));
        await instance.init();
        return instance;
    }

    private persist(data: RPCData): void {
        this.storage.write(data);
        this.cachedData = data;
    }

    private dedupeHttpsRpcs(rpcs: Array<{ url?: string }>): { url: string }[] {
        const seen = new Set<string>();
        const out: { url: string }[] = [];
        for (const r of rpcs) {
            const u = r.url;
            if (typeof u === 'string' && u.startsWith('https://') && !seen.has(u)) {
                seen.add(u);
                out.push({ url: u });
            }
        }
        return out;
    }

    /** opk-rankings.json: `{ generatedAt, chains: [{ chainId, rpcs }] }` */
    private parseOpkRankingsPayload(data: unknown): Map<number, { url: string }[]> {
        const map = new Map<number, { url: string }[]>();
        if (!data || typeof data !== 'object' || !('chains' in data)) return map;
        const chains = (data as { chains: unknown }).chains;
        if (!Array.isArray(chains)) return map;
        for (const row of chains) {
            if (!row || typeof row !== 'object' || typeof (row as { chainId: unknown }).chainId !== 'number')
                continue;
            const rpcList = (row as { rpcs?: unknown }).rpcs;
            if (!Array.isArray(rpcList)) continue;
            map.set((row as { chainId: number }).chainId, this.dedupeHttpsRpcs(rpcList));
        }
        return map;
    }

    /** rpc-rankings.json: `[{ chainId, rpcs }]` or same `{ chains }` wrapper as opk */
    private parseRpcRankingsPayload(data: unknown): Map<number, { url: string }[]> {
        if (data && typeof data === 'object' && 'chains' in data) {
            return this.parseOpkRankingsPayload(data);
        }
        const map = new Map<number, { url: string }[]>();
        if (!Array.isArray(data)) return map;
        for (const row of data) {
            if (!row || typeof row !== 'object' || typeof (row as { chainId: unknown }).chainId !== 'number')
                continue;
            const rpcList = (row as { rpcs?: unknown }).rpcs;
            if (!Array.isArray(rpcList)) continue;
            map.set((row as { chainId: number }).chainId, this.dedupeHttpsRpcs(rpcList));
        }
        return map;
    }

    private async fetchOpkRankingsMap(): Promise<Map<number, { url: string }[]>> {
        try {
            const response = await fetch(OPK_RANKINGS_URL);
            if (!response.ok) return new Map();
            return this.parseOpkRankingsPayload(await response.json());
        } catch {
            return new Map();
        }
    }

    private async fetchRpcRankingsMap(): Promise<Map<number, { url: string }[]>> {
        try {
            const response = await fetch(RPC_RANKINGS_URL);
            if (!response.ok) return new Map();
            return this.parseRpcRankingsPayload(await response.json());
        } catch {
            return new Map();
        }
    }

    private rankedRpcsForChain(
        chainId: number,
        opkMap: Map<number, { url: string }[]>,
        fullMap: Map<number, { url: string }[]>
    ): { url: string }[] | null {
        if (OPK_CHAIN_IDS.has(chainId)) {
            const opk = opkMap.get(chainId);
            if (opk && opk.length > 0) return opk;
            const fromFull = fullMap.get(chainId);
            if (fromFull && fromFull.length > 0) return fromFull;
            return null;
        }
        const fromFull = fullMap.get(chainId);
        if (fromFull && fromFull.length > 0) return fromFull;
        return null;
    }

    private minimalConfig(chainId: number, rpcs: { url: string }[]): RPCConfig {
        return {
            name: `Chain ${chainId}`,
            chainId,
            chainSlug: '',
            checked: false,
            nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
            rpcs,
        };
    }

    public async downloadRpcs(): Promise<void> {
        const [opkMap, fullMap] = await Promise.all([
            this.fetchOpkRankingsMap(),
            this.fetchRpcRankingsMap(),
        ]);

        let chainlistPayload: unknown = null;
        try {
            const response = await fetch(CHAINLIST_RPC_URL);
            if (response.ok) chainlistPayload = await response.json();
        } catch {
            chainlistPayload = null;
        }

        const storedData: RPCData = {
            entries: {},
            date: new Date().toISOString(),
        };

        if (Array.isArray(chainlistPayload)) {
            for (const rpc of chainlistPayload) {
                if (!rpc || typeof rpc.chainId !== 'number' || !Array.isArray(rpc.rpc)) continue;
                const chainId = rpc.chainId;
                const httpsRpcs = (rpc.rpc as { url?: string }[])
                    .filter((r) => r.url?.startsWith('https://'))
                    .map((r) => ({ url: r.url as string }));
                const ranked = this.rankedRpcsForChain(chainId, opkMap, fullMap);
                storedData.entries[chainId] = {
                    name: rpc.name,
                    chainId,
                    chainSlug: rpc.chainSlug,
                    nativeCurrency: rpc.nativeCurrency,
                    checked: false,
                    rpcs: ranked && ranked.length > 0 ? ranked : httpsRpcs,
                };
            }
        }

        const addRankingsOnly = (chainId: number, rpcs: { url: string }[]) => {
            if (rpcs.length === 0 || storedData.entries[chainId]) return;
            storedData.entries[chainId] = this.minimalConfig(chainId, rpcs);
        };
        for (const [cid, rpcs] of opkMap) addRankingsOnly(cid, rpcs);
        for (const [cid, rpcs] of fullMap) addRankingsOnly(cid, rpcs);

        if (Object.keys(storedData.entries).length === 0) {
            const err = new Error('Could not load RPC data from rankings or chainlist');
            console.error(err.message);
            throw err;
        }

        try {
            this.persist(storedData);
        } catch (error) {
            console.error('Error writing RPC cache:', error);
            throw error;
        }
    }

    private loadRpcs(): RPCData {
        if (this.cachedData !== null) {
            return this.cachedData;
        }
        try {
            const data = this.storage.read();
            if (!data) {
                throw new Error('RPC cache empty');
            }
            this.cachedData = data;
            return data;
        } catch (error) {
            console.error('Error loading RPCs:', error);
            throw error;
        }
    }

    public needUpdate(updateInterval: number): boolean {
        if (!this.storage.exists()) {
            return true;
        }
        const raw = this.storage.read();
        if (!raw?.date) {
            return true;
        }
        return new Date().getTime() - new Date(raw.date).getTime() > updateInterval;
    }

    private async init(): Promise<void> {
        if (this.needUpdate(this.updateInterval)) {
            await this.downloadRpcs();
        } else {
            this.loadRpcs();
        }
    }

    public getRPC(chainId: number): RPCConfig | undefined {
        return this.loadRpcs().entries[chainId];
    }

    public async updateWorkingProviders(chainId: number, providers: Array<string>): Promise<void> {
        const data = this.loadRpcs();
        const entry = data.entries[chainId];
        if (!entry) return;
        entry.rpcs = providers.map((url) => ({ url }));
        entry.checked = true;
        this.persist(data);
    }
}

export class WaterfallRpc extends ethers.JsonRpcProvider {
    private providers: Array<ethers.JsonRpcProvider>;

    private constructor(chainId: number, primaryUrl: string) {
        super(primaryUrl, chainId, {
            batchMaxCount: 1,
            staticNetwork: true,
        });

        this.providers = [];
    }

    public static async createProvider(
        chainId: number,
        onProgress: ProgressCallback = defaultProgressDisplay,
        options?: WaterfallRpcOptions
    ): Promise<WaterfallRpc> {
        const rpcManager = await UniversalRpc.getInstance(options);
        const urls = await loadWorkingRpcUrlsForChain(rpcManager, chainId, onProgress);

        const instance = new WaterfallRpc(chainId, urls[0]);
        instance.providers = urls.map(
            (url) =>
                new ethers.JsonRpcProvider(url, chainId, {
                    batchMaxCount: 1,
                    staticNetwork: true,
                })
        );
        return instance;
    }

    public static async resetProviders(
        timeout: number = 1000 * 60 * 60 * 24 * 7,
        options?: WaterfallRpcOptions
    ) {
        const rpcManager = await UniversalRpc.getInstance(options);
        if (rpcManager.needUpdate(timeout)) {
            await rpcManager.downloadRpcs();
        }
    }

    async _perform(req: PerformActionRequest): Promise<unknown> {
        const errors: unknown[] = [];

        //randomise the start index
        const startIndex = Math.floor(Math.random() * this.providers.length);

        for (let i = 0; i < this.providers.length; i++) {
            const provider = this.providers[(startIndex + i) % this.providers.length];
            try {
                if (errors.length > 0) {
                    await new Promise((resolve) => setTimeout(resolve, 5000));
                }

                return await provider._perform(req);
            } catch (e: unknown) {
                if (e && typeof e === 'object' && 'code' in e && (e as { code?: string }).code === 'CALL_EXCEPTION') {
                    throw e;
                }
                errors.push(e);
            }
        }

        throw errors[0];
    }
}

// Example usage:
// const provider = await WaterfallRpc.createProvider(84532); // For Base Sepolia
