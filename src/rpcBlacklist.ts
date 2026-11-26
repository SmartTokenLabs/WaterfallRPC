/**
 * ISP/router RPC blacklist (AlphaWallet BlockedRpcService port).
 * Persists blocked base domains keyed by external IP so round-robin can skip them.
 */

export type RpcBlacklistData = {
    entries: { [externalIp: string]: string[] };
};

export interface RpcBlacklistStorage {
    exists(): boolean;
    read(): RpcBlacklistData | null;
    write(data: RpcBlacklistData): void;
}

const LS_KEY = 'waterfall-rpc:rpc-blacklist-v1';
const IPIFY_URL = 'https://api.ipify.org';
const IP_CACHE_MS = 60 * 60 * 1000;
export const UNKNOWN_EXTERNAL_IP = 'unknown';

const ROUTER_BLOCK_MESSAGE_MARKERS = [
    'ssl record',
    'unexpected record',
    'plaintext http',
    'wrong version number',
    'handshake failed',
    'ssl_error',
    'certificate',
] as const;

const ROUTER_BLOCK_ERROR_CODES = new Set([
    'CERT_HAS_EXPIRED',
    'CERT_NOT_YET_VALID',
    'CERT_UNTRUSTED',
    'CERT_REJECTED',
    'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
    'DEPTH_ZERO_SELF_SIGNED_CERT',
    'SELF_SIGNED_CERT_IN_CHAIN',
    'ERR_TLS_CERT_ALTNAME_INVALID',
    'ERR_TLS_HANDSHAKE_TIMEOUT',
    'EPROTO',
    'ERR_SSL_WRONG_VERSION_NUMBER',
    'ERR_SSL_DECRYPT_ERROR_ALERT',
]);

export class LocalStorageRpcBlacklistStorage implements RpcBlacklistStorage {
    constructor(private readonly key: string = LS_KEY) {}

    exists(): boolean {
        try {
            return localStorage.getItem(this.key) != null;
        } catch {
            return false;
        }
    }

    read(): RpcBlacklistData | null {
        try {
            const raw = localStorage.getItem(this.key);
            if (raw == null) return null;
            return normalizeBlacklistData(JSON.parse(raw));
        } catch {
            return null;
        }
    }

    write(data: RpcBlacklistData): void {
        try {
            localStorage.setItem(this.key, JSON.stringify(data));
        } catch (e) {
            console.error('WaterfallRpc: could not write RPC blacklist to localStorage.', e);
            throw e;
        }
    }
}

export class MemoryRpcBlacklistStorage implements RpcBlacklistStorage {
    private payload: RpcBlacklistData | null = null;

    exists(): boolean {
        return this.payload != null;
    }

    read(): RpcBlacklistData | null {
        return this.payload;
    }

    write(data: RpcBlacklistData): void {
        this.payload = data;
    }
}

export function normalizeBlacklistData(raw: unknown): RpcBlacklistData {
    const entries: RpcBlacklistData['entries'] = {};
    if (!raw || typeof raw !== 'object' || !('entries' in raw)) {
        return { entries };
    }
    const src = (raw as { entries: unknown }).entries;
    if (!src || typeof src !== 'object') {
        return { entries };
    }
    for (const [ip, domains] of Object.entries(src as Record<string, unknown>)) {
        if (!Array.isArray(domains)) continue;
        const cleaned = [
            ...new Set(
                domains
                    .filter((d): d is string => typeof d === 'string' && d.trim().length > 0)
                    .map((d) => d.trim().toLowerCase())
            ),
        ];
        if (cleaned.length > 0) {
            entries[ip] = cleaned;
        }
    }
    return { entries };
}

