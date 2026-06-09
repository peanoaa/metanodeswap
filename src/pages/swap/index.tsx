/**
 * Swap 页：参考 Position 弹窗样式，完成 token 兑换。
 * 链上流程：选 tokenIn → tokenOut → 按现货兑换比例排序可换池 → 输入金额 → quote → approve → swap
 * indexPath 从高到低排列；合约从前向后逐池兑换，直到 amount 耗尽或全部尝试完毕。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { PoolManagerAbi } from '../../abi/PoolManager'
import { SwapRouterAbi } from '../../abi/SwapRouter'
import {
    useAccount,
    useConfig,
    useReadContract,
    useReadContracts,
    useWriteContract,
    useWaitForTransactionReceipt,
    type Config,
} from 'wagmi'
import { readContract, simulateContract } from 'wagmi/actions'
import { normalizePools, type PoolRawData } from '../../utils/coomputer'
import { erc20Abi, formatUnits, type Address, parseUnits } from 'viem'

const PoolManagerAddress = '0xddC12b3F9F7C91C79DA7433D8d212FB78d609f7B'

const SwapRouterAddress = '0xD2c220143F5784b3bD84ae12747d97C8A36CeCB2' as Address

type Pair = {
    token0: Address
    token1: Address
}
type TokenOption = {
    label: string
    value: Address
}
type RouteCandidate = {
    tokenPath: string[]
    /** 传给 SwapRouter 的池子 index 序列，同跳多池时按优先级依次尝试 */
    indexPath: number[]
    pools: PoolRawData[]
    /** 每一跳在 indexPath 中占用的池子数量，如 [4] 或 [2, 1] */
    hopPoolCounts: number[]
}
type TxStep = 'idle' | 'approve' | 'swap'
type QuoteMode = 'exactInput' | 'exactOutput'

//获取token流动性，用于排序池子
function liquidityForToken(addr: string, pools: PoolRawData[]): bigint {
    const lower = addr.toLowerCase()
    let total = 0n
    for (const p of pools) {
        if (p.token0.toLowerCase() === lower || p.token1.toLowerCase() === lower) {
            total += p.liquidity
        }
    }
    return total
}

//获取token地址
function canonicalAddr(addr: string, addressToCanonical: Map<string, Address>): Address {
    return addressToCanonical.get(addr.toLowerCase()) ?? (addr as Address)
}

//构建交易对列表
function buildCanonicalPairList(
    pairList: Pair[],
    addressToCanonical: Map<string, Address>
): Pair[] {
    const seen = new Set<string>()
    const pairs: Pair[] = []
    for (const p of pairList) {
        const token0 = canonicalAddr(p.token0, addressToCanonical)
        const token1 = canonicalAddr(p.token1, addressToCanonical)
        if (token0.toLowerCase() === token1.toLowerCase()) continue
        const key = [token0.toLowerCase(), token1.toLowerCase()].sort().join('-')
        if (seen.has(key)) continue
        seen.add(key)
        pairs.push({ token0, token1 })
    }
    return pairs
}

//获取池子token地址
function poolTokenForCanonical(
    canonical: string,
    pool: PoolRawData,
    addressToCanonical: Map<string, Address>
): Address {
    const target = canonical.toLowerCase()
    if (canonicalAddr(pool.token0, addressToCanonical).toLowerCase() === target) {
        return pool.token0
    }
    if (canonicalAddr(pool.token1, addressToCanonical).toLowerCase() === target) {
        return pool.token1
    }
    return canonical as Address
}

//获取交易路径token地址
function routerTokensForRoute(
    route: RouteCandidate,
    canonicalIn: Address,
    canonicalOut: Address,
    addressToCanonical: Map<string, Address>
) {
    const tokenIn = poolTokenForCanonical(canonicalIn, route.pools[0], addressToCanonical)
    const lastPool = route.pools[route.pools.length - 1]
    const tokenOut = poolTokenForCanonical(canonicalOut, lastPool, addressToCanonical)
    return { tokenIn, tokenOut }
}

/** 仅查找 tokenIn → tokenOut 的直连路径，不支持经中间 token 中转 */
function findTokenPaths(tokenIn: string, tokenOut: string, pairList: Pair[]): string[][] {
    const start = tokenIn.toLowerCase()
    const end = tokenOut.toLowerCase()
    if (start === end) return []

    const hasDirect = pairList.some(
        (p) =>
            (p.token0.toLowerCase() === start && p.token1.toLowerCase() === end) ||
            (p.token1.toLowerCase() === start && p.token0.toLowerCase() === end)
    )
    return hasDirect ? [[start, end]] : []
}

//获取池子列表
function getPoolsForTokens(
    tokenA: string,
    tokenB: string,
    allPools: PoolRawData[],
    addressToCanonical: Map<string, Address>
): PoolRawData[] {
    const al = tokenA.toLowerCase()
    const bl = tokenB.toLowerCase()
    const match = (poolAddr: string, target: string) =>
        canonicalAddr(poolAddr, addressToCanonical).toLowerCase() === target
    return allPools.filter(
        (p) =>
            (match(p.token0, al) && match(p.token1, bl)) ||
            (match(p.token1, al) && match(p.token0, bl))
    )
}

