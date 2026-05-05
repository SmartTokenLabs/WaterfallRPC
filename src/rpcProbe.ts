import type { ProgressEvent } from './rpcDataTypes';

export type RpcProbeProgress = (event: ProgressEvent) => void;

/**
 * Returns URLs that respond to `eth_blockNumber` within 5s with a valid block height.
 * Matches the historical ethers-based probe behavior in WaterfallRpc.
 */
export async function probeWorkingHttpsRpcUrls(
    urls: string[],
    onProgress?: RpcProbeProgress
): Promise<string[]> {
    const working: string[] = [];
    const total = urls.length;

    for (let i = 0; i < urls.length; i++) {
        const url = urls[i];
        onProgress?.({ current: i + 1, total, url, status: 'checking' });
        try {
            const ok = await probeEthBlockNumber(url);
            if (ok) {
                working.push(url);
                onProgress?.({ current: i + 1, total, url, status: 'success' });
            } else {
                onProgress?.({ current: i + 1, total, url, status: 'failed' });
            }
        } catch {
            onProgress?.({ current: i + 1, total, url, status: 'failed' });
        }
    }

    if (working.length === 0) {
        throw new Error('No working providers found');
    }
    return working;
}

async function probeEthBlockNumber(url: string): Promise<boolean> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }),
            signal: controller.signal,
        });
        if (!res.ok) return false;
        const json = (await res.json()) as { result?: string; error?: unknown };
        if (json.error != null) return false;
        if (json.result == null) return false;
        const n = Number.parseInt(json.result, 16);
        return Number.isFinite(n) && n > 0;
    } finally {
        clearTimeout(timer);
    }
}
