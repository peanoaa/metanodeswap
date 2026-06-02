import DataTable from '../../components/table'
import { poscolumns, PositionMockData } from '../../tableinfo/tableinfo'
import Mask from '../../components/Mask'
import { useState } from 'react'
import { PositionManagerAbi } from '../../abi/PositionManager'
import {
    useAccount,
    useReadContract
} from 'wagmi'
import { transformPositionData, PositionRawData, PositionDisplayData } from '../../utils/coomputer'


export default function Pool() {
    
    //合约地址
    const PositionManager = '0xbe766Bf20eFfe431829C5d5a2744865974A0B610';
    //控制遮罩显示
    const [showMask, setShowMask] = useState(false);
    //获取钱包链接状态
    const { isConnected } = useAccount()
    //读取合约
    const { data: positions, error, isLoading, refetch } = useReadContract({
        abi: PositionManagerAbi,
        address: PositionManager,
        functionName: 'getAllPositions',
        query: {
            enabled: isConnected,
        }
    })
    //查看返回值
    console.log('posotiondata',positions)
    let PositionTableDate: PositionDisplayData[] = [];
    if (positions && Array.isArray(positions)) {
            try {
                PositionTableDate = (positions as PositionRawData[]).map(transformPositionData)
            } catch (e) {
                console.error('转换失败:', e);
            }
        }
    
    return (
        <>
        {showMask && <Mask onClose={() => setShowMask(false)}/>}
            <div className='border max-w-6xl mx-auto px-6 py-8'>

                <div>
                    <h2 className='text-2xl font-bold'>Positions</h2>
                </div>
                <div className='flex justify-between items-center px-4 py-2'>
                    {/* 左侧 */}
                    <div>My Positions</div>
                    {/* 右侧 */}
                    <div>
                        <button className='border px-4 py-2 rounded-md ml-4 bg-blue-500 text-white' onClick={() => setShowMask(true)}>Add</button>
                    </div>
                </div>
                <div className='px-4 py-2'>
                    <DataTable
                        columns={poscolumns}
                        data={PositionTableDate}
                        itemsPerpahe={5}
                    />
                </div>
            </div>
        </>
    )
}