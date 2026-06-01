import React from 'react';
import Link from 'next/link';
import  { useRouter } from 'next/router';
import { ConnectButton } from '@rainbow-me/rainbowkit';

export default function Header() {
    const router = useRouter();

    //判断当前路由是否是swap
    const isSwap = router.pathname === '/swap';
    const isPool = router.pathname === '/';
    return (
        <div className='flex justify-between items-center p-4'>
            <div>
                <h2>MetaNodeSwap</h2>
            </div>
            <div className='flex gap-4'>
                <Link href="/swap" className={`transition-colors ${
                    isSwap ? 'text-primaru font-semibold' 
                            : 'text-muted-foreground hover:text-primary'
                }`}>Swap</Link>
                <Link href="/" className={`transition-colors ${
                    isPool ? 'text-primaru font-semibold' 
                            : 'text-muted-foreground hover:text-primary'
                }`}>Pool</Link>
            </div>
            <div>
                <ConnectButton />
            </div>


        </div>
    )
}