/**
 * Position 页：展示我的流动性仓位，并通过弹窗添加流动性。
 * 链上流程：选 token → 选 pool(index) → approve → PositionManager.mint
 */
import DataTable from '../../components/table'
import { poscolumns } from '../../tableinfo/tableinfo'
import { use, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { PositionManagerAbi } from '../../abi/PositionManager'
import { PoolManagerAbi } from '../../abi/PoolManager'
import {
    useAccount,
    useReadContract,
    useReadContracts,
    useWriteContract,
    useWaitForTransactionReceipt,
} from 'wagmi'
import {
    PositionRawData,
    normalizePosition,
    PositionData,
    normalizePools,
    type PoolRawData,
} from '../../utils/coomputer'
import { erc20Abi, type Address, maxUint256, parseUnits } from 'viem'
/** 建池、查 pool 列表 */
const PoolManagerAddress = '0xddC12b3F9F7C91C79DA7433D8d212FB78d609f7B'
/** 加流动性、mint NFT 仓位；approve 的 spender 也是它 */
const PositionManagerAddress = '0xbe766Bf20eFfe431829C5d5a2744865974A0B610'
/** PoolManager.getPairs 返回的单条交易对 */
type Pair = {
    token0: Address
    token1: Address
}
/** 下拉选项：显示 symbol，值为合约地址 */
type TokenOption = {
    label: string
    value: Address
}
/** 选池下拉：value 为 pool index，pool 为完整链上数据 */
type PoolOption = {
    label: string
    value: number
    pool: PoolRawData
}
/** 地址 → symbol，读失败时用缩短地址 */
function tokenSymbol(addr: Address, tokenOptions: TokenOption[]): string {
    return (
        tokenOptions.find((o) => o.value.toLowerCase() === addr.toLowerCase())?.label
        ?? `${addr.slice(0, 6)}...${addr.slice(-4)}`
    )
}
/** 从 pool 数据计算费率、价格区间、当前价格（弹窗详情区展示） */
function getPoolPriceInfo(pool: PoolRawData) {
    const feePercent = (pool.fee / 10000).toFixed(2) + '%'
    const tickLowerPrice = (1.0001 ** pool.tickLower).toFixed(2)
    const tickUpperPrice = (1.0001 ** pool.tickUpper).toFixed(2)
    const Q96 = 2 ** 96
    const currentPrice = ((Number(pool.sqrtPriceX96) / Q96) ** 2).toFixed(2)
    return { feePercent, tickLowerPrice, tickUpperPrice, currentPrice }
}
/** 选池下拉文案：仅 index + 币对 */
function formatPoolOptionLabel(pool: PoolRawData, tokenOptions: TokenOption[]): string {
    const sym0 = tokenSymbol(pool.token0, tokenOptions)
    const sym1 = tokenSymbol(pool.token1, tokenOptions)
    return `[index=${pool.index}] ${sym0}/${sym1}`
}
/** 链上交易步骤，用于 approve / mint 串行 */
type TxStep = 'idle' | 'approve' | 'mint' | 'confirm' | 'approve0' | 'approve1'
export default function Position() {
    // --- 弹窗表单 state ---
    const [selectedToken0, setSelectedToken0] = useState('')
    const [selectedToken1, setSelectedToken1] = useState('')
    const [selectedPoolIndex, setSelectedPoolIndex] = useState<number | ''>('')
    const [amount0, setAmount0] = useState('')
    const [amount1, setAmount1] = useState('')
    const [showMask, setShowMask] = useState(false)
    const [txStep, setTxStep] = useState<TxStep>('idle')
    /** approve / mint 串行过程中保存本次存入数量，交易确认后继续流程 */
    const pendingAmountSRef = useRef<{ amount0: bigint; amount1: bigint } | null>(null)
    const { isConnected, address } = useAccount()
    // --- 读链：仓位列表 ---
    const { data: positions, isLoading, refetch: refetchPositions } = useReadContract({
        abi: PositionManagerAbi,
        address: PositionManagerAddress,
        functionName: 'getAllPositions',
        query: {
            enabled: isConnected,
        },
    })
    // --- 读链：已注册交易对，供 token 下拉 ---
    const { data: pairs, isLoading: pairsLoading } = useReadContract({
        abi: PoolManagerAbi,
        address: PoolManagerAddress,
        functionName: 'getPairs',
        query: {
            enabled: isConnected,
        },
    })
    // --- 读链：全部池子，用于按 token0+token1 过滤并选 index ---
    const { data: poolsRaw, isLoading: poolsLoading, refetch: refetchPools } = useReadContract({
        abi: PoolManagerAbi,
        address: PoolManagerAddress,
        functionName: 'getAllPools',
        query: {
            enabled: isConnected,
        },
    })
    const allPools = useMemo(() => normalizePools(poolsRaw), [poolsRaw])
    const pairList = useMemo(() => (pairs as Pair[] | undefined) ?? [], [pairs])
    // 从 pairs 收集不重复 token 地址，用于批量读 symbol
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
        contracts: tokenAddresses.map((address) => ({
            address,
            abi: erc20Abi,
            functionName: 'symbol' as const,
        })),
        query: { enabled: tokenAddresses.length > 0 },
    })
    // 地址 → symbol 映射
    const tokenOptions = useMemo<TokenOption[]>(() => {
        return tokenAddresses.map((addr, i) => {
            const symbol =
                symbolResults?.[i]?.status === 'success'
                    ? (symbolResults[i].result as string)
                    : `${addr.slice(0, 6)}...${addr.slice(-4)}`
            return { label: symbol, value: addr }
        })
    }, [tokenAddresses, symbolResults])
    // 合约要求 token0 < token1，下拉只列 pair 里作为 token0 的地址
    const token0Options = useMemo(() => {
        if (!pairList.length) return [] as TokenOption[]
        const addrs = Array.from(new Set(pairList.map((p) => p.token0.toLowerCase())))
        return addrs.map((addr) => {
            const opt = tokenOptions.find((o) => o.value.toLowerCase() === addr)
            return opt ?? { label: addr, value: addr as Address }
        })
    }, [pairList, tokenOptions])
    // 选定 token0 后，只展示与之配对的 token1
    const token1Options = useMemo(() => {
        if (!selectedToken0 || !pairList.length) return [] as TokenOption[]
        return pairList
            .filter((p) => p.token0.toLowerCase() === selectedToken0.toLowerCase())
            .map((p) => {
                const opt = tokenOptions.find(
                    (o) => o.value.toLowerCase() === p.token1.toLowerCase()
                )
                return opt ?? { label: p.token1, value: p.token1 }
            })
    }, [selectedToken0, pairList, tokenOptions])
    // 同一币对可有多个 pool（不同 fee / tick），用 index 区分
    const matchedPools = useMemo(() => {
        if (!selectedToken0 || !selectedToken1) return [] as PoolRawData[]
        return allPools.filter(
            (p) =>
                p.token0.toLowerCase() === selectedToken0.toLowerCase() &&
                p.token1.toLowerCase() === selectedToken1.toLowerCase()
        )
    }, [allPools, selectedToken0, selectedToken1])
    const poolOptions = useMemo<PoolOption[]>(() => {
        return matchedPools.map((pool) => ({
            value: pool.index,
            pool,
            label: formatPoolOptionLabel(pool, tokenOptions),
        }))
    }, [matchedPools, tokenOptions])
    /** mint 时传入的 index，须与 getAllPools 返回一致 */
    const selectedPool = useMemo(() => {
        if (selectedPoolIndex === '') return undefined
        return matchedPools.find((p) => p.index === selectedPoolIndex)
    }, [matchedPools, selectedPoolIndex])
    const selectedPoolPriceInfo = useMemo(
        () => (selectedPool ? getPoolPriceInfo(selectedPool) : null),
        [selectedPool]
    )
    // 选中 pool 后读 decimals + allowance(owner, PositionManager)
    const { data: tokenMetaResults, refetch: refetchAllowance } = useReadContracts({
        contracts:
            address && selectedPool
                ? [
                    {
                        address: selectedPool.token0,
                        abi: erc20Abi,
                        functionName: 'decimals' as const,
                    },
                    {
                        address: selectedPool.token1,
                        abi: erc20Abi,
                        functionName: 'decimals' as const,
                    },
                    {
                        address: selectedPool.token0,
                        abi: erc20Abi,
                        functionName: 'allowance' as const,
                        args: [address, PositionManagerAddress],
                    },
                    {
                        address: selectedPool.token1,
                        abi: erc20Abi,
                        functionName: 'allowance' as const,
                        args: [address, PositionManagerAddress],
                    },
                ]
                : [],
        query: {
            enabled: !!address && !!selectedPool,
        }
    })
    const decimals0 = Number(tokenMetaResults?.[0]?.result ?? 18)
    const decimals1 = Number(tokenMetaResults?.[1]?.result ?? 18)
    const allowance0 = tokenMetaResults?.[2]?.status === 'success'
        ? (tokenMetaResults[2].result as bigint) : 0n
    const allowance1 = tokenMetaResults?.[3]?.status === 'success'
        ? (tokenMetaResults[3].result as bigint) : 0n
    // 按当前钱包地址过滤仓位；liquidity 与 owed 均为 0 的视为已退出，不展示
    const myPositions = useMemo(() => {
        if (!address || !positions) return []
        return (positions as PositionRawData[]).filter((pos) => {
            if (pos.owner.toLowerCase() !== address.toLowerCase()) return false
            const hasLiquidity = pos.liquidity > 0n
            const hasOwed = pos.tokensOwed0 > 0n || pos.tokensOwed1 > 0n
            return hasLiquidity || hasOwed
        })
    }, [positions, address])
    // 与 Pool 页 poolsData 合并，补全 token 名、价格区间等展示字段
    const tableData = useMemo(
        () => PositionData(normalizePosition(myPositions)),
        [myPositions]
    )
    // --- 写链：approve / mint ---
    const { writeContract, data: hash, isPending, error: writeError } = useWriteContract()
    const { isLoading: isConfirming, isSuccess: isTxSuccess } =
        useWaitForTransactionReceipt({ hash })
    const isSubmitting = isPending || isConfirming
    const {
        writeContract: writePositionAction,
        data: positionActionHash,
        isPending: isPositionActionPending,
    } = useWriteContract()
    const { isLoading: isPositionActionConfirming, isSuccess: isPositionActionSuccess } =
        useWaitForTransactionReceipt({ hash: positionActionHash })
    const isPositionActionSubmitting = isPositionActionPending || isPositionActionConfirming
    /** 输入框数量 → parseUnits 最小单位 */
    function parseDesiredAmount() {
        try {
            const amount0Desired = parseUnits(amount0, decimals0)
            const amount1Desired = parseUnits(amount1, decimals1)
            if (amount0Desired <= 0n || amount1Desired <= 0n) throw new Error('数量不能为0')
            return { amount0Desired, amount1Desired }
        } catch (error) {
            throw new Error('存入数量格式不正确')
        }
    }
    /** ERC20.approve：授权 token0 给 PositionManager 扣款 */
    const approveToken0 = useCallback((approveAmount: bigint) => {
        if (!selectedPool) return
        writeContract({
            address: selectedPool.token0,
            abi: erc20Abi,
            functionName: 'approve',
            args: [PositionManagerAddress, approveAmount],
        })
        setTxStep('approve0')
    }, [selectedPool, writeContract]
    )
    /** ERC20.approve：授权 token1 给 PositionManager 扣款 */
    const approveToken1 = useCallback((approveAmount: bigint) => {
        if (!selectedPool) return
        writeContract({
            address: selectedPool.token1,
            abi: erc20Abi,
            functionName: 'approve',
            args: [PositionManagerAddress, approveAmount],
        })
        setTxStep('approve1')
    }, [selectedPool, writeContract]
    )
    /** PositionManager.mint(MintParams)；recipient 收 NFT 仓位 */
    const mitLiquidity = useCallback(
        (amount0Desired: bigint, amount1Desired: bigint) => {
            if (!selectedPool || !address) return
            writeContract({
                address: PositionManagerAddress,
                abi: PositionManagerAbi,
                functionName: 'mint',
                args: [
                    {
                        token0: selectedPool.token0,
                        token1: selectedPool.token1,
                        index: selectedPool.index,
                        amount0Desired,
                        amount1Desired,
                        recipient: address,
                        deadline: Math.floor(Date.now() / 1000) + 3600,
                    }
                ],
            })
            setTxStep('mint')
        },
        [selectedPool, address, writeContract]
    )
    /**
     * 加流动性主流程：
     * 1. refetch 最新 allowance
     * 2. token0 不足 → approve0 并 return（等 tx 确认后 useEffect 再继续）
     * 3. token1 不足 → approve1 并 return
     * 4. 都够 → mint
     */
    const continueAddPositionFlow = useCallback(
        async (amount0Desired: bigint, amount1Desired: bigint) => {
            if (!selectedPool) return
            pendingAmountSRef.current = { amount0: amount0Desired, amount1: amount1Desired }
            const { data: latesMeta } = await refetchAllowance()
            const latestAllowance0 = latesMeta?.[2]?.status === 'success'
                ? (latesMeta[2].result as bigint)
                : 0n
            const latestAllowance1 =
                latesMeta?.[3]?.status === 'success'
                    ? (latesMeta[3].result as bigint)
                    : 0n
            if (latestAllowance0 < amount0Desired) {
                approveToken0(amount0Desired)
                return
            }
            if (latestAllowance1 < amount1Desired) {
                approveToken1(amount1Desired)
                return
            }
            mitLiquidity(amount0Desired, amount1Desired)
        },
        [selectedPool, address, approveToken0, approveToken1, mitLiquidity]
    )
    const burnPosition = useCallback((item: { id: string | number | bigint }) => {
        if (!isConnected) {
            alert('请先连接钱包')
            return
        }
        writePositionAction({
            address: PositionManagerAddress,
            abi: PositionManagerAbi,
            functionName: 'burn',
            args: [BigInt(item.id)],
        })
    }, [isConnected, writePositionAction])
    const collectPosition = useCallback((item: { id: string | number | bigint }) => {
        if (!isConnected || !address) {
            alert('请先连接钱包')
            return
        }
        writePositionAction({
            address: PositionManagerAddress,
            abi: PositionManagerAbi,
            functionName: 'collect',
            args: [BigInt(item.id), address],
        })
    }, [isConnected, address, writePositionAction])
    /** 点击「创建」：校验 → parseUnits → 进入 approve/mint 流程 */
    const addPosition = () => {
        if (!isConnected || !address) {
            alert('请先连接钱包')
            return
        }
        if (!selectedToken0 || !selectedToken1) {
            alert('请选择 token0 和 token1')
            return
        }
        if (!selectedPool) {
            alert('请选择池子')
            return
        }
        if (!amount0.trim() || !amount1.trim()) {
            alert('请填写存入数量')
            return
        }
        if (isSubmitting) return
        try {
            const { amount0Desired, amount1Desired } = parseDesiredAmount()
            continueAddPositionFlow(amount0Desired, amount1Desired)
        } catch (e) {
            alert(e instanceof Error ? e.message : '参数错误')
        }
        //判断是否授权，没有授权的话，需要授权
        // 添加流动性
        // alert(
        //     `待接入 mint：index=${selectedPool.index}, token0=${selectedPool.token0}, token1=${selectedPool.token1}, amount0=${amount0}, amount1=${amount1}, recipient=${address}`
        // )
    }
    // 仅一个 pool 时自动选中
    useEffect(() => {
        if (matchedPools.length === 1) {
            setSelectedPoolIndex(matchedPools[0].index)
        }
    }, [matchedPools])
    /** 上一笔链上交易确认后自动续跑：approve → mint → 刷新列表 */
    useEffect(() => {
        if (!isTxSuccess || txStep === 'idle') return
        const pending = pendingAmountSRef.current
        if (!pending) return
        if (txStep === 'approve0' || txStep === 'approve1') {
            continueAddPositionFlow(pending.amount0, pending.amount1)
        } else if (txStep === 'mint') {
            refetchPositions()
            refetchPools()
            setTxStep('idle')
            setShowMask(false)
            alert('添加流动性成功')
        }
    }, [isTxSuccess, txStep, continueAddPositionFlow, refetchPositions, refetchPools])
    useEffect(() => {
        if (!isPositionActionSuccess) return
        refetchPositions()
        refetchPools()
        alert('操作成功')
    }, [isPositionActionSuccess, refetchPositions, refetchPools])
    const poolSelectPlaceholder = !selectedToken1
        ? '请先选择 token1'
        : poolsLoading
            ? '加载池子中...'
            : poolOptions.length === 0
                ? '该币对暂无池子，请先去 Pool 页建池'
                : '请选择池子'
    const logSelectedTokenAddress = useCallback((selectedAddress: string) => {
        if (!selectedAddress) return
        const selectedOption = tokenOptions.find(
            (opt) => opt.value.toLowerCase() === selectedAddress.toLowerCase()
        )
        console.log(`${selectedOption?.label ?? 'token'} 地址:`, selectedAddress)
    }, [tokenOptions])
    return (
        <>
            {/* 加流动性弹窗 */}
            {showMask && (
                <>
                    <div
                        className='fixed inset-0 bg-black/50 z-50'
                        onClick={() => setShowMask(false)}
                    />
                    <div
                        className='fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-[51] w-[480px] max-h-[90vh] overflow-y-auto bg-white rounded-md shadow-xl'
                        onClick={(e) => e.stopPropagation()}
                    >
                        <div className='items-center px-5 py-4 border-b'>
                            <h3 className='text-lg font-semibold'>add position</h3>
                        </div>
                        <div className='px-5 py-4 space-y-5'>
                            <div className='space-y-3'>
                                <div>
                                    <p className='text-sm mb-1'>token0 symbol：</p>
                                    <select
                                        className='w-full border rounded-xl px-4 py-3 outline-none focus:ring-2 focus:ring-blue-500 appearance-none bg-white cursor-pointer disabled:opacity-50'
                                        value={selectedToken0}
                                        disabled={pairsLoading}
                                        onChange={(e) => {
                                            const selectedAddress = e.target.value
                                            setSelectedToken0(selectedAddress)
                                            setSelectedToken1('')
                                            setSelectedPoolIndex('')
                                            logSelectedTokenAddress(selectedAddress)
                                        }}
                                    >
                                        <option value=''>请选择 token0</option>
                                        {token0Options.map((opt) => (
                                            <option key={opt.value} value={opt.value}>
                                                {opt.label}
                                            </option>
                                        ))}
                                    </select>
                                </div>
                                <div>
                                    <p className='text-sm mb-1'>token1 symbol：</p>
                                    <select
                                        className='w-full border rounded-xl px-4 py-3 outline-none focus:ring-2 focus:ring-blue-500 appearance-none bg-white cursor-pointer disabled:opacity-50'
                                        value={selectedToken1}
                                        disabled={!selectedToken0 || pairsLoading}
                                        onChange={(e) => {
                                            const selectedAddress = e.target.value
                                            setSelectedToken1(selectedAddress)
                                            setSelectedPoolIndex('')
                                            logSelectedTokenAddress(selectedAddress)
                                        }}
                                    >
                                        <option value=''>请选择 token1</option>
                                        {token1Options.map((opt) => (
                                            <option key={opt.value} value={opt.value}>
                                                {opt.label}
                                            </option>
                                        ))}
                                    </select>
                                </div>
                                <div>
                                    <p className='text-sm mb-1'>
                                        <span className='text-red-500'>*</span> 选择池子：
                                    </p>
                                    <select
                                        className='w-full border rounded-xl px-4 py-3 outline-none focus:ring-2 focus:ring-blue-500 appearance-none bg-white cursor-pointer disabled:opacity-50'
                                        value={selectedPoolIndex === '' ? '' : String(selectedPoolIndex)}
                                        disabled={!selectedToken1 || poolsLoading || poolOptions.length === 0}
                                        onChange={(e) => setSelectedPoolIndex(Number(e.target.value))}
                                    >
                                        <option value=''>{poolSelectPlaceholder}</option>
                                        {poolOptions.map((opt) => (
                                            <option key={`${opt.pool.pool}-${opt.value}`} value={opt.value}>
                                                {opt.label}
                                            </option>
                                        ))}
                                    </select>
                                </div>
                                <div>
                                    <p className='text-sm mb-1'>费率：</p>
                                    <input
                                        type='text'
                                        disabled
                                        value={selectedPoolPriceInfo?.feePercent ?? ''}
                                        placeholder='请选择池子后显示'
                                        className='w-full border rounded-xl px-4 py-3 outline-none bg-gray-100 text-gray-500 cursor-not-allowed'
                                    />
                                </div>
                                <div>
                                    <p className='text-sm mb-1'>价格区间：</p>
                                    <input
                                        type='text'
                                        disabled
                                        value={selectedPoolPriceInfo
                                            ? `${selectedPoolPriceInfo.tickLowerPrice} ~ ${selectedPoolPriceInfo.tickUpperPrice}`
                                            : ''}
                                        placeholder='请选择池子后显示'
                                        className='w-full border rounded-xl px-4 py-3 outline-none bg-gray-100 text-gray-500 cursor-not-allowed'
                                    />
                                </div>
                                <div>
                                    <p className='text-sm mb-1'>当前价格：</p>
                                    <input
                                        type='text'
                                        disabled
                                        value={selectedPoolPriceInfo?.currentPrice ?? ''}
                                        placeholder='请选择池子后显示'
                                        className='w-full border rounded-xl px-4 py-3 outline-none bg-gray-100 text-gray-500 cursor-not-allowed'
                                    />
                                </div>
                                <div>
                                    <p className='text-sm mb-1'>token0 存入数量：</p>
                                    <input
                                        type='text'
                                        placeholder='0'
                                        value={amount0}
                                        onChange={(e) => setAmount0(e.target.value)}
                                        className='w-full border rounded-xl px-4 py-3 outline-none focus:ring-2 focus:ring-blue-500'
                                    />
                                </div>
                                <div>
                                    <p className='text-sm mb-1'>token1 存入数量：</p>
                                    <input
                                        type='text'
                                        placeholder='0'
                                        value={amount1}
                                        onChange={(e) => setAmount1(e.target.value)}
                                        className='w-full border rounded-xl px-4 py-3 outline-none focus:ring-2 focus:ring-blue-500'
                                    />
                                </div>
                            </div>
                        </div>
                        <div className='flex justify-end gap-3 px-5 py-4 border-t bg-gray-50'>
                            <button
                                className='px-6 py-2.5 border rounded-xl hover:bg-gray-100 transition-colors'
                                onClick={() => setShowMask(false)}
                            >
                                取消
                            </button>
                            <button
                                className='px-6 py-2.5 bg-blue-500 text-white rounded-xl hover:bg-blue-600 transition-colors font-medium'
                                onClick={addPosition}
                            >
                                创建
                            </button>
                        </div>
                    </div>
                </>
            )}
            {/* 我的仓位列表 */}
            <div className='border max-w-6xl mx-auto px-6 py-8'>
                <div>
                    <h2 className='text-2xl font-bold'>Positions</h2>
                </div>
                <div className='flex justify-between items-center px-4 py-2'>
                    <div>My Positions</div>
                    <div>
                        <button
                            className='border px-4 py-2 rounded-md ml-4 bg-blue-500 text-white'
                            onClick={() => setShowMask(true)}
                        >
                            Add
                        </button>
                    </div>
                </div>
                <div className='px-4 py-2'>
                    {isConnected && isLoading && (
                        <div className='text-center py-8 text-muted-foreground'>
                            加载仓位数据...
                        </div>
                    )}
                    <DataTable
                        columns={poscolumns}
                        data={tableData}
                        itemsPerpahe={5}
                        onBurn={burnPosition}
                        onCollect={collectPosition}
                        actionLoading={isPositionActionSubmitting}
                    />
                </div>
            </div>
        </>
    )
}
