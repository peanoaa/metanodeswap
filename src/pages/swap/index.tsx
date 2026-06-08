/**
 * Swap 页：参考 Position 弹窗样式，完成 token 兑换。
 * 链上流程：选 tokenIn → tokenOut → 自动算最优 indexPath → quote → approve → SwapRouter.exactInput
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
/** 请替换为链上已部署的 SwapRouter 地址 */
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
    indexPath: number[]
    pools: PoolRawData[]
}
type TxStep = 'idle' | 'approve' | 'swap'
type QuoteMode = 'exactInput' | 'exactOutput'

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

function canonicalAddr(addr: string, addressToCanonical: Map<string, Address>): Address {
    return addressToCanonical.get(addr.toLowerCase()) ?? (addr as Address)
}

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

function buildAdjacency(pairList: Pair[]): Map<string, Set<string>> {
    const adj = new Map<string, Set<string>>()
    const addEdge = (a: string, b: string) => {
        if (!adj.has(a)) adj.set(a, new Set())
        if (!adj.has(b)) adj.set(b, new Set())
        adj.get(a)!.add(b)
        adj.get(b)!.add(a)
    }
    pairList.forEach((p) => addEdge(p.token0.toLowerCase(), p.token1.toLowerCase()))
    return adj
}

/** BFS 找 tokenIn → tokenOut 的所有路径（最多 2 跳） */
function findTokenPaths(tokenIn: string, tokenOut: string, pairList: Pair[], maxHops = 2): string[][] {
    const start = tokenIn.toLowerCase()
    const end = tokenOut.toLowerCase()
    if (start === end) return []

    const adj = buildAdjacency(pairList)
    const paths: string[][] = []
    const queue: { node: string; path: string[] }[] = [{ node: start, path: [start] }]

    while (queue.length > 0) {
        const { node, path } = queue.shift()!
        if (path.length > maxHops + 1) continue

        for (const neighbor of adj.get(node) ?? []) {
            if (path.includes(neighbor)) continue
            const newPath = [...path, neighbor]
            if (neighbor === end) {
                paths.push(newPath)
            } else if (newPath.length <= maxHops) {
                queue.push({ node: neighbor, path: newPath })
            }
        }
    }
    return paths
}

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

/** 每条 token 路径展开为所有 indexPath 组合 */
function enumerateRouteCandidates(
    tokenPath: string[],
    allPools: PoolRawData[],
    addressToCanonical: Map<string, Address>
): RouteCandidate[] {
    if (tokenPath.length < 2) return []

    const edges: PoolRawData[][] = []
    for (let i = 0; i < tokenPath.length - 1; i++) {
        const pools = getPoolsForTokens(
            tokenPath[i],
            tokenPath[i + 1],
            allPools,
            addressToCanonical
        )
        if (!pools.length) return []
        edges.push(pools)
    }

    const results: RouteCandidate[] = []
    const dfs = (edgeIdx: number, chosenPools: PoolRawData[]) => {
        if (edgeIdx === edges.length) {
            results.push({
                tokenPath,
                indexPath: chosenPools.map((p) => p.index),
                pools: chosenPools,
            })
            return
        }
        for (const pool of edges[edgeIdx]) {
            dfs(edgeIdx + 1, [...chosenPools, pool])
        }
    }
    dfs(0, [])
    return results
}

/** 单次报价最多模拟的路径数，避免候选爆炸导致 RPC 过多 */
const MAX_QUOTE_CANDIDATES = 8

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

function getRouteSwapBlockReason(
    route: RouteCandidate,
    addressToCanonical: Map<string, Address>
): string | null {
    for (let i = 0; i < route.pools.length; i++) {
        const reason = getSwapBlockReason(
            route.tokenPath[i],
            route.pools[i],
            addressToCanonical
        )
        if (reason) return reason
    }
    return null
}

function isRouteFullyInRange(route: RouteCandidate): boolean {
    return route.pools.every(
        (p) => p.tick > p.tickLower && p.tick < p.tickUpper
    )
}

function filterSwappableRoutes(
    routes: RouteCandidate[],
    addressToCanonical: Map<string, Address>
): RouteCandidate[] {
    return routes.filter(
        (route) =>
            !getRouteSwapBlockReason(route, addressToCanonical) &&
            isRouteFullyInRange(route)
    )
}

function extractErrorMessage(error: unknown): string {
    if (error && typeof error === 'object') {
        const e = error as { shortMessage?: string; message?: string }
        return e.shortMessage ?? e.message ?? '未知错误'
    }
    return String(error)
}

function minRouteLiquidity(route: RouteCandidate): number {
    return Math.min(...route.pools.map((p) => Number(p.liquidity)))
}

function inRangePoolCount(route: RouteCandidate): number {
    return route.pools.filter(
        (p) => p.tick > p.tickLower && p.tick < p.tickUpper
    ).length
}

/** 过滤边界池产生的 0 报价或极端价格比（如 100 换出需 1e21 输入） */
function isReasonableQuoteRatio(amountIn: bigint, amountOut: bigint): boolean {
    if (amountIn <= 0n || amountOut <= 0n) return false
    const maxRatio = 1_000_000n
    if (amountIn * maxRatio < amountOut) return false
    if (amountIn > amountOut * maxRatio) return false
    return true
}