function isPoolSwappable(
    canonicalIn: string,
    pool: PoolRawData,
    addressToCanonical: Map<string, Address>
): boolean {
    if (pool.liquidity === 0n) return false
    if (pool.tick <= pool.tickLower || pool.tick >= pool.tickUpper) return false
    return getSwapBlockReason(canonicalIn, pool, addressToCanonical) === null
}

/** 池子当前现货兑换比例：1 单位 tokenIn 可换多少 tokenOut（基于 tick） */
function poolSpotExchangeRatio(
    canonicalIn: string,
    pool: PoolRawData,
    addressToCanonical: Map<string, Address>
): number {
    const zeroForOne = isZeroForOne(canonicalIn, pool, addressToCanonical)
    return zeroForOne ? 1.0001 ** pool.tick : 1.0001 ** -pool.tick
}

/** 过滤不可换池，按现货兑换比例从高到低排序 */
function sortPoolsForHop(
    canonicalIn: string,
    pools: PoolRawData[],
    addressToCanonical: Map<string, Address>
): PoolRawData[] {
    return pools
        .filter((p) => isPoolSwappable(canonicalIn, p, addressToCanonical))
        .sort(
            (a, b) =>
                poolSpotExchangeRatio(canonicalIn, b, addressToCanonical) -
                poolSpotExchangeRatio(canonicalIn, a, addressToCanonical)
        )
}

/**
 * 为一条 token 路径构建 indexPath：每一跳的可换池按兑换比例从高到低串入，
 * 合约从前向后逐池兑换直至 amount 耗尽。
 */
function buildRouteWithPoolFallback(
    tokenPath: string[],
    allPools: PoolRawData[],
    addressToCanonical: Map<string, Address>
): RouteCandidate | null {
    if (tokenPath.length < 2) return null

    const indexPath: number[] = []
    const pools: PoolRawData[] = []
    const hopPoolCounts: number[] = []

    for (let i = 0; i < tokenPath.length - 1; i++) {
        const edgePools = sortPoolsForHop(
            tokenPath[i],
            getPoolsForTokens(
                tokenPath[i],
                tokenPath[i + 1],
                allPools,
                addressToCanonical
            ),
            addressToCanonical
        )
        if (!edgePools.length) return null

        hopPoolCounts.push(edgePools.length)
        for (const pool of edgePools) {
            indexPath.push(pool.index)
            pools.push(pool)
        }
    }

    return { tokenPath, indexPath, pools, hopPoolCounts }
}

/** 每条 token 路径生成一条带多池兜底的 RouteCandidate */
function enumerateRouteCandidates(
    tokenPath: string[],
    allPools: PoolRawData[],
    addressToCanonical: Map<string, Address>
): RouteCandidate[] {
    const route = buildRouteWithPoolFallback(
        tokenPath,
        allPools,
        addressToCanonical
    )
    return route ? [route] : []
}

const MIN_SQRT_RATIO = 4295128739n
const MAX_SQRT_RATIO = 1461446703485210103287273052203988822378723970342n

function isZeroForOne(
    canonicalIn: string,
    pool: PoolRawData,
    addressToCanonical: Map<string, Address>
): boolean {
    const actualIn = poolTokenForCanonical(canonicalIn, pool, addressToCanonical)
    return pool.token0.toLowerCase() === actualIn.toLowerCase()
}

/** V3 池子 swap 需传入合法价格限制，0 会导致合约 revert */
function getSqrtPriceLimitX96(
    canonicalIn: string,
    pool: PoolRawData,
    addressToCanonical: Map<string, Address>
): bigint {
    return isZeroForOne(canonicalIn, pool, addressToCanonical)
        ? MIN_SQRT_RATIO + 1n
        : MAX_SQRT_RATIO - 1n
}

//获取池子swap block原因
function getSwapBlockReason(
    canonicalIn: string,
    pool: PoolRawData,
    addressToCanonical: Map<string, Address>
): string | null {
    if (pool.liquidity === 0n) return '池子流动性为 0'
    const zeroForOne = isZeroForOne(canonicalIn, pool, addressToCanonical)
    if (zeroForOne && pool.tick <= pool.tickLower) {
        return '当前价格已在区间下限，继续卖出该 token 无法成交'
    }
    if (!zeroForOne && pool.tick >= pool.tickUpper) {
        return '当前价格已在区间上限，继续买入该 token 无法成交'
    }
    return null
}

//获取交易路径swap block原因
function getRouteSwapBlockReason(
    route: RouteCandidate,
    addressToCanonical: Map<string, Address>
): string | null {
    const hopCounts = route.hopPoolCounts
    let offset = 0

    for (let hop = 0; hop < hopCounts.length; hop++) {
        const canonicalIn = route.tokenPath[hop]
        const hopPools = route.pools.slice(offset, offset + hopCounts[hop])
        const hasSwappable = hopPools.some((p) =>
            //判断池子是否可swap
            isPoolSwappable(canonicalIn, p, addressToCanonical)
        )

        if (!hasSwappable) {
            for (const pool of hopPools) {
                const reason = getSwapBlockReason(
                    canonicalIn,
                    pool,
                    addressToCanonical
                )
                if (reason) return reason
            }
            return '该路径所有池子均不可兑换'
        }

        offset += hopCounts[hop]
    }

    return null
}

