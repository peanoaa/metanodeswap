import { useState } from 'react'

interface MaskProps {
    onClose: () => void;
}

export default function Mask({ onClose }: MaskProps) {
    const [token0Amount, setToken0Amount] = useState('')
    const [token1Amount, setToken1Amount] = useState('')
    const [feeTier, setFeeTier] = useState('1.00%')
    const [lowPrice, setLowPrice] = useState('')
    const [highPrice, setHighPrice] = useState('')
    const [priceRange, setPriceRange] = useState(3042)

    return (
        <>
            {/* 遮罩层 */}
            <div
                className='fixed inset-0 bg-black/50 z-50'
                onClick={onClose}
            />

            {/* 弹窗主体 */}
            <div
                className='fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-[51] w-[480px] bg-white rounded-md shadow-xl overflow-hidden'
                onClick={(e) => e.stopPropagation()}
            >
                {/* 标题栏 */}
                <div className='flex items-center justify-between px-5 py-4 border-b'>
                    <h3 className='text-lg font-semibold'>Add position</h3>
                    <button
                        className='w-8 h-8 flex items-center justify-center rounded-full hover:bg-gray-100 text-gray-400 hover:text-gray-600 transition-colors'
                        onClick={onClose}
                    >
                        ✕
                    </button>
                </div>

                {/* 内容区 */}
                <div className='px-5 py-4 space-y-5'>
                    {/* Deposit amounts */}
                    <div>
                        <label className='text-sm font-medium mb-2 block'>
                            <span className='text-red-500'>*</span> Deposit amounts
                        </label>

                        {/* Token 0: ETH */}
                        <div className='border rounded-xl p-3 mb-2'>
                            <div className='flex items-center justify-between'>
                                <div>
                                    <input
                                        type='text'
                                        placeholder='0'
                                        value={token0Amount}
                                        onChange={(e) => setToken0Amount(e.target.value)}
                                        className='w-full text-2xl font-medium outline-none placeholder:text-gray-300 bg-transparent'
                                    />
                                    <p className='text-xs text-gray-400 mt-1'>$0.00</p>
                                </div>
                                <div className='flex items-center gap-2'>
                                    <button className='flex items-center gap-1 px-2 py-1 rounded-full border hover:border-blue-500'>
                                        <span className='w-5 h-5 bg-blue-500 rounded-full flex items-center justify-center text-white text-xs font-bold'>Ξ</span>
                                        <span className='font-medium'>ETH</span>
                                        <span className='text-gray-400 text-xs'>▾</span>
                                    </button>
                                </div>
                            </div>
                            <div className='flex justify-end mt-1 text-xs'>
                                <span className='text-gray-500'>Balance: 23,491</span>
                                <button className='ml-2 text-blue-500 font-medium hover:text-blue-600'>Max</button>
                            </div>
                        </div>

                        {/* Token 1: XRP */}
                        <div className='border rounded-xl p-3'>
                            <div className='flex items-center justify-between'>
                                <div>
                                    <input
                                        type='text'
                                        placeholder='0'
                                        value={token1Amount}
                                        onChange={(e) => setToken1Amount(e.target.value)}
                                        className='w-full text-2xl font-medium outline-none placeholder:text-gray-300 bg-transparent'
                                    />
                                    <p className='text-xs text-gray-400 mt-1'>$0.00</p>
                                </div>
                                <div className='flex items-center gap-2'>
                                    <button className='flex items-center gap-1 px-2 py-1 rounded-full border hover:border-blue-500'>
                                        <span className='w-5 h-5 bg-black rounded-full flex items-center justify-center text-white text-xs font-bold'>✕</span>
                                        <span className='font-medium'>XRP</span>
                                        <span className='text-gray-400 text-xs'>▾</span>
                                    </button>
                                </div>
                            </div>
                            <div className='flex justify-end mt-1 text-xs text-gray-500'>
                                Balance: 0
                            </div>
                        </div>
                    </div>

                    {/* Fee tier */}
                    <div>
                        <label className='text-sm font-medium mb-2 block'>
                            <span className='text-red-500'>*</span> Fee tier
                        </label>
                        <select
                            value={feeTier}
                            onChange={(e) => setFeeTier(e.target.value)}
                            className='w-full border rounded-xl px-4 py-3 outline-none focus:ring-2 focus:ring-blue-500 appearance-none bg-white cursor-pointer'
                        >
                            <option value='0.01%'>0.01%</option>
                            <option value='0.05%'>0.05%</option>
                            <option value='0.30%'>0.30%</option>
                            <option value='1.00%'>1.00%</option>
                        </select>
                    </div>

                    {/* Set price range */}
                    <div>
                        <label className='text-sm font-medium mb-2 block'>
                            <span className='text-red-500'>*</span> Set price range
                        </label>
                        <div className='flex gap-3'>
                            <div className='flex-1'>
                                <input
                                    type='text'
                                    placeholder='Low price'
                                    value={lowPrice}
                                    onChange={(e) => setLowPrice(e.target.value)}
                                    className='w-full border rounded-xl px-4 py-3 outline-none focus:ring-2 focus:ring-blue-500'
                                />
                                <p className='text-xs text-gray-400 mt-1 px-1'>USDC per ETH</p>
                            </div>
                            <div className='flex-1'>
                                <input
                                    type='text'
                                    placeholder='High price'
                                    value={highPrice}
                                    onChange={(e) => setHighPrice(e.target.value)}
                                    className='w-full border rounded-xl px-4 py-3 outline-none focus:ring-2 focus:ring-blue-500'
                                />
                                <p className='text-xs text-gray-400 mt-1 px-1'>USDC per ETH</p>
                            </div>
                        </div>
                    </div>

                    {/* Current price */}
                    <div>
                        <label className='text-sm font-medium mb-2 block'>
                            <span className='text-red-500'>*</span> Current price
                        </label>
                        <p className='text-2xl font-semibold'>3,042.00</p>
                        <p className='text-xs text-gray-400 mb-3'>USDC per ETH</p>

                        {/* Price range slider */}
                        <div className='relative pt-2 pb-4'>
                            <input
                                type='range'
                                min='0'
                                max='8000'
                                step='0.01'
                                value={priceRange}
                                onChange={(e) => setPriceRange(Number(e.target.value))}
                                className='w-full h-1 accent-blue-500 cursor-pointer'
                                style={{
                                    background: `linear-gradient(to right, #3b82f6 0%, #3b82f6 ${(priceRange / 8000) * 100}%, #e5e7eb ${(priceRange / 8000) * 100}%, #e5e7eb 100%)`
                                }}
                            />
                            <div className='flex justify-between text-xs text-gray-400 mt-1'>
                                <span>0.00</span>
                                <span>8000.00</span>
                            </div>
                        </div>
                    </div>
                </div>

                {/* 底部按钮栏 */}
                <div className='flex justify-end gap-3 px-5 py-4 border-t bg-gray-50'>
                    <button
                        className='px-6 py-2.5 border rounded-xl hover:bg-gray-100 transition-colors'
                        onClick={onClose}
                    >
                        取消
                    </button>
                    <button
                        className='px-6 py-2.5 bg-blue-500 text-white rounded-xl hover:bg-blue-600 transition-colors font-medium'
                        onClick={onClose}
                    >
                        创建
                    </button>
                </div>
            </div>
        </>
    )
}
