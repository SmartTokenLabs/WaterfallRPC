export interface RPCConfig {
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

export interface RPCData {
    entries: { [key: number]: RPCConfig };
    date: string;
}

export interface ProgressEvent {
    current: number;
    total: number;
    url: string;
    status: 'checking' | 'success' | 'failed';
}
