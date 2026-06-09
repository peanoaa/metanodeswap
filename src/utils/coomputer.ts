import { useMemo } from 'react'
import { useReadContracts } from 'wagmi'
import { erc20Abi, formatUnits, type Address } from 'viem'

const Q96 = 2 ** 96

/** tick 对应的链上原始价格比 (token1 最小单位 / token0 最小单位) */
function tickToRawPrice(tick: number): number {
    return 1.0001 ** tick
}

/** 根据decimals转换价格 (每 1 个 token0 可换多少 token1) */
export function rawPriceToHuman(rawPrice: number, decimals0: number, decimals1: number): number {
    return rawPrice * 10 ** (decimals0 - decimals1)
}

/** tick 价格 */
export function tickToHumanPrice(
    tick: number,
    decimals0: number,
    decimals1: number,
    fixedDigits = 4
): string {
    const human = rawPriceToHuman(tickToRawPrice(tick), decimals0, decimals1)
    if (!Number.isFinite(human)) return '—'
    return human.toFixed(fixedDigits)
}

/** sqrtPriceX96 转换 */
export function sqrtPriceX96ToHumanPrice(
    sqrtPriceX96: bigint,
    decimals0: number,
    decimals1: number,
    fixedDigits = 2
): string {
    const raw = (Number(sqrtPriceX96) / Q96) ** 2
    const human = rawPriceToHuman(raw, decimals0, decimals1)
    if (!Number.isFinite(human)) return '—'
    return human.toFixed(fixedDigits)
}

export function usePoolTokens(pools: PoolRawData[] | undefined) {
    const contracts = useMemo(() => {
        if (!pools) return [];
        //读取池子中的token0,token1,decimals,balanceOf
        return pools.flatMap((p) => [
            { address: p.token0, abi: erc20Abi, functionName: 'symbol' },
            { address: p.token1, abi: erc20Abi, functionName: 'symbol' },
            { address: p.token0, abi: erc20Abi, functionName: 'decimals' },
            { address: p.token1, abi: erc20Abi, functionName: 'decimals' },
            { address: p.token0, abi: erc20Abi, functionName: 'balanceOf', args: [p.pool] },
            { address: p.token1, abi: erc20Abi, functionName: 'balanceOf', args: [p.pool] },
        ])
    }, [pools])

    //批量读取合约数据
    const { data: results, isLoading, error } = useReadContracts({
        contracts,
        query: {
            enabled: !!contracts.length,
        }
    })

    console.log(results, '++++++++++++++++++++');

    //生成表格数据
    const rows = useMemo(() => {
        if (!pools?.length || !results) return []

        return pools.map((p, i) => {
            const b = i * 6
            const ok = (idx: number) =>
                results[idx]?.status === 'success' ? results[idx].result : undefined

            const symbol0 = ok(b + 0) as string | undefined
            const symbol1 = ok(b + 1) as string | undefined
            const decimals0 = Number(ok(b + 2) ?? 18)
            const decimals1 = Number(ok(b + 3) ?? 18)
            const balance0 = ok(b + 4) as bigint | undefined
            const balance1 = ok(b + 5) as bigint | undefined
            const fmt = (sym?: string, bal?: bigint, dec = 18) => {
                const s = sym ?? '???'
                if (bal === undefined) return `${s} (—)`
                const num = Number(formatUnits(bal, dec))
                const fixed = Number.isFinite(num) ? num.toFixed(2) : '—'
                return `${s} (${fixed})`
            }
            const token = `${fmt(symbol0, balance0, decimals0)} / ${fmt(symbol1, balance1, decimals1)}`

            const feePercent = (p.fee / 10000).toFixed(2) + '%';

            const tickLowerPrice = tickToHumanPrice(p.tickLower, decimals0, decimals1)
            const tickUpperPrice = tickToHumanPrice(p.tickUpper, decimals0, decimals1)
            const pricerange = `${tickLowerPrice}-${tickUpperPrice}`
            const currentprice = sqrtPriceX96ToHumanPrice(p.sqrtPriceX96, decimals0, decimals1)
            return {
                ...p,
                token,
                pricerange,
                currentprice,
                feePercent

            }
        })
    }, [pools, results])


    console.log(rows, '-----------------------------------------');
    //把rows数据存储到全局poolsData中
    poolsData = rows;
    return { rows, isLoading }

}