function filterSwappableRoutes(
    routes: RouteCandidate[],
    addressToCanonical: Map<string, Address>
): RouteCandidate[] {
    return routes.filter(
        (route) => !getRouteSwapBlockReason(route, addressToCanonical)
    )
}

function extractErrorMessage(error: unknown): string {
    if (error && typeof error === 'object') {
        const e = error as { shortMessage?: string; message?: string }
        return e.shortMessage ?? e.message ?? '未知错误'
    }
    return String(error)
}

/** 过滤边界池产生的 0 报价或极端价格比（如 100 换出需 1e21 输入） */
function isReasonableQuoteRatio(amountIn: bigint, amountOut: bigint): boolean {
    if (amountIn <= 0n || amountOut <= 0n) return false
    const maxRatio = 1_000_000n
    if (amountIn * maxRatio < amountOut) return false
    if (amountIn > amountOut * maxRatio) return false
    return true
}

function pickBestExactInputQuote(
    results: { route: RouteCandidate; out: bigint }[],
    amountIn: bigint
): { route: RouteCandidate; out: bigint } | undefined {
    const valid = results.filter((r) => isReasonableQuoteRatio(amountIn, r.out))
    return valid.reduce<{ route: RouteCandidate; out: bigint } | undefined>(
        (best, cur) => (!best || cur.out > best.out ? cur : best),
        undefined
    )
}

function pickBestExactOutputQuote(
    results: { route: RouteCandidate; amountInNeeded: bigint }[],
    amountOut: bigint
): { route: RouteCandidate; amountInNeeded: bigint } | undefined {
    const valid = results.filter((r) =>
        isReasonableQuoteRatio(r.amountInNeeded, amountOut)
    )
    return valid.reduce<{ route: RouteCandidate; amountInNeeded: bigint } | undefined>(
        (best, cur) =>
            !best || cur.amountInNeeded < best.amountInNeeded ? cur : best,
        undefined
    )
}

async function quoteExactInputAmount(
    config: Config,
    route: RouteCandidate,
    canonicalIn: Address,
    canonicalOut: Address,
    amountIn: bigint,
    addressToCanonical: Map<string, Address>,
    account?: Address
): Promise<bigint> {
    const { tokenIn, tokenOut } = routerTokensForRoute(
        route,
        canonicalIn,
        canonicalOut,
        addressToCanonical
    )
    const sqrtPriceLimitX96 = getSqrtPriceLimitX96(canonicalIn, route.pools[0], addressToCanonical)
    const params = {
        tokenIn,
        tokenOut,
        indexPath: route.indexPath,
        amountIn,
        sqrtPriceLimitX96,
    }
    try {
        const { result } = await simulateContract(config, {
            address: SwapRouterAddress,
            abi: SwapRouterAbi,
            functionName: 'quoteExactInput',
            args: [params],
            account,
        })
        return result as bigint
    } catch {
        return readContract(config, {
            address: SwapRouterAddress,
            abi: SwapRouterAbi,
            functionName: 'quoteExactInput',
            args: [params],
        }) as Promise<bigint>
    }
}

async function quoteExactOutputAmount(
    config: Config,
    route: RouteCandidate,
    canonicalIn: Address,
    canonicalOut: Address,
    amountOut: bigint,
    addressToCanonical: Map<string, Address>,
    account?: Address
): Promise<bigint> {
    const { tokenIn, tokenOut } = routerTokensForRoute(
        route,
        canonicalIn,
        canonicalOut,
        addressToCanonical
    )
    const sqrtPriceLimitX96 = getSqrtPriceLimitX96(canonicalIn, route.pools[0], addressToCanonical)
    const params = {
        tokenIn,
        tokenOut,
        indexPath: route.indexPath,
        amountOut,
        sqrtPriceLimitX96,
    }
    try {
        const { result } = await simulateContract(config, {
            address: SwapRouterAddress,
            abi: SwapRouterAbi,
            functionName: 'quoteExactOutput',
            args: [params],
            account,
        })
        return result as bigint
    } catch {
        return readContract(config, {
            address: SwapRouterAddress,
            abi: SwapRouterAbi,
            functionName: 'quoteExactOutput',
            args: [params],
        }) as Promise<bigint>
    }
}

