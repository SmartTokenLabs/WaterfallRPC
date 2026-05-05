import fs from 'fs';
import path from 'path';
import type { RpcDataStorage } from './rpcCacheStorage';
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
