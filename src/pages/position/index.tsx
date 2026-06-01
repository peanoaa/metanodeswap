import DataTable from '../../components/table'
import {poscolumns,PositionMockData} from '../../tableinfo/tableinfo'


export default function Pool(){
    const PoolTableDate:any = [];
    return (
        <div className='border max-w-6xl mx-auto px-6 py-8'>
            <div>
                <h2 className='text-2xl font-bold'>Positions</h2>
            </div>
            <div className='flex justify-between items-center px-4 py-2'>
                  {/* 左侧 */}
                <div>My Positions</div>
                {/* 右侧 */}
                <div>
                    <button className='border px-4 py-2 rounded-md ml-4 bg-blue-500 text-white'>Add</button>
                </div>
            </div>
            <div className='px-4 py-2'>
                <DataTable 
                columns = {poscolumns}
                data={PoolTableDate ? PoolTableDate : PositionMockData}
                itemsPerpahe={5}
                />
            </div>
        </div>
    )
}