/** Hostname from an RPC URL (lowercase). */
export function extractHostname(rpcUrl: string): string {
    if (!rpcUrl) return '';
    try {
        const host = new URL(rpcUrl.trim()).hostname;
        if (host) return host.toLowerCase();
    } catch {
        // fall through
    }
    let cleaned = rpcUrl.replace(/^https?:\/\//i, '');
    const slash = cleaned.indexOf('/');
    if (slash >= 0) cleaned = cleaned.slice(0, slash);
    const at = cleaned.lastIndexOf('@');
    if (at >= 0) cleaned = cleaned.slice(at + 1);
    const colon = cleaned.indexOf(':');
    if (colon >= 0) cleaned = cleaned.slice(0, colon);
    return cleaned.toLowerCase().trim();
}

/**
 * Registrable-style base domain (last two labels).
 * `eth.drpc.org` / `solana.drpc.org` → `drpc.org`. IPs and single-label hosts unchanged.
 */
export function extractBaseDomain(rpcUrlOrHost: string): string {
    const host = rpcUrlOrHost.includes('://') ? extractHostname(rpcUrlOrHost) : rpcUrlOrHost.toLowerCase().trim();
    if (!host) return '';
    if (isIpLiteral(host)) return host;
    const parts = host.split('.').filter(Boolean);
    if (parts.length <= 1) return host;
    return parts.slice(-2).join('.');
}

function isIpLiteral(host: string): boolean {
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return true;
    if (host.includes(':')) return true; // IPv6 (URL hostname without brackets)
    return false;
}

/** Walk cause chain for TLS / router-hijack style failures (AlphaWallet port). */
export function looksLikeRouterBlock(error: unknown): boolean {
    let cursor: unknown = error;
    let depth = 0;
    while (cursor != null && depth < 8) {
        if (typeof cursor !== 'object') break;
        const err = cursor as {
            name?: string;
            message?: string;
            code?: string | number;
            cause?: unknown;
            reason?: string;
        };

        const name = (err.name ?? '').toLowerCase();
        if (
            name.includes('ssl') ||
            name.includes('tls') ||
            name.includes('certificate') ||
            name === 'certificateverifyerror'
        ) {
            return true;
        }

        const code = err.code != null ? String(err.code) : '';
        if (code && ROUTER_BLOCK_ERROR_CODES.has(code)) {
            return true;
        }
        if (/^ERR_SSL_/i.test(code) || /^ERR_TLS_/i.test(code) || /^CERT_/i.test(code)) {
            return true;
        }

        const message = `${err.message ?? ''} ${err.reason ?? ''}`.toLowerCase();
        if (message && ROUTER_BLOCK_MESSAGE_MARKERS.some((m) => message.includes(m))) {
            return true;
        }

        cursor = err.cause ?? (cursor as { errors?: unknown[] }).errors?.[0];
        depth++;
    }
    return false;
}

export function summarizeThrowable(error: unknown): string {
    const parts: string[] = [];
    let cursor: unknown = error;
    let depth = 0;
    while (cursor != null && depth < 4) {
        if (typeof cursor !== 'object') {
            parts.push(String(cursor));
            break;
        }
        const err = cursor as { name?: string; message?: string; code?: string | number; cause?: unknown };
        const label = [err.name, err.code != null ? String(err.code) : '', err.message]
            .filter(Boolean)
            .join(': ');
        if (label) parts.push(label);
        cursor = err.cause;
        depth++;
    }
    const out = parts.join(' | ') || 'unknown';
    return out.length > 480 ? out.slice(0, 480) : out;
}

export type BlockedRpcStoreOptions = {
    storage: RpcBlacklistStorage;
    /** Override external IP lookup (tests). */
    fetchExternalIp?: () => Promise<string>;
};

/**
 * Detects router/ISP blocks and persists base domains keyed by external IP.
 */
export class BlockedRpcStore {
    private readonly storage: RpcBlacklistStorage;
    private readonly fetchExternalIpFn: () => Promise<string>;

    private cachedExternalIp: string | null = null;
    private ipFetchedAt = 0;
    private ipFetchInFlight: Promise<string> | null = null;

    private readonly sessionBlockedDomains = new Set<string>();
    private blockedForCurrentIp = new Set<string>();
    private loadedIp: string | null = null;

    constructor(options: BlockedRpcStoreOptions) {
        this.storage = options.storage;
        this.fetchExternalIpFn = options.fetchExternalIp ?? defaultFetchExternalIp;
    }

    /** Drop URLs whose base domain is blocked for the current IP. Never returns empty if that would disable the chain. */
    filterBlocked(urls: string[]): string[] {
        if (urls.length === 0) return urls;
        this.ensureBlockedCacheLoaded();
        const kept = urls.filter((url) => !this.isBlocked(url));
        return kept.length === 0 ? urls : kept;
    }

    isBlocked(rpcUrl: string): boolean {
        const base = extractBaseDomain(rpcUrl);
        if (!base) return false;
        if (this.sessionBlockedDomains.has(base)) return true;
        this.ensureBlockedCacheLoaded();
        return this.blockedForCurrentIp.has(base);
    }

    recordFailureIfBlocked(rpcUrl: string, error: unknown): void {
        if (!looksLikeRouterBlock(error)) return;
        this.recordBlocked(rpcUrl, summarizeThrowable(error));
    }

    recordBlocked(rpcUrl: string, reason: string): void {
        const base = extractBaseDomain(rpcUrl);
        if (!base) return;
        this.sessionBlockedDomains.add(base);
        this.blockedForCurrentIp.add(base);
        console.warn(`[WaterfallRpc] marking RPC base domain blocked: ${base} (${reason})`);
        void this.persistBlocked(base);
    }

    /** Best-effort public IP; cached 1h. Falls back to {@link UNKNOWN_EXTERNAL_IP}. */
    async getExternalIp(): Promise<string> {
        const now = Date.now();
        if (this.cachedExternalIp && now - this.ipFetchedAt < IP_CACHE_MS) {
            return this.cachedExternalIp;
        }
        if (this.ipFetchInFlight) {
            return this.ipFetchInFlight;
        }
        this.ipFetchInFlight = (async () => {
            try {
                const fetched = await this.fetchExternalIpFn();
                this.cachedExternalIp = fetched;
                this.ipFetchedAt = Date.now();
                if (fetched !== this.loadedIp) {
                    this.loadedIp = null;
                    this.ensureBlockedCacheLoaded(fetched);
                }
                return fetched;
            } finally {
                this.ipFetchInFlight = null;
            }
        })();
        return this.ipFetchInFlight;
    }

    /** Kick off IP resolution without blocking callers. */
    warmExternalIp(): void {
        void this.getExternalIp();
    }

    private getExternalIpCachedOrUnknown(): string {
        if (this.cachedExternalIp) return this.cachedExternalIp;
        this.warmExternalIp();
        return UNKNOWN_EXTERNAL_IP;
    }

    private ensureBlockedCacheLoaded(externalIp?: string): void {
        const ip = externalIp ?? this.getExternalIpCachedOrUnknown();
        if (ip === this.loadedIp) return;

        const data = this.storage.read() ?? { entries: {} };
        const loaded = new Set<string>();
        const list = data.entries[ip];
        if (Array.isArray(list)) {
            for (const d of list) {
                if (typeof d === 'string' && d.trim()) {
                    loaded.add(d.trim().toLowerCase());
                }
            }
        }
        for (const d of this.sessionBlockedDomains) {
            loaded.add(d);
        }
        this.blockedForCurrentIp = loaded;
        this.loadedIp = ip;
    }

    private async persistBlocked(baseDomain: string): Promise<void> {
        try {
            const externalIp = await this.getExternalIp();
            this.ensureBlockedCacheLoaded(externalIp);
            const data = this.storage.read() ?? { entries: {} };
            const existing = new Set(data.entries[externalIp] ?? []);
            existing.add(baseDomain);
            data.entries[externalIp] = [...existing];
            this.storage.write(data);
            this.blockedForCurrentIp.add(baseDomain);
        } catch (e) {
            console.error(`[WaterfallRpc] failed to persist blocked RPC ${baseDomain}`, e);
        }
    }
}

async function defaultFetchExternalIp(): Promise<string> {
    try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 5000);
        try {
            const res = await fetch(IPIFY_URL, { signal: controller.signal });
            if (!res.ok) return UNKNOWN_EXTERNAL_IP;
            const ip = (await res.text()).trim();
            if (ip && ip.length < 64 && !ip.includes('<')) {
                return ip;
            }
        } finally {
            clearTimeout(timer);
        }
    } catch {
        // ignore
    }
    return UNKNOWN_EXTERNAL_IP;
}