const LIQUIDITY_TIER_FRACTION = 0.1

function pickBestExactInputQuote(
    results: { route: RouteCandidate; out: bigint }[],
    amountIn: bigint
): { route: RouteCandidate; out: bigint } | undefined {
    const valid = results.filter((r) => isReasonableQuoteRatio(amountIn, r.out))
    if (!valid.length) return undefined
    const maxLiq = Math.max(...valid.map((r) => minRouteLiquidity(r.route)))
    const liqFloor = maxLiq * LIQUIDITY_TIER_FRACTION
    const tier = valid.filter((r) => minRouteLiquidity(r.route) >= liqFloor)
    return tier.reduce<{ route: RouteCandidate; out: bigint } | undefined>(
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
    if (!valid.length) return undefined
    const maxLiq = Math.max(...valid.map((r) => minRouteLiquidity(r.route)))
    const liqFloor = maxLiq * LIQUIDITY_TIER_FRACTION
    const tier = valid.filter((r) => minRouteLiquidity(r.route) >= liqFloor)
    return tier.reduce<{ route: RouteCandidate; amountInNeeded: bigint } | undefined>(
        (best, cur) =>
            !best || cur.amountInNeeded < best.amountInNeeded ? cur : best,
        undefined
    )
}

function compareRoutePriority(a: RouteCandidate, b: RouteCandidate): number {
    const inRangeDiff = inRangePoolCount(b) - inRangePoolCount(a)
    if (inRangeDiff !== 0) return inRangeDiff
    if (a.tokenPath.length !== b.tokenPath.length) {
        return a.tokenPath.length - b.tokenPath.length
    }
    return minRouteLiquidity(b) - minRouteLiquidity(a)
}

function pickHeuristicBestRoute(candidates: RouteCandidate[]): RouteCandidate | undefined {
    if (!candidates.length) return undefined
    return [...candidates].sort(compareRoutePriority)[0]
}

/** 报价前裁剪候选路径：优先短路径 + 高流动性，减少 RPC 次数 */
function pruneRouteCandidatesForQuote(
    candidates: RouteCandidate[],
    preferred?: RouteCandidate
): RouteCandidate[] {
    const sorted = [...candidates].sort(compareRoutePriority)
    const pruned =
        sorted.length <= MAX_QUOTE_CANDIDATES
            ? sorted
            : sorted.slice(0, MAX_QUOTE_CANDIDATES)
    if (preferred && !pruned.some((r) => r.indexPath.join(',') === preferred.indexPath.join(','))) {
        return [preferred, ...pruned.slice(0, MAX_QUOTE_CANDIDATES - 1)]
    }
    return pruned
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

    const { data: pairs, isLoading: pairsLoading } = useReadContract({
        abi: PoolManagerAbi,
        address: PoolManagerAddress,
        functionName: 'getPairs',
        query: { enabled: isConnected },
    })

    const { data: poolsRaw, isLoading: poolsLoading } = useReadContract({
        abi: PoolManagerAbi,
        address: PoolManagerAddress,
        functionName: 'getAllPools',
        query: { enabled: isConnected },
    })

    const allPools = useMemo(() => normalizePools(poolsRaw), [poolsRaw])
    const pairList = useMemo(() => (pairs as Pair[] | undefined) ?? [], [pairs])

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

    const { data: symbolResults } = useReadContracts({
        contracts: tokenAddresses.map((addr) => ({
            address: addr,
            abi: erc20Abi,
            functionName: 'symbol' as const,
        })),
        query: { enabled: tokenAddresses.length > 0 },
    })

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

    const heuristicRoute = useMemo(
        () => pickHeuristicBestRoute(routeCandidates),
        [routeCandidates]
    )

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

        const swappableRoutes = filterSwappableRoutes(routeCandidates, addressToCanonical)
        if (!swappableRoutes.length) {
            const blockReason =
                heuristicRoute
                    ? getRouteSwapBlockReason(heuristicRoute, addressToCanonical)
                    : null
            setQuoteError(
                blockReason ?? '该兑换方向在池子价格区间外，请反向兑换或等待价格回到区间内'
            )
            return
        }

        setIsQuoting(true)
        setQuoteError('')
        try {
            const candidatesToQuote = pruneRouteCandidatesForQuote(
                swappableRoutes,
                heuristicRoute
            )
            const quoteResults = await Promise.allSettled(
                candidatesToQuote.map(async (route) => {
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
        heuristicRoute,
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
            const blockReason =
                heuristicRoute
                    ? getRouteSwapBlockReason(heuristicRoute, addressToCanonical)
                    : null
            setQuoteError(
                blockReason ?? '该兑换方向在池子价格区间外，请反向兑换或等待价格回到区间内'
            )
            return
        }

        setIsQuoting(true)
        setQuoteError('')
        try {
            const candidatesToQuote = pruneRouteCandidatesForQuote(
                swappableRoutes,
                heuristicRoute
            )
            const quoteResults = await Promise.allSettled(
                candidatesToQuote.map(async (route) => {
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
        heuristicRoute,
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