// usePoolTokens 写入的池子展示数据，供 Position 页合并
let poolsData: PoolRowData[] = [];

// // geAllPool数据类型定义
export interface PoolRawData {
    pool: Address
    token0: Address
    token1: Address
    index: number
    fee: number
    feeProtocol: number
    tickLower: number
    tickUpper: number
    tick: number
    sqrtPriceX96: bigint
    liquidity: bigint
}

export type PoolRowData = PoolRawData & {
    token: string
    pricerange: string
    currentprice: string
    feePercent: string
}






// //转成biging
function toBigInt(v: bigint | string | number): bigint {
    return typeof v === 'bigint' ? v : BigInt(v)
}
// //整理数据格式
export function normalizePools(pools: unknown): PoolRawData[] {
    if (!pools) return [];
    const list = Array.isArray(pools) ? pools : Object.values(pools as Record<string, unknown>);
    return list.map((raw) => {
        const item = raw as Record<string, unknown>
        return {
            pool: item.pool as Address,
            token0: item.token0 as Address,
            token1: item.token1 as Address,
            index: Number(item.index),
            fee: Number(item.fee),
            feeProtocol: Number(item.feeProtocol),
            tickLower: Number(item.tickLower),
            tickUpper: Number(item.tickUpper),
            tick: Number(item.tick),
            sqrtPriceX96: toBigInt(item.sqrtPriceX96 as bigint | string | number),
            liquidity: toBigInt(item.liquidity as bigint | string | number),
        }
    })
}
// //getPosition数据类型
export interface PositionRawData {
    id: string;                       // position ID (NFT tokenId)
    owner: Address;                    // string 类型
    token0: Address;                   // token0 address
    token1: Address;                   // token1 address
    index: number
    fee: number;                      // fee (如 "3000" = 0.3%)
    liquidity: bigint;                // 流动性数量 (bigint 字符串)
    tickLower: number;               // 价格下限 tick (可为负数)
    tickUpper: number;               // 价格上限 tick
    tokensOwed0: bigint;             // 待领取的 token0 数量
    tokensOwed1: bigint;             // 待领取的 token1 数量
    feeGrowthInside0LastX128: bigint;
    feeGrowthInside1LastX128: bigint;
}


export function normalizePosition(pools: unknown): PositionRawData[] {
    if (!pools) return [];
    const list = Array.isArray(pools) ? pools : Object.values(pools as Record<string, unknown>);
    return list.map((raw) => {
        const item = raw as Record<string, unknown>
        return {
            id: item.id as string,
            owner: item.owner as Address,
            token0: item.token0 as Address,
            token1: item.token1 as Address,
            index: Number(item.index),
            fee: Number(item.fee),
            liquidity: toBigInt(item.liquidity as bigint | string | number),
            tickLower: Number(item.tickLower),
            tickUpper: Number(item.tickUpper),
            tokensOwed0:toBigInt(item.tokensOwed0 as bigint | string | number),
            tokensOwed1:toBigInt(item.tokensOwed1 as bigint | string | number),
            feeGrowthInside0LastX128:toBigInt(item.feeGrowthInside0LastX128 as bigint | string | number),
            feeGrowthInside1LastX128:toBigInt(item.feeGrowthInside1LastX128 as bigint | string | number),
        }
    })
}


export type PositionRowData = PositionRawData & {
    token?: string
    pricerange?: string
    currentprice?: string
    feePercent?: string
}

function isSamePoolKey(
    a: { token0: Address; token1: Address; index: number },
    b: { token0: Address; token1: Address; index: number }
) {
    return (
        a.token0.toLowerCase() === b.token0.toLowerCase() &&
        a.token1.toLowerCase() === b.token1.toLowerCase() &&
        a.index === b.index
    )
}

/** 用 token0 + token1 + index 与 poolsData 匹配，合并池子展示字段 */
export function PositionData(positions: PositionRawData[]): PositionRowData[] {
    if (!positions?.length) return []

    return positions.map((pos) => {
        const { token0, token1, index } = pos
        const pool = poolsData.find((p) => isSamePoolKey(p, { token0, token1, index }))

        if (!pool) {
            return { ...pos }
        }

        return {
            ...pos,
            token: pool.token,
            pricerange: pool.pricerange,
            currentprice: pool.currentprice,
            feePercent: pool.feePercent,
        }
    })
}