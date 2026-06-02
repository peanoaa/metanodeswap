

// geAllPool数据类型定义
export interface PoolRawData {
    fee: number;
    feeProtocol: number;
    index: number;
    liquidity: bigint;
    pool: string;
    sqrtPriceX96: bigint;
    tick: number;
    tickLower: number;
    tickUpper: number;
    token0: string;
    token1: string;
}

export function transformPoolData(raw: PoolRawData): {
    id: string;
    token: string;
    free: string;
    range: string;
    currentprice: string;
    liquidity: string;
} {
    // 1. fee 转百分比：3000 → "0.30%"
    const feePercent = (raw.fee / 10000).toFixed(2) + '%';

    // 2. sqrtPriceX96 解码为价格
    const Q96 = Math.pow(2, 96);
    const price = (Number(raw.sqrtPriceX96) / Q96) ** 2;

    // 3. 格式化流动性
    const formatLiq = (liq: bigint): string => {
        const num = Number(liq);
        if (num >= 1e12) return `${(num / 1e12).toFixed(2)}T`;
        if (num >= 1e9) return `${(num / 1e9).toFixed(2)}B`;
        if (num >= 1e6) return `${(num / 1e6).toFixed(2)}M`;
        if (num >= 1e3) return `${(num / 1e3).toFixed(2)}K`;
        return num.toLocaleString();
    };

    // 4. Token 显示（先用地址截断，后续可查名称）
    const shortenAddress = (addr: string) => 
        `${addr.slice(0, 6)}...${addr.slice(-4)}`;

    return {
        id: raw.pool,                    // 用 pool 地址作为 ID
        token: `${shortenAddress(raw.token0)} / ${shortenAddress(raw.token1)}`,
        free: feePercent,
        range: `${raw.tickLower} ~ ${raw.tickUpper}`,
        currentprice: price.toFixed(2),
        liquidity: formatLiq(raw.liquidity),
    };
}


//getPosition数据类型
export interface PositionRawData {
    owner: string;                    // string 类型
    id: string;                       // position ID (NFT tokenId)
    owner_address: string;            // owner address
    token0: string;                   // token0 address
    token1: string;                   // token1 address
    index: string;                    // index
    fee: string;                      // fee (如 "3000" = 0.3%)
    liquidity: string;                // 流动性数量 (bigint 字符串)
    tickLower: string;               // 价格下限 tick (可为负数)
    tickUpper: string;               // 价格上限 tick
    tokensOwed0: string;             // 待领取的 token0 数量
    tokensOwed1: string;             // 待领取的 token1 数量
    feeGrowthInside0LastX128: string;
    feeGrowthInside1LastX128: string;
}
export interface PositionDisplayData {
    id: string;
    token: string;
    free: string;
    range: string;
    liquidity: string;
    unclaimed: string;           // 未领取代币
}
export function transformPositionData(raw: PositionRawData): PositionDisplayData {
    // 1. fee 转百分比：3000 → "0.30%", 10000 → "1.00%"
    const feePercent = (Number(raw.fee) / 10000).toFixed(2) + '%';

    // 2. 格式化流动性（支持大数字）
    const formatLiq = (val: string): string => {
        const num = Number(val);
        if (num >= 1e12) return `${(num / 1e12).toFixed(2)}T`;
        if (num >= 1e9) return `${(num / 1e9).toFixed(2)}B`;
        if (num >= 1e6) return `${(num / 1e6).toFixed(2)}M`;
        if (num >= 1e3) return `${(num / 1e3).toFixed(2)}K`;
        return num.toLocaleString();
    };

    // 3. Token 地址截断显示
    const shortenAddress = (addr: string) =>
        `${addr.slice(0, 6)}...${addr.slice(-4)}`;

    // 4. 格式化未领取代币
    const formatUnclaimed = (): string => {
        const t0 = Number(raw.tokensOwed0);
        const t1 = Number(raw.tokensOwed1);
        if (t0 === 0 && t1 === 0) return '0';
        
        const parts: string[] = [];
        if (t0 > 0) {
            if (t0 >= 1e6) parts.push(`${(t0 / 1e6).toFixed(2)}M`);
            else if (t0 >= 1e3) parts.push(`${(t0 / 1e3).toFixed(2)}K`);
            else parts.push(t0.toFixed(4));
        }
        if (t1 > 0) {
            if (t1 >= 1e6) parts.push(`${(t1 / 1e6).toFixed(2)}M`);
            else if (t1 >= 1e3) parts.push(`${(t1 / 1e3).toFixed(2)}K`);
            else parts.push(t1.toFixed(4));
        }
        return parts.join(' / ');
    };

    return {
        id: raw.id,                                      // Position ID (NFT ID)
        token: `${shortenAddress(raw.token0)} / ${shortenAddress(raw.token1)}`,
        free: feePercent,                                // 费率
        range: `${raw.tickLower} ~ ${raw.tickUpper}`,   // 价格范围
        liquidity: formatLiq(raw.liquidity),            // 流动性
        unclaimed: formatUnclaimed(),                    // 未领取代币
    };
}





