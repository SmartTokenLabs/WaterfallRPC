// UniversalRPC loads RPC URLs from calibrated rankings (twice daily) when available:
// - https://pub-947f58bf7fb442f7a0d0686fcf757d76.r2.dev/opk-rankings.json (curated chain IDs)
// - https://pub-947f58bf7fb442f7a0d0686fcf757d76.r2.dev/rpc-rankings.json (all chains)
// If those feeds yield at least one chain, the catalog is built from them only (no chainlist merge).
// When `catalogChainIdHint` is an OPK chain id, only opk-rankings is downloaded (rpc-rankings skipped).
// Otherwise fetches https://chainlist.org/rpcs.json for HTTPS RPC lists + chain metadata.
// WaterfallRpc provides a working provider for a given chainId.
//
// Default cache: Node writes `.rpcdata` under cwd. For a browser wallet, pass
// `{ useWebCache: true }` or `{ storage: new LocalStorageRpcStorage() }`. Use the package
// `browser` field so `fs` is not pulled into client bundles. Rankings + chainlist need CORS.

import { ethers, isCallException, PerformActionRequest } from 'ethers';
import { LocalStorageRpcStorage, MemoryRpcStorage, type RpcDataStorage } from './rpcCacheStorage';
import type { ProgressEvent, RPCConfig, RPCData } from './rpcDataTypes';
import { probeWorkingHttpsRpcUrls } from './rpcProbe';

export const WATERFALL_DEFAULT_RANKING_FEEDS = {
    opk: 'https://pub-947f58bf7fb442f7a0d0686fcf757d76.r2.dev/opk-rankings.json',
    rpc: 'https://pub-947f58bf7fb442f7a0d0686fcf757d76.r2.dev/rpc-rankings.json',
    chainlist: 'https://chainlist.org/rpcs.json',
} as const;

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
    /**
     * Override URLs for calibrated rankings + chainlist merge. Defaults match
     * {@link WATERFALL_DEFAULT_RANKING_FEEDS}.
     */
    rankingFeeds?: Partial<typeof WATERFALL_DEFAULT_RANKING_FEEDS>;
    /**
     * Chain you are loading the catalog for. When it is in the OPK set (see `rpc-rankings` / `opk-rankings`
     * split in this module), only `opk-rankings.json` is fetched; `rpc-rankings.json` is omitted.
     * Omit for a full multi-chain catalog (e.g. shared cache across many chain ids).
     */
    catalogChainIdHint?: number;
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

/** When the hinted chain uses the OPK feed exclusively, skip downloading the full rpc-rankings file. */
function shouldFetchFullRpcRankings(catalogChainIdHint?: number): boolean {
    if (catalogChainIdHint === undefined) {
        return true;
    }
    return !OPK_CHAIN_IDS.has(catalogChainIdHint);
}

type ProgressCallback = (event: ProgressEvent) => void;

