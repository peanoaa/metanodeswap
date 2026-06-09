import DataTable from '../../components/table'
import { useRouter } from 'next/router'
import { poolcolumns } from '../../tableinfo/tableinfo'
import { isAddress } from 'viem'

import {
    useAccount,
    useReadContract,
    useWriteContract,
    useWaitForTransactionReceipt
} from 'wagmi'
import { PoolManagerAbi } from '../../abi/PoolManager'
import { usePoolTokens, normalizePools } from '../../utils/coomputer'
import { useState, useMemo, useEffect } from 'react'
// import Mask from '../../components/Mask'

//合约地址
const PoolManagerAddress = '0xddC12b3F9F7C91C79DA7433D8d212FB78d609f7B'


export default function Pool() {
    type PoolForm = {
        token0: string
        token1: string
        fee: string
        tickLower: string
        tickUpper: string
        sqrtPriceX96: string
    }

    const [form, setForm] = useState<PoolForm>({
        token0: '',
        token1: '',
        fee: '',
        tickLower: '',
        tickUpper: '',
        sqrtPriceX96: '',
    })
    //路由

    const router = useRouter();

    //控制遮罩显示
    const [showMask, setShowMask] = useState(false);

    //获取钱包链接状态
    const { isConnected } = useAccount()

    //读取合约，获取所有交易池
    const { data: poolsRaw, error, isLoading, refetch } = useReadContract({
        abi: PoolManagerAbi,
        address: PoolManagerAddress,
        functionName: 'getAllPools',
        query: {
            enabled: isConnected,
        }
    })
    // //查看返回值
    console.log('data:', poolsRaw);   // ← 检查返回值

    // 转换池子的数据格式
    const pools = useMemo(() => normalizePools(poolsRaw), [poolsRaw])

    //生成表格数据
    const { rows, isLoading: tken } = usePoolTokens(
        isConnected ? pools : undefined
    )

    //写合约
    const { writeContract, data: hash, isPending, error: writeError } = useWriteContract()

    //等待交易确认
    const { isLoading: isConfirming, isSuccess, isError: isReceiptError } =
        useWaitForTransactionReceipt({
            hash,
        })

    const isCreating = isPending || isConfirming
    //创建池子
    const createPoolIfNecessary = () => {
        try {
            //表单校验，格式转换
            const params = buildParams(form)
            writeContract({
                abi: PoolManagerAbi,
                address: PoolManagerAddress,
                functionName: 'createAndInitializePoolIfNecessary',
                args: [params],
            })
        } catch (error) {
            console.error(error)
        }


    }


    function buildParams(form: PoolForm) {
        const errors: string[] = []
        if (!form.token0.trim() || !isAddress(form.token0.trim())) errors.push('token0 无效')
        if (!form.token1.trim() || !isAddress(form.token1.trim())) errors.push('token1 无效')
        if (!form.fee.trim()) errors.push('fee 必填')
        if (!form.tickLower.trim()) errors.push('tickLower 必填')
        if (!form.tickUpper.trim()) errors.push('tickUpper 必填')
        if (!form.sqrtPriceX96.trim()) errors.push('sqrtPriceX96 必填')

        const token0 = form.token0.trim() as `0x${string}`
        const token1 = form.token1.trim() as `0x${string}`
        const fee = Number(form.fee)
        const tickLower = Number(form.tickLower)
        const tickUpper = Number(form.tickUpper)
        let sqrtPriceX96: bigint
        try {
            sqrtPriceX96 = BigInt(form.sqrtPriceX96.trim())
        } catch {
            errors.push('sqrtPriceX96 必须是整数')
            sqrtPriceX96 = BigInt(0)
        }
        if (token0.toLowerCase() >= token1.toLowerCase()) {
            errors.push('token0 地址必须小于 token1')
        }
        if (tickLower >= tickUpper) errors.push('tickLower 必须小于 tickUpper')
        if (errors.length) throw new Error(errors.join('；'))

        return {
            token0,
            token1,
            fee,
            tickLower,
            tickUpper,
            sqrtPriceX96,
        }
    }

    //池子创建成功后刷新表格
    useEffect(() => {
        if (!isSuccess) return

        const refresh = async () => {
            await refetch()           // 重新读 getAllPools
            setShowMask(false)        // 关闭建池表单
            // (true)      // 打开成功弹窗
            // 可选：清空表单
            setForm({
                token0: '',
                token1: '',
                fee: '',
                tickLower: '',
                tickUpper: '',
                sqrtPriceX96: '',
            })
            alert('池子创建成功！')
        }

        refresh()
    }, [isSuccess, refetch])




    return (
        <>
            {/* 遮罩 */}
            {showMask && (
                <>
                    {/* 半透明遮罩层 */}
                    <div
                        className='fixed inset-0 bg-black/50 z-50'
                        onClick={() => setShowMask(false)}
                    />
                    {/* 弹窗主体 */}
                    <div
                        className='fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-[51] w-[480px] bg-white rounded-md shadow-xl overflow-hidden'
                        onClick={(e) => e.stopPropagation()}
                    >
                        <div className='items-center  px-5 py-4 border-b'>
                            {/* //标题 */}
                            <h3 className='text-lg font-semibold'>add pool</h3>

                            {/* 内容 */}
                            <div>
                                <div>
                                    <span>token0：</span><input type="text" value={form.token0} onChange={(e) => setForm({ ...form, token0: e.target.value })} placeholder='token0' className='border px-4 py-2 rounded-md' />
                                </div>
                                <div>
                                    <span>token1：</span><input type="text" value={form.token1} onChange={(e) => setForm({ ...form, token1: e.target.value })} placeholder='token1' className='border px-4 py-2 rounded-md' />
                                </div>

                                <div>
                                    <span>fee：</span><input type="text" value={form.fee} onChange={(e) => setForm({ ...form, fee: e.target.value })} placeholder='fee' className='border px-4 py-2 rounded-md' />
                                </div>
                                <div>
                                    <span>tickLower：</span><input type="text" value={form.tickLower} onChange={(e) => setForm({ ...form, tickLower: e.target.value })} placeholder='tickLower' className='border px-4 py-2 rounded-md' />
                                </div>
                                <div>
                                    <span>tickUpper：</span><input type="text" value={form.tickUpper} onChange={(e) => setForm({ ...form, tickUpper: e.target.value })} placeholder='tickUpper' className='border px-4 py-2 rounded-md' />
                                </div>
                                <div>
                                    <span>sqrtPriceX96：</span><input type="text" value={form.sqrtPriceX96} onChange={(e) => setForm({ ...form, sqrtPriceX96: e.target.value })} placeholder='sqrtPriceX96' className='border px-4 py-2 rounded-md' />
                                </div>
                            </div>

                            {/* 底部按钮栏 */}
                            <div className='flex justify-end gap-3 px-5 py-4 border-t bg-gray-50'>
                                <button
                                    className='px-6 py-2.5 border rounded-xl hover:bg-gray-100 transition-colors'
                                    onClick={() => setShowMask(false)}
                                >
                                    取消
                                </button>
                                <button
                                    className='px-6 py-2.5 bg-blue-500 text-white rounded-xl hover:bg-blue-600 transition-colors font-medium'
                                    onClick={() => createPoolIfNecessary()}
                                >
                                    创建
                                </button>
                            </div>
                        </div>
                        {/* 这里放表单内容 */}
                    </div>
                </>
            )}
            <div className='border max-w-6xl mx-auto px-6 py-8'>
                <div>
                    <h2 className='text-2xl font-bold'>pool</h2>
                </div>
                <div className='flex justify-between items-center px-4 py-2'>
                    {/* 左侧 */}
                    <div>Pool list</div>
                    {/* 右侧 */}
                    <div>
                        <button className='border px-4 py-2 rounded-md' onClick={() => router.push('/position')}>My Positions</button>
                        <button className='border px-4 py-2 rounded-md ml-4 bg-blue-500 text-white' onClick={() => setShowMask(true)}>Add Pool</button>
                    </div>
                </div>
                <div className='px-4 py-2'>
                    {isConnected && isLoading && (
                        <div className="text-center py-8 text-muted-foreground">
                            加载池子数据...
                        </div>
                    )}

                    {/* ✅ 只有当 tableData 有值（非null）且数组长度>0 时才渲染表格 */}

                    <DataTable
                        columns={poolcolumns}
                        data={rows}
                        itemsPerpahe={10}
                    />
                </div>
            </div>
        </>
    )
}