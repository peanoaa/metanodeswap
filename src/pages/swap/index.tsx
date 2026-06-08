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
} from 'wagmi'
import { simulateContract } from 'wagmi/actions'
import { normalizePools, type PoolRawData } from '../../utils/coomputer'
import { erc20Abi, formatUnits, type Address, parseUnits } from 'viem'

const PoolManagerAddress = '0xddC12b3F9F7C91C79DA7433D8d212FB78d609f7B'
/** 请替换为链上已部署的 SwapRouter 地址 */
const SwapRouterAddress = '0x0000000000000000000000000000000000000000' as Address

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

function tokenSymbol(addr: string, tokenOptions: TokenOption[]): string {
    return (
        tokenOptions.find((o) => o.value.toLowerCase() === addr.toLowerCase())?.label
        ?? `${addr.slice(0, 6)}...${addr.slice(-4)}`
    )
}

function getPoolPriceInfo(pool: PoolRawData) {
    const feePercent = (pool.fee / 10000).toFixed(2) + '%'
    const tickLowerPrice = (1.0001 ** pool.tickLower).toFixed(2)
    const tickUpperPrice = (1.0001 ** pool.tickUpper).toFixed(2)
    const Q96 = 2 ** 96
    const currentPrice = ((Number(pool.sqrtPriceX96) / Q96) ** 2).toFixed(2)
    return { feePercent, tickLowerPrice, tickUpperPrice, currentPrice }
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

function getPoolsForTokens(tokenA: string, tokenB: string, allPools: PoolRawData[]): PoolRawData[] {
    const al = tokenA.toLowerCase()
    const bl = tokenB.toLowerCase()
    return allPools.filter(
        (p) =>
            (p.token0.toLowerCase() === al && p.token1.toLowerCase() === bl) ||
            (p.token1.toLowerCase() === al && p.token0.toLowerCase() === bl)
    )
}

/** 每条 token 路径展开为所有 indexPath 组合 */
function enumerateRouteCandidates(tokenPath: string[], allPools: PoolRawData[]): RouteCandidate[] {
    if (tokenPath.length < 2) return []

    const edges: PoolRawData[][] = []
    for (let i = 0; i < tokenPath.length - 1; i++) {
        const pools = getPoolsForTokens(tokenPath[i], tokenPath[i + 1], allPools)
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

function pickHeuristicBestRoute(candidates: RouteCandidate[]): RouteCandidate | undefined {
    if (!candidates.length) return undefined
    return [...candidates].sort((a, b) => {
        if (a.tokenPath.length !== b.tokenPath.length) {
            return a.tokenPath.length - b.tokenPath.length
        }
        const minLiquidity = (r: RouteCandidate) =>
            Math.min(...r.pools.map((p) => Number(p.liquidity)))
        return minLiquidity(b) - minLiquidity(a)
    })[0]
}

function formatRouteLabel(route: RouteCandidate, tokenOptions: TokenOption[]): string {
    const symbols = route.tokenPath.map((addr) => tokenSymbol(addr, tokenOptions))
    const hop = route.tokenPath.length - 1
    const hopText = hop === 1 ? '直连' : `${hop} 跳`
    const indexes = route.indexPath.map((i) => `index=${i}`).join(' → ')
    return `${symbols.join(' → ')}（${hopText}，${indexes}）`
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
        const set = new Set<string>()
        pairList.forEach((p) => {
            set.add(p.token0)
            set.add(p.token1)
        })
        return Array.from(set).map((a) => a as Address)
    }, [pairList])

    const { data: symbolResults } = useReadContracts({
        contracts: tokenAddresses.map((addr) => ({
            address: addr,
            abi: erc20Abi,
            functionName: 'symbol' as const,
        })),
        query: { enabled: tokenAddresses.length > 0 },
    })

    const tokenOptions = useMemo<TokenOption[]>(() => {
        return tokenAddresses.map((addr, i) => {
            const symbol =
                symbolResults?.[i]?.status === 'success'
                    ? (symbolResults[i].result as string)
                    : `${addr.slice(0, 6)}...${addr.slice(-4)}`
            return { label: symbol, value: addr }
        })
    }, [tokenAddresses, symbolResults])

    const tokenInOptions = tokenOptions

    const tokenOutOptions = useMemo(() => {
        if (!selectedTokenIn || !pairList.length) return [] as TokenOption[]
        const addrs = new Set<string>()
        pairList.forEach((p) => {
            if (p.token0.toLowerCase() === selectedTokenIn.toLowerCase()) addrs.add(p.token1)
            if (p.token1.toLowerCase() === selectedTokenIn.toLowerCase()) addrs.add(p.token0)
        })
        return Array.from(addrs).map((addr) => {
            const opt = tokenOptions.find((o) => o.value.toLowerCase() === addr.toLowerCase())
            return opt ?? { label: addr, value: addr as Address }
        })
    }, [selectedTokenIn, pairList, tokenOptions])

    const routeCandidates = useMemo(() => {
        if (!selectedTokenIn || !selectedTokenOut) return [] as RouteCandidate[]
        const tokenPaths = findTokenPaths(selectedTokenIn, selectedTokenOut, pairList)
        return tokenPaths.flatMap((path) => enumerateRouteCandidates(path, allPools))
    }, [selectedTokenIn, selectedTokenOut, pairList, allPools])

    const tokenInAddress = selectedTokenIn as Address
    const tokenOutAddress = selectedTokenOut as Address

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
                        address: tokenInAddress,
                        abi: erc20Abi,
                        functionName: 'balanceOf' as const,
                        args: [address],
                    },
                    {
                        address: tokenInAddress,
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
    const balanceIn = tokenMetaResults?.[2]?.status === 'success'
        ? (tokenMetaResults[2].result as bigint)
        : 0n
    const routerConfigured =
        SwapRouterAddress !== '0x0000000000000000000000000000000000000000'

    const heuristicRoute = useMemo(
        () => pickHeuristicBestRoute(routeCandidates),
        [routeCandidates]
    )

    const displayRoute = bestRoute ?? heuristicRoute

    const routeLabel = useMemo(
        () => (displayRoute ? formatRouteLabel(displayRoute, tokenOptions) : ''),
        [displayRoute, tokenOptions]
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

        setIsQuoting(true)
        setQuoteError('')
        try {
            let bestIdx = -1
            let bestOut = 0n
            for (let i = 0; i < routeCandidates.length; i++) {
                const route = routeCandidates[i]
                try {
                    const { result } = await simulateContract(config, {
                        address: SwapRouterAddress,
                        abi: SwapRouterAbi,
                        functionName: 'quoteExactInput',
                        args: [
                            {
                                tokenIn: tokenInAddress,
                                tokenOut: tokenOutAddress,
                                indexPath: route.indexPath,
                                amountIn: amountInParsed,
                                sqrtPriceLimitX96: 0n,
                            },
                        ],
                    })
                    const out = result as bigint
                    if (out > bestOut) {
                        bestOut = out
                        bestIdx = i
                    }
                } catch {
                    // 跳过不可用路径
                }
            }
            if (bestIdx < 0) {
                setQuoteError('报价失败，请检查数量或流动性')
                return
            }
            setBestRoute(routeCandidates[bestIdx])
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
        tokenInAddress,
        tokenOutAddress,
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

        setIsQuoting(true)
        setQuoteError('')
        try {
            let bestIdx = -1
            let bestIn: bigint | undefined
            for (let i = 0; i < routeCandidates.length; i++) {
                const route = routeCandidates[i]
                try {
                    const { result } = await simulateContract(config, {
                        address: SwapRouterAddress,
                        abi: SwapRouterAbi,
                        functionName: 'quoteExactOutput',
                        args: [
                            {
                                tokenIn: tokenInAddress,
                                tokenOut: tokenOutAddress,
                                indexPath: route.indexPath,
                                amountOut: amountOutParsed,
                                sqrtPriceLimitX96: 0n,
                            },
                        ],
                    })
                    const amountInNeeded = result as bigint
                    if (bestIn === undefined || amountInNeeded < bestIn) {
                        bestIn = amountInNeeded
                        bestIdx = i
                    }
                } catch {
                    // 跳过不可用路径
                }
            }
            if (bestIdx < 0 || bestIn === undefined) {
                setQuoteError('报价失败，请检查数量或流动性')
                return
            }
            setBestRoute(routeCandidates[bestIdx])
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
        tokenInAddress,
        tokenOutAddress,
    ])

    const selectedPoolPriceInfo = useMemo(() => {
        if (!displayRoute || displayRoute.pools.length !== 1) return null
        return getPoolPriceInfo(displayRoute.pools[0])
    }, [displayRoute])

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
        (approveAmount: bigint) => {
            if (!selectedTokenIn) return
            writeContract({
                address: tokenInAddress,
                abi: erc20Abi,
                functionName: 'approve',
                args: [SwapRouterAddress, approveAmount],
            })
            setTxStep('approve')
        },
        [selectedTokenIn, tokenInAddress, writeContract]
    )

    const executeExactInput = useCallback(
        (amountInDesired: bigint, amountOutMinimum: bigint, indexPath: number[]) => {
            if (!address) return
            writeContract({
                address: SwapRouterAddress,
                abi: SwapRouterAbi,
                functionName: 'exactInput',
                args: [
                    {
                        tokenIn: tokenInAddress,
                        tokenOut: tokenOutAddress,
                        indexPath,
                        recipient: address,
                        deadline: Math.floor(Date.now() / 1000) + 3600,
                        amountIn: amountInDesired,
                        amountOutMinimum,
                        sqrtPriceLimitX96: 0n,
                    },
                ],
            })
            setTxStep('swap')
        },
        [address, tokenInAddress, tokenOutAddress, writeContract]
    )

    const executeExactOutput = useCallback(
        (amountOutDesired: bigint, amountInMaximum: bigint, indexPath: number[]) => {
            if (!address) return
            writeContract({
                address: SwapRouterAddress,
                abi: SwapRouterAbi,
                functionName: 'exactOutput',
                args: [
                    {
                        tokenIn: tokenInAddress,
                        tokenOut: tokenOutAddress,
                        indexPath,
                        recipient: address,
                        deadline: Math.floor(Date.now() / 1000) + 3600,
                        amountOut: amountOutDesired,
                        amountInMaximum,
                        sqrtPriceLimitX96: 0n,
                    },
                ],
            })
            setTxStep('swap')
        },
        [address, tokenInAddress, tokenOutAddress, writeContract]
    )

    const continueSwapFlow = useCallback(
        async (
            approveAmount: bigint,
            indexPath: number[],
            mode: QuoteMode
        ) => {
            pendingAmountInRef.current = approveAmount
            pendingQuoteModeRef.current = mode
            const { data: latestMeta } = await refetchAllowance()
            const latestAllowance =
                latestMeta?.[3]?.status === 'success'
                    ? (latestMeta[3].result as bigint)
                    : 0n

            if (latestAllowance < approveAmount) {
                approveTokenIn(approveAmount)
                return
            }

            if (mode === 'exactOutput') {
                const amountOutDesired = parseUnits(amountOut, decimalsOut)
                executeExactOutput(amountOutDesired, approveAmount, indexPath)
                return
            }

            const amountInDesired = parseUnits(amountIn, decimalsIn)
            const amountOutMinimum =
                bestQuoteOut && bestQuoteOut > 0n ? (bestQuoteOut * 95n) / 100n : 0n
            executeExactInput(amountInDesired, amountOutMinimum, indexPath)
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
                continueSwapFlow(amountInDesired, route.indexPath, 'exactInput')
            } else {
                if (!amountOut.trim()) throw new Error('请填写 token1 数量')
                const amountOutDesired = parseUnits(amountOut, decimalsOut)
                if (amountOutDesired <= 0n) throw new Error('数量不能为 0')
                if (!bestQuoteIn || bestQuoteIn <= 0n) throw new Error('请先完成报价')
                const amountInMaximum = (bestQuoteIn * 105n) / 100n
                if (amountInMaximum > balanceIn) throw new Error('余额不足')
                pendingIndexPathRef.current = route.indexPath
                continueSwapFlow(amountInMaximum, route.indexPath, 'exactOutput')
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
        if (!pending || !indexPath || !mode) return

        if (txStep === 'approve') {
            continueSwapFlow(pending, indexPath, mode)
        } else if (txStep === 'swap') {
            setTxStep('idle')
            setAmountIn('')
            setAmountOut('')
            resetQuoteState()
            pendingAmountInRef.current = null
            pendingQuoteModeRef.current = null
            refetchAllowance()
            alert('兑换成功')
        }
    }, [isTxSuccess, txStep, continueSwapFlow, refetchAllowance, resetQuoteState])

    const routePlaceholder = !selectedTokenOut
        ? '请先选择接收 token'
        : poolsLoading
            ? '计算路径中...'
            : routeCandidates.length === 0
                ? '该币对暂无可用路径，请先去 Pool 页建池'
                : '自动计算最优路径'

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
                                        <option key={opt.value} value={opt.value}>
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
                                        <option key={opt.value} value={opt.value}>
                                            {opt.label}
                                        </option>
                                    ))}
                                </select>
                            </div>

                            <div>
                                <p className='text-sm mb-1'>最优路径：</p>
                                <input
                                    type='text'
                                    disabled
                                    value={routeLabel}
                                    placeholder={routePlaceholder}
                                    className='w-full border rounded-xl px-4 py-3 outline-none bg-gray-100 text-gray-500 cursor-not-allowed'
                                />
                            </div>

                            {selectedPoolPriceInfo && (
                                <>
                                    <div>
                                        <p className='text-sm mb-1'>费率：</p>
                                        <input
                                            type='text'
                                            disabled
                                            value={selectedPoolPriceInfo.feePercent}
                                            className='w-full border rounded-xl px-4 py-3 outline-none bg-gray-100 text-gray-500 cursor-not-allowed'
                                        />
                                    </div>

                                    <div>
                                        <p className='text-sm mb-1'>价格区间：</p>
                                        <input
                                            type='text'
                                            disabled
                                            value={`${selectedPoolPriceInfo.tickLowerPrice} ~ ${selectedPoolPriceInfo.tickUpperPrice}`}
                                            className='w-full border rounded-xl px-4 py-3 outline-none bg-gray-100 text-gray-500 cursor-not-allowed'
                                        />
                                    </div>

                                    <div>
                                        <p className='text-sm mb-1'>当前价格：</p>
                                        <input
                                            type='text'
                                            disabled
                                            value={selectedPoolPriceInfo.currentPrice}
                                            className='w-full border rounded-xl px-4 py-3 outline-none bg-gray-100 text-gray-500 cursor-not-allowed'
                                        />
                                    </div>
                                </>
                            )}

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