export default function Swap() {
    const [selectedTokenIn, setSelectedTokenIn] = useState('')
    const [selectedTokenOut, setSelectedTokenOut] = useState('')
    const [amountIn, setAmountIn] = useState('')
    const [amountOut, setAmountOut] = useState('')
    const [quoteMode, setQuoteMode] = useState<QuoteMode | null>(null)
    const [bestRoute, setBestRoute] = useState<RouteCandidate | undefined>()
    const [bestQuoteOut, setBestQuoteOut] = useState<bigint | undefined>()
    const [bestQuoteIn, setBestQuoteIn] = useState<bigint | undefined>()
    const [isQuoting, setIsQuoting] = useState(false)
    const [quoteError, setQuoteError] = useState('')
    const [txStep, setTxStep] = useState<TxStep>('idle')
    const pendingAmountInRef = useRef<bigint | null>(null)
    const pendingIndexPathRef = useRef<number[] | null>(null)
    const pendingQuoteModeRef = useRef<QuoteMode | null>(null)
    const pendingRouteRef = useRef<RouteCandidate | null>(null)
    const skipBlurQuoteRef = useRef(false)

    const config = useConfig()
    const { isConnected, address } = useAccount()

    //获取所有交易对
    const { data: pairs, isLoading: pairsLoading } = useReadContract({
        abi: PoolManagerAbi,
        address: PoolManagerAddress,
        functionName: 'getPairs',
        query: { enabled: isConnected },
    })
    //获取所有池子
    const { data: poolsRaw, isLoading: poolsLoading } = useReadContract({
        abi: PoolManagerAbi,
        address: PoolManagerAddress,
        functionName: 'getAllPools',
        query: { enabled: isConnected },
    })
    //转换池子数据格式
    const allPools = useMemo(() => normalizePools(poolsRaw), [poolsRaw])
    //获取所有交易对
    const pairList = useMemo(() => (pairs as Pair[] | undefined) ?? [], [pairs])
    //获取所有token地址
    const tokenAddresses = useMemo(() => {
        if (!pairList.length) return [] as Address[]
        // 地址仅大小写不同时应视为同一 token，否则下拉会出现重复 symbol
        const byLower = new Map<string, Address>()
        pairList.forEach((p) => {
            const t0 = p.token0.toLowerCase()
            const t1 = p.token1.toLowerCase()
            if (!byLower.has(t0)) byLower.set(t0, p.token0)
            if (!byLower.has(t1)) byLower.set(t1, p.token1)
        })
        return Array.from(byLower.values())
    }, [pairList])

    //批量读取合约数据，获取symbol
    const { data: symbolResults } = useReadContracts({
        contracts: tokenAddresses.map((addr) => ({
            address: addr,
            abi: erc20Abi,
            functionName: 'symbol' as const,
        })),
        query: { enabled: tokenAddresses.length > 0 },
    })
    //生成下拉选项
    const { tokenOptions, addressToCanonical, symbolToAddresses } = useMemo(() => {
        const entries = tokenAddresses.map((addr, i) => ({
            addr,
            symbol:
                symbolResults?.[i]?.status === 'success'
                    ? (symbolResults[i].result as string)
                    : `${addr.slice(0, 6)}...${addr.slice(-4)}`,
        }))
        const bySymbol = new Map<string, typeof entries>()
        for (const entry of entries) {
            const key = entry.symbol.toUpperCase()
            const group = bySymbol.get(key) ?? []
            group.push(entry)
            bySymbol.set(key, group)
        }

        const canonicalMap = new Map<string, Address>()
        const addressesBySymbol = new Map<string, Address[]>()
        const options: TokenOption[] = []
        for (const group of bySymbol.values()) {
            const canonical = group.reduce(
                (best, entry) =>
                    liquidityForToken(entry.addr, allPools) >
                    liquidityForToken(best.addr, allPools)
                        ? entry
                        : best,
                group[0]
            ).addr
            options.push({ label: group[0].symbol, value: canonical })
            addressesBySymbol.set(
                group[0].symbol.toUpperCase(),
                group.map((entry) => entry.addr)
            )
            for (const entry of group) {
                canonicalMap.set(entry.addr.toLowerCase(), canonical)
            }
        }
        options.sort((a, b) => a.label.localeCompare(b.label))
        return {
            tokenOptions: options,
            addressToCanonical: canonicalMap,
            symbolToAddresses: addressesBySymbol,
        }
    }, [tokenAddresses, symbolResults, allPools])
    //构建交易对列表

    //构建交易对列表
    const canonicalPairList = useMemo(
        () => buildCanonicalPairList(pairList, addressToCanonical),
        [pairList, addressToCanonical]
    )

    const tokenInOptions = tokenOptions

    const tokenOutOptions = useMemo(() => {
        if (!selectedTokenIn || !canonicalPairList.length) return [] as TokenOption[]
        const inLower = selectedTokenIn.toLowerCase()
        const addrs = new Set<string>()
        canonicalPairList.forEach((p) => {
            if (p.token0.toLowerCase() === inLower) addrs.add(p.token1.toLowerCase())
            if (p.token1.toLowerCase() === inLower) addrs.add(p.token0.toLowerCase())
        })
        return Array.from(addrs)
            .map((addr) => tokenOptions.find((o) => o.value.toLowerCase() === addr))
            .filter((opt): opt is TokenOption => !!opt)
    }, [selectedTokenIn, canonicalPairList, tokenOptions])

    const routeCandidates = useMemo(() => {
        if (!selectedTokenIn || !selectedTokenOut) return [] as RouteCandidate[]
        const tokenPaths = findTokenPaths(
            selectedTokenIn,
            selectedTokenOut,
            canonicalPairList
        )
        return tokenPaths.flatMap((path) =>
            enumerateRouteCandidates(path, allPools, addressToCanonical)
        )
    }, [selectedTokenIn, selectedTokenOut, canonicalPairList, allPools, addressToCanonical])

    const tokenInAddress = selectedTokenIn as Address
    const tokenOutAddress = selectedTokenOut as Address

    const payTokenAddresses = useMemo(() => {
        if (!selectedTokenIn) return [] as Address[]
        const opt = tokenOptions.find(
            (o) => o.value.toLowerCase() === selectedTokenIn.toLowerCase()
        )
        if (!opt) return [tokenInAddress]
        return symbolToAddresses.get(opt.label.toUpperCase()) ?? [tokenInAddress]
    }, [selectedTokenIn, tokenOptions, symbolToAddresses, tokenInAddress])

    const approveTokenAddress = useMemo(() => {
        if (!bestRoute || !selectedTokenIn) return tokenInAddress
        return poolTokenForCanonical(
            selectedTokenIn,
            bestRoute.pools[0],
            addressToCanonical
        )
    }, [bestRoute, selectedTokenIn, tokenInAddress, addressToCanonical])

    const { data: balanceResults } = useReadContracts({
        contracts: payTokenAddresses.map((addr) => ({
            address: addr,
            abi: erc20Abi,
            functionName: 'balanceOf' as const,
            args: [address!],
        })),
        query: {
            enabled: !!address && payTokenAddresses.length > 0,
        },
    })

    const { data: tokenMetaResults, refetch: refetchAllowance } = useReadContracts({
        contracts:
            address && selectedTokenIn && selectedTokenOut
                ? [
                    {
                        address: tokenInAddress,
                        abi: erc20Abi,
                        functionName: 'decimals' as const,
                    },
                    {
                        address: tokenOutAddress,
                        abi: erc20Abi,
                        functionName: 'decimals' as const,
                    },
                    {
                        address: approveTokenAddress,
                        abi: erc20Abi,
                        functionName: 'allowance' as const,
                        args: [address, SwapRouterAddress],
                    },
                ]
                : [],
        query: {
            enabled: !!address && !!selectedTokenIn && !!selectedTokenOut,
        },
    })

    const decimalsIn = Number(tokenMetaResults?.[0]?.result ?? 18)
    const decimalsOut = Number(tokenMetaResults?.[1]?.result ?? 18)
    const balanceIn = useMemo(() => {
        if (!balanceResults?.length) return 0n
        return balanceResults.reduce((total, res) => {
            if (res.status === 'success') {
                return total + (res.result as bigint)
            }
            return total
        }, 0n)
    }, [balanceResults])
    const routerConfigured =
        SwapRouterAddress !== '0x0000000000000000000000000000000000000000'

    const resetQuoteState = useCallback(() => {
        setQuoteMode(null)
        setBestRoute(undefined)
        setBestQuoteOut(undefined)
        setBestQuoteIn(undefined)
        setQuoteError('')
    }, [])

    const quoteOnAmountInBlur = useCallback(async () => {
        if (skipBlurQuoteRef.current) {
            skipBlurQuoteRef.current = false
            return
        }
        if (!routerConfigured || !selectedTokenIn || !selectedTokenOut || !amountIn.trim()) {
            return
        }
        if (!routeCandidates.length) {
            setQuoteError('未找到可用兑换路径')
            return
        }

        let amountInParsed: bigint
        try {
            amountInParsed = parseUnits(amountIn, decimalsIn)
            if (amountInParsed <= 0n) return
        } catch {
            setQuoteError('支付数量格式不正确')
            return
        }
        //过滤可用的交易路径
        const swappableRoutes = filterSwappableRoutes(routeCandidates, addressToCanonical)
        if (!swappableRoutes.length) {
            const blockReason = routeCandidates[0]
                ? getRouteSwapBlockReason(routeCandidates[0], addressToCanonical)
                : null
            setQuoteError(
                blockReason ?? '该兑换方向在池子价格区间外，请反向兑换或等待价格回到区间内'
            )
            return
        }

        setIsQuoting(true)
        setQuoteError('')
        try {
            const quoteResults = await Promise.allSettled(
                swappableRoutes.map(async (route) => {
                    const out = await quoteExactInputAmount(
                        config,
                        route,
                        tokenInAddress,
                        tokenOutAddress,
                        amountInParsed,
                        addressToCanonical,
                        address
                    )
                    return { route, out }
                })
            )

            const fulfilled: { route: RouteCandidate; out: bigint }[] = []
            let lastError = ''
            for (const res of quoteResults) {
                if (res.status === 'rejected') {
                    lastError = extractErrorMessage(res.reason)
                    continue
                }
                fulfilled.push(res.value)
            }
            const best = pickBestExactInputQuote(fulfilled, amountInParsed)
            if (!best || best.out <= 0n) {
                setQuoteError(lastError || '报价失败，请检查数量或流动性')
                return
            }
            const { route: bestRouteResult, out: bestOut } = best
            setBestRoute(bestRouteResult)
            setBestQuoteOut(bestOut)
            setBestQuoteIn(undefined)
            setQuoteMode('exactInput')
            skipBlurQuoteRef.current = true
            setAmountOut(formatUnits(bestOut, decimalsOut))
        } finally {
            setIsQuoting(false)
        }
    }, [
        routerConfigured,
        selectedTokenIn,
        selectedTokenOut,
        amountIn,
        routeCandidates,
        decimalsIn,
        decimalsOut,
        config,
        address,
        tokenInAddress,
        tokenOutAddress,
        addressToCanonical,
    ])

    const quoteOnAmountOutBlur = useCallback(async () => {
        if (skipBlurQuoteRef.current) {
            skipBlurQuoteRef.current = false
            return
        }
        if (!routerConfigured || !selectedTokenIn || !selectedTokenOut || !amountOut.trim()) {
            return
        }
        if (!routeCandidates.length) {
            setQuoteError('未找到可用兑换路径')
            return
        }

        let amountOutParsed: bigint
        try {
            amountOutParsed = parseUnits(amountOut, decimalsOut)
            if (amountOutParsed <= 0n) return
        } catch {
            setQuoteError('接收数量格式不正确')
            return
        }

        const swappableRoutes = filterSwappableRoutes(routeCandidates, addressToCanonical)
        if (!swappableRoutes.length) {
            const blockReason = routeCandidates[0]
                ? getRouteSwapBlockReason(routeCandidates[0], addressToCanonical)
                : null
            setQuoteError(
                blockReason ?? '该兑换方向在池子价格区间外，请反向兑换或等待价格回到区间内'
            )
            return
        }

        setIsQuoting(true)
        setQuoteError('')
        try {
            const quoteResults = await Promise.allSettled(
                swappableRoutes.map(async (route) => {
                    const amountInNeeded = await quoteExactOutputAmount(
                        config,
                        route,
                        tokenInAddress,
                        tokenOutAddress,
                        amountOutParsed,
                        addressToCanonical,
                        address
                    )
                    return { route, amountInNeeded }
                })
            )

            const fulfilled: { route: RouteCandidate; amountInNeeded: bigint }[] = []
            let lastError = ''
            for (const res of quoteResults) {
                if (res.status === 'rejected') {
                    lastError = extractErrorMessage(res.reason)
                    continue
                }
                fulfilled.push(res.value)
            }
            const best = pickBestExactOutputQuote(fulfilled, amountOutParsed)
            if (!best || best.amountInNeeded <= 0n) {
                setQuoteError(lastError || '报价失败，请检查数量或流动性')
                return
            }
            const { route: bestRouteResult, amountInNeeded: bestIn } = best
            setBestRoute(bestRouteResult)
            setBestQuoteIn(bestIn)
            setBestQuoteOut(undefined)
            setQuoteMode('exactOutput')
            skipBlurQuoteRef.current = true
            setAmountIn(formatUnits(bestIn, decimalsIn))
        } finally {
            setIsQuoting(false)
        }
    }, [
        routerConfigured,
        selectedTokenIn,
        selectedTokenOut,
        amountOut,
        routeCandidates,
        decimalsIn,
        decimalsOut,
        config,
        address,
        tokenInAddress,
        tokenOutAddress,
        addressToCanonical,
    ])

    const allowanceResultIndex = 2

    const balanceInDisplay = useMemo(() => {
        try {
            return formatUnits(balanceIn, decimalsIn)
        } catch {
            return '0'
        }
    }, [balanceIn, decimalsIn])

    const { writeContract, data: hash, isPending, error: writeError } = useWriteContract()
    const { isLoading: isConfirming, isSuccess: isTxSuccess } =
        useWaitForTransactionReceipt({ hash })
    const isSubmitting = isPending || isConfirming

    const approveTokenIn = useCallback(
        (spenderToken: Address, approveAmount: bigint) => {
            writeContract({
                address: spenderToken,
                abi: erc20Abi,
                functionName: 'approve',
                args: [SwapRouterAddress, approveAmount],
            })
            setTxStep('approve')
        },
        [writeContract]
    )

    const executeExactInput = useCallback(
        (
            routerTokenIn: Address,
            routerTokenOut: Address,
            amountInDesired: bigint,
            amountOutMinimum: bigint,
            indexPath: number[],
            sqrtPriceLimitX96: bigint
        ) => {
            if (!address) return
            writeContract({
                address: SwapRouterAddress,
                abi: SwapRouterAbi,
                functionName: 'exactInput',
                args: [
                    {
                        tokenIn: routerTokenIn,
                        tokenOut: routerTokenOut,
                        indexPath,
                        recipient: address,
                        deadline: Math.floor(Date.now() / 1000) + 3600,
                        amountIn: amountInDesired,
                        amountOutMinimum,
                        sqrtPriceLimitX96,
                    },
                ],
            })
            setTxStep('swap')
        },
        [address, writeContract]
    )

    const executeExactOutput = useCallback(
        (
            routerTokenIn: Address,
            routerTokenOut: Address,
            amountOutDesired: bigint,
            amountInMaximum: bigint,
            indexPath: number[],
            sqrtPriceLimitX96: bigint
        ) => {
            if (!address) return
            writeContract({
                address: SwapRouterAddress,
                abi: SwapRouterAbi,
                functionName: 'exactOutput',
                args: [
                    {
                        tokenIn: routerTokenIn,
                        tokenOut: routerTokenOut,
                        indexPath,
                        recipient: address,
                        deadline: Math.floor(Date.now() / 1000) + 3600,
                        amountOut: amountOutDesired,
                        amountInMaximum,
                        sqrtPriceLimitX96,
                    },
                ],
            })
            setTxStep('swap')
        },
        [address, writeContract]
    )

    const continueSwapFlow = useCallback(
        async (
            approveAmount: bigint,
            indexPath: number[],
            mode: QuoteMode,
            route: RouteCandidate
        ) => {
            pendingAmountInRef.current = approveAmount
            pendingQuoteModeRef.current = mode
            const { tokenIn: routerTokenIn, tokenOut: routerTokenOut } =
                routerTokensForRoute(
                    route,
                    tokenInAddress,
                    tokenOutAddress,
                    addressToCanonical
                )
            const { data: latestMeta } = await refetchAllowance()
            const latestAllowance =
                latestMeta?.[allowanceResultIndex]?.status === 'success'
                    ? (latestMeta[allowanceResultIndex].result as bigint)
                    : 0n

            if (latestAllowance < approveAmount) {
                approveTokenIn(routerTokenIn, approveAmount)
                return
            }

            const sqrtPriceLimitX96 = getSqrtPriceLimitX96(
                selectedTokenIn,
                route.pools[0],
                addressToCanonical
            )

            if (mode === 'exactOutput') {
                const amountOutDesired = parseUnits(amountOut, decimalsOut)
                executeExactOutput(
                    routerTokenIn,
                    routerTokenOut,
                    amountOutDesired,
                    approveAmount,
                    indexPath,
                    sqrtPriceLimitX96
                )
                return
            }

            const amountInDesired = parseUnits(amountIn, decimalsIn)
            const amountOutMinimum =
                bestQuoteOut && bestQuoteOut > 0n ? (bestQuoteOut * 95n) / 100n : 0n
            executeExactInput(
                routerTokenIn,
                routerTokenOut,
                amountInDesired,
                amountOutMinimum,
                indexPath,
                sqrtPriceLimitX96
            )
        },
        [
            refetchAllowance,
            approveTokenIn,
            executeExactInput,
            executeExactOutput,
            bestQuoteOut,
            amountIn,
            amountOut,
            decimalsIn,
            decimalsOut,
            selectedTokenIn,
            tokenInAddress,
            tokenOutAddress,
            addressToCanonical,
            allowanceResultIndex,
        ]
    )

    const handleSwap = () => {
        if (!isConnected || !address) {
            alert('请先连接钱包')
            return
        }
        if (!routerConfigured) {
            alert('请先在代码中配置 SwapRouter 合约地址')
            return
        }
        if (!selectedTokenIn || !selectedTokenOut) {
            alert('请选择支付 token 和接收 token')
            return
        }
        if (selectedTokenIn.toLowerCase() === selectedTokenOut.toLowerCase()) {
            alert('支付 token 与接收 token 不能相同')
            return
        }
        if (!bestRoute) {
            alert('请先在数量输入框离焦完成报价')
            return
        }
        if (!quoteMode) {
            alert('请先在数量输入框离焦完成报价')
            return
        }
        const route = bestRoute
        if (isSubmitting) return

        try {
            if (quoteMode === 'exactInput') {
                if (!amountIn.trim()) throw new Error('请填写 token0 数量')
                const amountInDesired = parseUnits(amountIn, decimalsIn)
                if (amountInDesired <= 0n) throw new Error('数量不能为 0')
                if (amountInDesired > balanceIn) throw new Error('余额不足')
                pendingIndexPathRef.current = route.indexPath
                pendingRouteRef.current = route
                continueSwapFlow(amountInDesired, route.indexPath, 'exactInput', route)
            } else {
                if (!amountOut.trim()) throw new Error('请填写 token1 数量')
                const amountOutDesired = parseUnits(amountOut, decimalsOut)
                if (amountOutDesired <= 0n) throw new Error('数量不能为 0')
                if (!bestQuoteIn || bestQuoteIn <= 0n) throw new Error('请先完成报价')
                const amountInMaximum = (bestQuoteIn * 105n) / 100n
                if (amountInMaximum > balanceIn) throw new Error('余额不足')
                pendingIndexPathRef.current = route.indexPath
                pendingRouteRef.current = route
                continueSwapFlow(amountInMaximum, route.indexPath, 'exactOutput', route)
            }
        } catch (e) {
            alert(e instanceof Error ? e.message : '参数错误')
        }
    }

    useEffect(() => {
        resetQuoteState()
    }, [selectedTokenIn, selectedTokenOut, resetQuoteState])

    useEffect(() => {
        if (!isTxSuccess || txStep === 'idle') return
        const pending = pendingAmountInRef.current
        const indexPath = pendingIndexPathRef.current
        const mode = pendingQuoteModeRef.current
        const route = pendingRouteRef.current
        if (!pending || !indexPath || !mode || !route) return

        if (txStep === 'approve') {
            continueSwapFlow(pending, indexPath, mode, route)
        } else if (txStep === 'swap') {
            setTxStep('idle')
            setAmountIn('')
            setAmountOut('')
            resetQuoteState()
            pendingAmountInRef.current = null
            pendingQuoteModeRef.current = null
            pendingRouteRef.current = null
            refetchAllowance()
            alert('兑换成功')
        }
    }, [isTxSuccess, txStep, continueSwapFlow, refetchAllowance, resetQuoteState])

    return (
        <div className='border max-w-6xl mx-auto px-6 py-8'>
            <div>
                <h2 className='text-2xl font-bold'>Swap</h2>
            </div>

            <div className='flex justify-center py-8'>
                <div className='w-[480px] max-h-[90vh] overflow-y-auto bg-white rounded-md shadow-xl border'>
                    <div className='items-center px-5 py-4 border-b'>
                        <h3 className='text-lg font-semibold'>swap tokens</h3>
                    </div>

                    <div className='px-5 py-4 space-y-5'>
                        {!routerConfigured && (
                            <p className='text-sm text-amber-600 bg-amber-50 border border-amber-200 rounded-xl px-4 py-3'>
                                请在 swap/index.tsx 中配置 SwapRouterAddress 后再发起兑换
                            </p>
                        )}

                        <div className='space-y-3'>
                            <div>
                                <p className='text-sm mb-1'>支付 token：</p>
                                <select
                                    className='w-full border rounded-xl px-4 py-3 outline-none focus:ring-2 focus:ring-blue-500 appearance-none bg-white cursor-pointer disabled:opacity-50'
                                    value={selectedTokenIn}
                                    disabled={pairsLoading}
                                    onChange={(e) => {
                                        setSelectedTokenIn(e.target.value)
                                        setSelectedTokenOut('')
                                        setAmountIn('')
                                        setAmountOut('')
                                    }}
                                >
                                    <option value=''>请选择支付 token</option>
                                    {tokenInOptions.map((opt) => (
                                        <option key={opt.label} value={opt.value}>
                                            {opt.label}
                                        </option>
                                    ))}
                                </select>
                                {selectedTokenIn && (
                                    <p className='text-xs text-gray-400 mt-1 text-right'>
                                        余额: {balanceInDisplay}
                                    </p>
                                )}
                            </div>

                            <div>
                                <p className='text-sm mb-1'>接收 token：</p>
                                <select
                                    className='w-full border rounded-xl px-4 py-3 outline-none focus:ring-2 focus:ring-blue-500 appearance-none bg-white cursor-pointer disabled:opacity-50'
                                    value={selectedTokenOut}
                                    disabled={!selectedTokenIn || pairsLoading}
                                    onChange={(e) => setSelectedTokenOut(e.target.value)}
                                >
                                    <option value=''>请选择接收 token</option>
                                    {tokenOutOptions.map((opt) => (
                                        <option key={opt.label} value={opt.value}>
                                            {opt.label}
                                        </option>
                                    ))}
                                </select>
                            </div>

                            <div>
                                <p className='text-sm mb-1'>token0 数量：</p>
                                <input
                                    type='text'
                                    placeholder='0'
                                    value={amountIn}
                                    onChange={(e) => {
                                        setAmountIn(e.target.value)
                                        setAmountOut('')
                                        resetQuoteState()
                                    }}
                                    onBlur={quoteOnAmountInBlur}
                                    disabled={isQuoting}
                                    className='w-full border rounded-xl px-4 py-3 outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50'
                                />
                            </div>

                            <div>
                                <p className='text-sm mb-1'>token1 数量：</p>
                                <input
                                    type='text'
                                    placeholder={routerConfigured ? '离焦后自动报价' : '配置 Router 后可报价'}
                                    value={amountOut}
                                    onChange={(e) => {
                                        setAmountOut(e.target.value)
                                        setAmountIn('')
                                        resetQuoteState()
                                    }}
                                    onBlur={quoteOnAmountOutBlur}
                                    disabled={isQuoting}
                                    className='w-full border rounded-xl px-4 py-3 outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50'
                                />
                            </div>

                            {isQuoting && (
                                <p className='text-sm text-gray-500'>报价中...</p>
                            )}
                            {quoteError && (
                                <p className='text-sm text-red-500'>{quoteError}</p>
                            )}
                        </div>

                        {writeError && (
                            <p className='text-sm text-red-500'>
                                {writeError.message}
                            </p>
                        )}
                    </div>

                    <div className='flex justify-end gap-3 px-5 py-4 border-t bg-gray-50'>
                        <button
                            className='px-6 py-2.5 bg-blue-500 text-white rounded-xl hover:bg-blue-600 transition-colors font-medium disabled:opacity-50'
                            onClick={handleSwap}
                            disabled={isSubmitting}
                        >
                            {isSubmitting
                                ? txStep === 'approve'
                                    ? '授权中...'
                                    : '兑换中...'
                                : '兑换'}
                        </button>
                    </div>
                </div>
            </div>
        </div>
    )
}
