//UniversalRPC will load all the rpcs from https://chainlist.org/rpcs.json, it will store them in a JSON together with the storage date
//WaterfallRpc will provide a method to get a working provider for a given chainId

import { ethers, PerformActionRequest } from 'ethers';
import fs from 'fs';
import path from 'path';

interface RPCConfig {
    name: string;
    chainId: number;
    chainSlug: string;
    nativeCurrency: {
        name: string;
        symbol: string;
        decimals: number;
    };
    rpcs: {
        url: string;
    }[];
}

interface StoredRPCs {
    entries: { [key: number]: RPCConfig };
    date: string;
}

class UniversalRPC {
    private rpcEntries: { [key: number]: RPCConfig } = {};
    private rpcEntriesDate: string = '';
    private readonly rpcFilePath: string = path.join(process.cwd(), '.rpcdata');
    private readonly updateInterval: number = 7 * 24 * 60 * 60 * 1000; // update every week

    private constructor() {
        //create directories if they don't exist
        const dir = path.dirname(this.rpcFilePath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
    }

    public static async getInstance(): Promise<UniversalRPC> {
        const instance = new UniversalRPC();
        await instance.init();
        return instance;
    }

    private async downloadRpcs(): Promise<void> {
        try {
            const response = await fetch('https://chainlist.org/rpcs.json');
            const data = await response.json();

            const rpcsToStore = data.map((rpc: any) => ({
                name: rpc.name,
                chainId: rpc.chainId,
                chainSlug: rpc.chainSlug,
                nativeCurrency: rpc.nativeCurrency,
                rpcs: rpc.rpc
                    .filter((rpc: any) => rpc.url.startsWith('https://'))
                    .map((rpc: any) => ({
                        url: rpc.url
                    }))
            }));

            const storedData: StoredRPCs = {
                entries: {},
                date: new Date().toISOString()
            };

            rpcsToStore.forEach((rpc: RPCConfig) => {
                storedData.entries[rpc.chainId] = rpc;
            });

            fs.writeFileSync(this.rpcFilePath, JSON.stringify(storedData, null, 2));
            this.rpcEntries = storedData.entries;
            this.rpcEntriesDate = storedData.date;
        } catch (error) {
            console.error('Error downloading RPCs:', error);
            throw error;
        }
    }

    private loadRpcs(): void {
        try {
            const data: StoredRPCs = JSON.parse(fs.readFileSync(this.rpcFilePath, 'utf8'));
            this.rpcEntries = data.entries;
            this.rpcEntriesDate = data.date;
        } catch (error) {
            console.error('Error loading RPCs:', error);
            throw error;
        }
    }

    private needUpdate(): boolean {
        if (!fs.existsSync(this.rpcFilePath)) {
            return true;
        }
        return new Date().getTime() - new Date(this.rpcEntriesDate).getTime() > this.updateInterval;
    }

    private async init(): Promise<void> {
        if (this.needUpdate()) {
            await this.downloadRpcs();
        } else {
            this.loadRpcs();
        }
    }

    public getRPC(chainId: number): RPCConfig | undefined {
        return this.rpcEntries[chainId];
    }

    public async updateWorkingProviders(chainId: number, providers: Array<string>): Promise<void> {
        const data: StoredRPCs = JSON.parse(fs.readFileSync(this.rpcFilePath, 'utf8'));
        data.entries[chainId].rpcs = providers.map(url => ({ url }));
        fs.writeFileSync(this.rpcFilePath, JSON.stringify(data, null, 2));
    }
}

export class WaterfallRpc extends ethers.JsonRpcProvider {
    private providers: Array<ethers.JsonRpcProvider>;

    private constructor(chainId: number, rpcManager: UniversalRPC) {
        const rpcConfig = rpcManager.getRPC(chainId);
        if (!rpcConfig) {
            throw new Error(`No RPC configuration found for chainId ${chainId}`);
        }

        super(rpcConfig.rpcs[0].url, chainId, {
            batchMaxCount: 1,
            staticNetwork: true
        });

        this.providers = rpcConfig.rpcs.map(rpc => 
            new ethers.JsonRpcProvider(rpc.url, chainId, {
                batchMaxCount: 1,
                staticNetwork: true
            })
        );
    }

    public static async create(chainId: number): Promise<WaterfallRpc> {
        const rpcManager = await UniversalRPC.getInstance();
        const instance = new WaterfallRpc(chainId, rpcManager);
        const { workingProviders, workingUrls } = await instance.checkProviders();
        instance.providers = workingProviders;
        await rpcManager.updateWorkingProviders(chainId, workingUrls);
        return instance;
    }

    private async checkProviders(): Promise<{ workingProviders: Array<ethers.JsonRpcProvider>, workingUrls: Array<string> }> {
        const workingProviders: Array<ethers.JsonRpcProvider> = [];
        const workingUrls: Array<string> = [];

        //console.log(`Checking ${this.providers.length} providers`);
        for (const provider of this.providers) {
            try {
                const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout after 5 seconds')), 5000));
                const blockNumber = await Promise.race([
                    provider.getBlockNumber(),
                    timeout
                ]) as number;

                if (blockNumber > 0) {
                    workingProviders.push(provider);
                    workingUrls.push((provider as any)._getConnection().url);
                }
            } catch (e) {
                // silent fail, expected
            }
        }

        if (workingProviders.length == 0) {
            throw new Error('No working providers found');
        }

        //console.log(`Found ${workingProviders.length} working providers`);
        return { workingProviders, workingUrls };
    }

    async _perform(req: PerformActionRequest): Promise<any> {
        const errors = []

        //randomise the start index
        const startIndex = Math.floor(Math.random() * this.providers.length);

        for (let i = 0; i < this.providers.length; i++) {
            const provider = this.providers[(startIndex + i) % this.providers.length];
            try {
                if (errors.length > 0) {
                    await new Promise(resolve => setTimeout(resolve, 5000));
                }
                
                return await provider._perform(req);
            } catch (e: any) {
                if (e?.code === 'CALL_EXCEPTION') {
                    throw e;
                }
                errors.push(e);
            }
        }

        throw errors[0];
    }
}

// Example usage:
// const provider = await WaterfallFallbackProvider.create(84532); // For Base Sepolia