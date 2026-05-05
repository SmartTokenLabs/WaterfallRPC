import type { RpcDataStorage } from './rpcCacheStorage';
import type { RPCData } from './rpcDataTypes';

/**
 * Published builds point the `browser` field here so bundlers never parse `fs`/`path`.
 * In the browser, `getDefaultRpcStorage()` uses localStorage first; this class is never constructed.
 */
export class FilesystemRpcStorage implements RpcDataStorage {
    constructor() {
        throw new Error('@smarttokenlabs/waterfall-rpc: FilesystemRpcStorage is not for browser runtimes');
    }

    exists(): boolean {
        return false;
    }

    read(): RPCData | null {
        return null;
    }

    write(data: RPCData): void {
        void data;
    }
}
