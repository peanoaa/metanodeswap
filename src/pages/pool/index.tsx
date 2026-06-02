import DataTable from '../../components/table'
import { useRouter } from 'next/router'
import { poolcolumns, PoolMockData } from '../../tableinfo/tableinfo'
import {
    useAccount,
    useReadContract
} from 'wagmi'
import { PoolManagerAbi } from '../../abi/PoolManager'
import { transformPoolData, PoolRawData } from '../../utils/coomputer'
import { useState } from 'react'

import Mask from '../../components/Mask'




export default function Pool() {
    const router = useRouter();
    // const PoolTableDate: any = [];
    const PoolManagerAddress = '0xddC12b3F9F7C91C79DA7433D8d212FB78d609f7B'

    //控制遮罩显示
    const [showMask, setShowMask] = useState(false);

    //获取钱包链接状态
    const { isConnected } = useAccount()
    //读取合约
    const { data: pools, error, isLoading, refetch } = useReadContract({
        abi: PoolManagerAbi,
        address: PoolManagerAddress,
        functionName: 'getAllPools',
        query: {
            enabled: isConnected,
        }
    })
    // //查看返回值
    console.log('data:', pools);   // ← 检查返回值

    let PoolTableDate: any[] = [];
    if (pools && Array.isArray(pools)) {
        try {
            PoolTableDate = (pools as PoolRawData[] || []).map(transformPoolData)
        } catch (e) {
            console.error('转换失败:', e);
        }
    }

    // const PoolTableDate = (pools as PoolRawData[] || []).map(transformPoolData)
    // console.log('PoolTableDate:+++++++++==', PoolTableDate);


    return (
        <>
        {/* 遮罩 */}
        {showMask && <Mask onClose={() => setShowMask(false)}/>}
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
                    {PoolTableDate && PoolTableDate.length > 0 && (
                        <DataTable
                            columns={poolcolumns}
                            data={PoolTableDate}
                            itemsPerpahe={10}
                        />
                    )}
                    {/* <DataTable
                        columns={poolcolumns}
                        data={PoolTableDate}
                        itemsPerpahe={10}
                    /> */}
                </div>
            </div>
        </>
    )
}