/** True when ethers has a concrete revert payload (vs flaky nodes that surface `CALL_EXCEPTION` with no `data`). */
function callExceptionHasRevertData(error: unknown): boolean {
    if (!isCallException(error)) {
        return false;
    }
    const data = (error as { data?: string | null }).data;
    return typeof data === 'string' && /^0x[0-9a-fA-F]{8,}$/.test(data);
}

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
    private readonly rankingFeeds: typeof WATERFALL_DEFAULT_RANKING_FEEDS;
    private readonly fetchFullRpcRankings: boolean;
    private readonly updateInterval: number = 7 * 24 * 60 * 60 * 1000; // update every week
    private cachedData: RPCData | null = null;
    private catalogDownloadInFlight: Promise<void> | null = null;

    private constructor(
        storage: RpcDataStorage,
        rankingFeeds: typeof WATERFALL_DEFAULT_RANKING_FEEDS,
        fetchFullRpcRankings: boolean
    ) {
        this.storage = storage;
        this.rankingFeeds = rankingFeeds;
        this.fetchFullRpcRankings = fetchFullRpcRankings;
    }

    public static async getInstance(options?: WaterfallRpcOptions): Promise<UniversalRpc> {
        const feeds = { ...WATERFALL_DEFAULT_RANKING_FEEDS, ...options?.rankingFeeds };
        const fetchFull = shouldFetchFullRpcRankings(options?.catalogChainIdHint);
        const instance = new UniversalRpc(resolveRpcStorage(options), feeds, fetchFull);
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
            const response = await fetch(this.rankingFeeds.opk);
            if (!response.ok) return new Map();
            return this.parseOpkRankingsPayload(await response.json());
        } catch {
            return new Map();
        }
    }

    private async fetchRpcRankingsMap(): Promise<Map<number, { url: string }[]>> {
        try {
            const response = await fetch(this.rankingFeeds.rpc);
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

    /**
     * RPC list for a chain from ranking feeds: calibrated order when applicable, else raw opk/full
     * (mirrors former chainlist merge + addRankingsOnly).
     */
    private rpcsFromRankingsMaps(
        chainId: number,
        opkMap: Map<number, { url: string }[]>,
        fullMap: Map<number, { url: string }[]>
    ): { url: string }[] | null {
        const ranked = this.rankedRpcsForChain(chainId, opkMap, fullMap);
        if (ranked && ranked.length > 0) return ranked;
        const opk = opkMap.get(chainId);
        if (opk && opk.length > 0) return opk;
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
        const [opkMap, fullMap] = this.fetchFullRpcRankings
            ? await Promise.all([this.fetchOpkRankingsMap(), this.fetchRpcRankingsMap()])
            : [await this.fetchOpkRankingsMap(), new Map<number, { url: string }[]>()];

        const storedData: RPCData = {
            entries: {},
            date: new Date().toISOString(),
        };

        const chainIds = new Set<number>();
        for (const id of opkMap.keys()) chainIds.add(id);
        for (const id of fullMap.keys()) chainIds.add(id);

        for (const chainId of chainIds) {
            const rpcs = this.rpcsFromRankingsMaps(chainId, opkMap, fullMap);
            if (rpcs && rpcs.length > 0) {
                storedData.entries[chainId] = this.minimalConfig(chainId, rpcs);
            }
        }

        if (Object.keys(storedData.entries).length === 0) {
            let chainlistPayload: unknown = null;
            try {
                const response = await fetch(this.rankingFeeds.chainlist);
                if (response.ok) chainlistPayload = await response.json();
            } catch {
                chainlistPayload = null;
            }

            if (Array.isArray(chainlistPayload)) {
                for (const rpc of chainlistPayload) {
                    if (!rpc || typeof rpc.chainId !== 'number' || !Array.isArray(rpc.rpc)) continue;
                    const chainId = rpc.chainId;
                    const httpsRpcs = (rpc.rpc as { url?: string }[])
                        .filter((r) => r.url?.startsWith('https://'))
                        .map((r) => ({ url: r.url as string }));
                    storedData.entries[chainId] = {
                        name: rpc.name,
                        chainId,
                        chainSlug: rpc.chainSlug,
                        nativeCurrency: rpc.nativeCurrency,
                        checked: false,
                        rpcs: httpsRpcs,
                    };
                }
            }
        }

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
        const raw = this.cachedData ?? this.storage.read();
        if (!raw?.date) {
            return true;
        }
        return Date.now() - new Date(raw.date).getTime() > updateInterval;
    }

    /**
     * When the on-disk catalog is older than the interval, start a background download.
     * Safe to call often (e.g. after each successful RPC); deduped and non-blocking.
     */
    public scheduleCatalogRefreshIfStale(): void {
        if (!this.needUpdate(this.updateInterval)) {
            return;
        }
        if (this.catalogDownloadInFlight) {
            return;
        }
        this.catalogDownloadInFlight = this.downloadRpcs()
            .catch((err) => {
                console.error('WaterfallRpc: background RPC catalog refresh failed', err);
            })
            .finally(() => {
                this.catalogDownloadInFlight = null;
            });
    }

    private async init(): Promise<void> {
        if (this.storage.exists()) {
            this.loadRpcs();
            this.scheduleCatalogRefreshIfStale();
        } else {
            await this.downloadRpcs();
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
    private readonly catalog: UniversalRpc;

    private constructor(chainId: number, primaryUrl: string, catalog: UniversalRpc) {
        super(primaryUrl, chainId, {
            batchMaxCount: 1,
            staticNetwork: true,
        });

        this.catalog = catalog;
        this.providers = [];
    }

    public static async createProvider(
        chainId: number,
        onProgress: ProgressCallback = defaultProgressDisplay,
        options?: WaterfallRpcOptions
    ): Promise<WaterfallRpc> {
        const rpcManager = await UniversalRpc.getInstance({ ...options, catalogChainIdHint: chainId });
        const urls = await loadWorkingRpcUrlsForChain(rpcManager, chainId, onProgress);

        const instance = new WaterfallRpc(chainId, urls[0], rpcManager);
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

                const result = await provider._perform(req);
                this.catalog.scheduleCatalogRefreshIfStale();
                return result;
            } catch (e: unknown) {
                if (isCallException(e) && callExceptionHasRevertData(e)) {
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
