import DataTable from '../../components/table'
import {useRouter} from 'next/router'
import {poolcolumns,PoolMockData} from '../../tableinfo/tableinfo'

//定义表头信息



export default function Pool(){
    const router = useRouter();
    const PoolTableDate:any = [];
    return (
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
                    <button className='border px-4 py-2 rounded-md ml-4 bg-blue-500 text-white'>Add Pool</button>
                </div>
            </div>
            <div className='px-4 py-2'>
                <DataTable 
                columns = {poolcolumns}
                data={PoolTableDate ? PoolTableDate : PoolMockData}
                itemsPerpahe={5}
                />
            </div>
        </div>
    )
}