import {
    BaseError,
    createPublicClient,
    custom,
    http,
    RpcRequestError,
    type Chain,
    type PublicClient,
    type Transport,
} from 'viem';
import type { ProgressEvent } from './rpcDataTypes';
import {
    loadWorkingRpcUrlsForChain,
    UniversalRpc,
    WATERFALL_DEFAULT_RANKING_FEEDS,
    type WaterfallRpcOptions,
} from './waterfallRpc';

export type WaterfallViemOptions = WaterfallRpcOptions & {
    /** Progress when probing RPCs (same shape as `WaterfallRpc.createProvider`). */
    onRpcProbeProgress?: (event: ProgressEvent) => void;
};

function hasSolidityRevertData(data: unknown): boolean {
    return typeof data === 'string' && /^0x[0-9a-fA-F]{8,}$/.test(data);
}

/** JSON-RPC execution reverted (3) with concrete revert data: do not failover (real on-chain revert). */
function shouldAbortFailover(error: unknown): boolean {
    if (error instanceof RpcRequestError && error.code === 3 && hasSolidityRevertData(error.data)) {
        return true;
    }
    if (error instanceof BaseError) {
        return (
            error.walk(
                (e) => e instanceof RpcRequestError && e.code === 3 && hasSolidityRevertData(e.data)
            ) != null
        );
    }
    return false;
}

/**
 * Viem transport using the same ranked RPC list and probe/cache behavior as `WaterfallRpc`,
 * with randomized starting endpoint and delay between failover attempts.
 * Endpoints are merged from chainlist with calibrated rankings at
 * {@link WATERFALL_DEFAULT_RANKING_FEEDS}. For OPK chains (see `catalogChainIdHint` in
 * `WaterfallRpcOptions`), only the opk rankings file is downloaded.
 */
export async function createWaterfallTransport(
    chain: Chain,
    options?: WaterfallViemOptions
): Promise<Transport> {
    const rpcManager = await UniversalRpc.getInstance({
        ...options,
        rankingFeeds: { ...WATERFALL_DEFAULT_RANKING_FEEDS, ...options?.rankingFeeds },
        catalogChainIdHint: chain.id,
    });
    const urls = await loadWorkingRpcUrlsForChain(rpcManager, chain.id, options?.onRpcProbeProgress);

    const factory = (params: Parameters<Transport>[0]) => {
        const transports = urls.map((url) => http(url)(params));
        return custom(
            {
                request: async (args) => {
                    const errors: unknown[] = [];
                    const startIndex = Math.floor(Math.random() * transports.length);
                    for (let i = 0; i < transports.length; i++) {
                        const sub = transports[(startIndex + i) % transports.length];
                        try {
                            if (errors.length > 0) {
                                await new Promise((r) => setTimeout(r, 5000));
                            }
                            const out = await sub.request(args);
                            rpcManager.scheduleCatalogRefreshIfStale();
                            return out;
                        } catch (e: unknown) {
                            if (shouldAbortFailover(e)) throw e;
                            errors.push(e);
                        }
                    }
                    throw errors[0];
                },
            },
            { key: 'waterfall', name: 'Waterfall JSON-RPC', retryCount: 0 }
        )(params);
    };

    return factory as Transport;
}

export async function createWaterfallPublicClient(
    chain: Chain,
    options?: WaterfallViemOptions
): Promise<PublicClient> {
    const transport = await createWaterfallTransport(chain, options);
    return createPublicClient({ chain, transport });
}
