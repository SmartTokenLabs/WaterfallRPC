import fs from 'fs';
import path from 'path';
import type { RpcDataStorage } from './rpcCacheStorage';
import {
    normalizeBlacklistData,
    type RpcBlacklistData,
    type RpcBlacklistStorage,
} from './rpcBlacklist';
import type { RPCData } from './rpcDataTypes';

/** Node: JSON file next to cwd (same location as the original library). */
export class FilesystemRpcStorage implements RpcDataStorage {
    readonly filePath: string;

    constructor() {
        this.filePath = path.join(process.cwd(), '.rpcdata');
        const dir = path.dirname(this.filePath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
    }

    exists(): boolean {
        return fs.existsSync(this.filePath);
    }

    read(): RPCData | null {
        try {
            return JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as RPCData;
        } catch {
            return null;
        }
    }

    write(data: RPCData): void {
        fs.writeFileSync(this.filePath, JSON.stringify(data, null, 2));
    }
}

/** Node: ISP/router blocked RPC base domains keyed by external IP (`.rpcblacklist`). */
export class FilesystemRpcBlacklistStorage implements RpcBlacklistStorage {
    readonly filePath: string;

    constructor() {
        this.filePath = path.join(process.cwd(), '.rpcblacklist');
        const dir = path.dirname(this.filePath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
    }

    exists(): boolean {
        return fs.existsSync(this.filePath);
    }

    read(): RpcBlacklistData | null {
        try {
            return normalizeBlacklistData(JSON.parse(fs.readFileSync(this.filePath, 'utf8')));
        } catch {
            return null;
        }
    }

    write(data: RpcBlacklistData): void {
        fs.writeFileSync(this.filePath, JSON.stringify(data, null, 2));
    }
}
