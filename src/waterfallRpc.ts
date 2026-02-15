//UniversalRPC will load all the rpcs from https://chainlist.org/rpcs.json, it will store them in a JSON together with the storage date
//WaterfallRpc will provide a method to get a working provider for a given chainId

import { ethers, PerformActionRequest } from 'ethers';
import fs from 'fs';
import path from 'path';

interface RPCConfig {
    name: string;
    chainId: number;
    chainSlug: string;
    checked: boolean;
    nativeCurrency: {
        name: string;
        symbol: string;
        decimals: number;
    };
    rpcs: {
        url: string;
    }[];
}

interface RPCData {
    entries: { [key: number]: RPCConfig };
    date: string;
}

interface ProgressEvent {
    current: number;
    total: number;
    url: string;
    status: 'checking' | 'success' | 'failed';
}

type ProgressCallback = (event: ProgressEvent) => void;

// Built-in progress display function
function defaultProgressDisplay(event: ProgressEvent): void {
    const percentage = (event.current / event.total) * 100;
    const barLength = 20;
    const filledLength = Math.round((event.current / event.total) * barLength);
    const bar = '█'.repeat(filledLength) + '░'.repeat(barLength - filledLength);
    
    // Clear the current line and move cursor to start
    process.stdout.write('\r\x1b[K');
    
    // Show progress bar
    process.stdout.write(`${bar} ${percentage.toFixed(1)}% | ${event.current}/${event.total} | ${event.url} | ${event.status}`);
    
    // If this is the last item, clear the line and move up
    if (event.current === event.total) {
        process.stdout.write('\r\x1b[K\x1b[1A\x1b[K');
    }
}

class UniversalRpc {
    private readonly rpcFilePath: string = path.join(process.cwd(), '.rpcdata');
    private readonly updateInterval: number = 7 * 24 * 60 * 60 * 1000; // update every week

    private constructor() {
        //create directories if they don't exist
        const dir = path.dirname(this.rpcFilePath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
    }

    public static async getInstance(): Promise<UniversalRpc> {
        const instance = new UniversalRpc();
        await instance.init();
        return instance;
    }

    public async downloadRpcs(): Promise<void> {
        try {
            const response = await fetch('https://chainlist.org/rpcs.json');
            const data = await response.json();

            const rpcsToStore = data.map((rpc: any) => ({
                name: rpc.name,
                chainId: rpc.chainId,
                chainSlug: rpc.chainSlug,
                nativeCurrency: rpc.nativeCurrency,
                checked: false,
                rpcs: rpc.rpc
                    .filter((rpc: any) => rpc.url.startsWith('https://'))
                    .map((rpc: any) => ({
                        url: rpc.url
                    }))
            }));

            const storedData: RPCData = {
                entries: {},
                date: new Date().toISOString()
            };

            rpcsToStore.forEach((rpc: RPCConfig) => {
                storedData.entries[rpc.chainId] = rpc;
            });

            fs.writeFileSync(this.rpcFilePath, JSON.stringify(storedData, null, 2));
        } catch (error) {
            console.error('Error downloading RPCs:', error);
            throw error;
        }
    }

    private loadRpcs(): RPCData {
        try {
            return JSON.parse(fs.readFileSync(this.rpcFilePath, 'utf8'));
        } catch (error) {
            console.error('Error loading RPCs:', error);
            throw error;
        }
    }

    public needUpdate(updateInterval: number): boolean {
        if (!fs.existsSync(this.rpcFilePath)) {
            return true;
        }
        return new Date().getTime() - new Date(this.loadRpcs().date).getTime() > updateInterval;
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
        const data: RPCData = JSON.parse(fs.readFileSync(this.rpcFilePath, 'utf8'));
        data.entries[chainId].rpcs = providers.map(url => ({ url }));
        data.entries[chainId].checked = true;
        fs.writeFileSync(this.rpcFilePath, JSON.stringify(data, null, 2));
    }
}

export class WaterfallRpc extends ethers.JsonRpcProvider {
    private providers: Array<ethers.JsonRpcProvider>;

    private constructor(chainId: number, rpcManager: UniversalRpc) {
        const rpcConfig = rpcManager.getRPC(chainId);
        if (!rpcConfig) {
            throw new Error(`No RPC configuration found for chainId ${chainId}`);
        }

        super(rpcConfig.rpcs[0].url, chainId, {
            batchMaxCount: 1,
            staticNetwork: true
        });

        this.providers = [];
    }

    public static async createProvider(chainId: number, onProgress: ProgressCallback = defaultProgressDisplay): Promise<WaterfallRpc> {
        const rpcManager = await UniversalRpc.getInstance();
        const instance = new WaterfallRpc(chainId, rpcManager);
        const rpcConfig = rpcManager.getRPC(chainId);

        if (!rpcConfig) {
            throw new Error(`No RPC configuration found for chainId ${chainId}`);
        }

        const providers = rpcConfig.rpcs.map(rpc => 
            new ethers.JsonRpcProvider(rpc.url, chainId, {
                batchMaxCount: 1,
                staticNetwork: true
            })
        );

        instance.providers = await instance.setupProviders(chainId, rpcManager, rpcConfig, providers, onProgress);
        return instance;
    }

    public static async resetProviders(timeout: number = 1000 * 60 * 60 * 24 * 7) {
        const rpcManager = await UniversalRpc.getInstance();
        if (rpcManager.needUpdate(timeout)) {
            await rpcManager.downloadRpcs();
        }
    }

    // This function does have a potential side effect of updating the working providers in the UniversalRpc class
    private async setupProviders(chainId: number, rpcManager: UniversalRpc, rpcConfig: RPCConfig, providers: Array<ethers.JsonRpcProvider>, onProgress?: ProgressCallback): Promise<Array<ethers.JsonRpcProvider>>{
        let workingProviders = providers;
        let workingUrls: Array<string> = [];

        if (!rpcConfig.checked) {
            ({ workingProviders, workingUrls } = await this.checkProviders(providers, onProgress));
            if (workingProviders.length < providers.length) {
                await rpcManager.updateWorkingProviders(chainId, workingUrls);
            }
        }

        return workingProviders;
    }

    private async checkProviders(providers: Array<ethers.JsonRpcProvider>, onProgress?: ProgressCallback): Promise<{ workingProviders: Array<ethers.JsonRpcProvider>, workingUrls: Array<string> }> {
        const workingProviders: Array<ethers.JsonRpcProvider> = [];
        const workingUrls: Array<string> = [];
        const total = providers.length;

        for (let i = 0; i < providers.length; i++) {
            const provider = providers[i];
            const url = (provider as any)._getConnection().url;

            if (onProgress) {
                onProgress({
                    current: i + 1,
                    total,
                    url,
                    status: 'checking'
                });
            }

            try {
                const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout after 5 seconds')), 5000));
                const blockNumber = await Promise.race([
                    provider.getBlockNumber(),
                    timeout
                ]) as number;

                if (blockNumber > 0) {
                    workingProviders.push(provider);
                    workingUrls.push(url);
                    if (onProgress) {
                        onProgress({
                            current: i + 1,
                            total,
                            url,
                            status: 'success'
                        });
                    }
                }
            } catch (e) {
                if (onProgress) {
                    onProgress({
                        current: i + 1,
                        total,
                        url,
                        status: 'failed'
                    });
                }
            }
        }

        if (workingProviders.length == 0) {
            throw new Error('No working providers found');
        }

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
// const provider = await WaterfallRpc.createProvider(84532); // For Base Sepolia