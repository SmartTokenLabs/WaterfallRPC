import type { RPCData } from './rpcDataTypes';

export type { RPCData } from './rpcDataTypes';

/** Persists the merged RPC catalog (rankings + chainlist cache). */
export interface RpcDataStorage {
    exists(): boolean;
    read(): RPCData | null;
    write(data: RPCData): void;
}

const LS_KEY = 'waterfall-rpc:rpc-cache-v1';

/** Browser / extension contexts with `localStorage`. */
export class LocalStorageRpcStorage implements RpcDataStorage {
    constructor(private readonly key: string = LS_KEY) {}

    exists(): boolean {
        try {
            return localStorage.getItem(this.key) != null;
        } catch {
            return false;
        }
    }

    read(): RPCData | null {
        try {
            const raw = localStorage.getItem(this.key);
            if (raw == null) return null;
            return JSON.parse(raw) as RPCData;
        } catch {
            return null;
        }
    }

    write(data: RPCData): void {
        try {
            localStorage.setItem(this.key, JSON.stringify(data));
        } catch (e) {
            console.error('WaterfallRpc: could not write RPC cache to localStorage (quota or private mode).', e);
            throw e;
        }
    }
}

/** No persistence; refetches after each load. Useful for private mode or custom hosts. */
export class MemoryRpcStorage implements RpcDataStorage {
    private payload: RPCData | null = null;

    exists(): boolean {
        return this.payload != null;
    }

    read(): RPCData | null {
        return this.payload;
    }

    write(data: RPCData): void {
        this.payload = data;
    }
}

export function isBrowserLike(): boolean {
    return typeof globalThis !== 'undefined' && typeof (globalThis as { localStorage?: Storage }).localStorage !== 'undefined';
}
