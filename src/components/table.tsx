import { useState } from 'react';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Pagination,
  PaginationContent,
  PaginationEllipsis,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from '@/components/ui/pagination';



// 模拟数据（实际项目中替换为你的 API 数据）
const mockData = [
  {
    id: '1',
    token: 'ETH (2395.123 ) / USDC (23958.97)',
    free: '1.00%',
    range: '2421.1866 - 6197.9015',
    currentprice: '2421.1866',
    liquidity: '2024'
  },
  {
    id: '2',
    token: 'ETH (2395.123 ) / USDC (23958.97)',
    free: '1.00%',
    range: '2421.1866 - 6197.9015',
    currentprice: '2421.1866',
    liquidity: '2024'
  },
  {
    id: '3',
    token: 'ETH (2395.123 ) / USDC (23958.97)',
    free: '1.00%',
    range: '2421.1866 - 6197.9015',
    currentprice: '2421.1866',
    liquidity: '2024'
  },
  {
    id: '4',
    token: 'ETH (2395.123 ) / USDC (23958.97)',
    free: '1.00%',
    range: '2421.1866 - 6197.9015',
    currentprice: '2421.1866',
    liquidity: '2024'
  },
  {
    id: '5',
    token: 'ETH (2395.123 ) / USDC (23958.97)',
    free: '1.00%',
    range: '2421.1866 - 6197.9015',
    currentprice: '2421.1866',
    liquidity: '2024'
  },
  {
    id: '6',
    token: 'ETH (2395.123 ) / USDC (23958.97)',
    free: '1.00%',
    range: '2421.1866 - 6197.9015',
    currentprice: '2421.1866',
    liquidity: '2024'
  },
  {
    id: '7',
    token: 'ETH (2395.123 ) / USDC (23958.97)',
    free: '1.00%',
    range: '2421.1866 - 6197.9015',
    currentprice: '2421.1866',
    liquidity: '2024'
  },
  {
    id: '8',
    token: 'ETH (2395.123 ) / USDC (23958.97)',
    free: '1.00%',
    range: '2421.1866 - 6197.9015',
    currentprice: '2421.1866',
    liquidity: '2024'
  },
  {
    id: '9',
    token: 'ETH (2395.123 ) / USDC (23958.97)',
    free: '1.00%',
    range: '2421.1866 - 6197.9015',
    currentprice: '2421.1866',
    liquidity: '2024'
  },
  {
    id: '10',
    token: 'ETH (2395.123 ) / USDC (23958.97)',
    free: '1.00%',
    range: '2421.1866 - 6197.9015',
    currentprice: '2421.1866',
    liquidity: '2024'
  },
  {
    id: '11',
    token: 'ETH (2395.123 ) / USDC (23958.97)',
    free: '1.00%',
    range: '2421.1866 - 6197.9015',
    currentprice: '2421.1866',
    liquidity: '2024'
  },

  // ... 更多数据
];

export interface Column {
  key: string;
  title: string;
}

const ITEMS_PER_PAGE = 5;

export default function DataTable({ data, columns, itemsPerpahe = 5 }) {


  //如果data有数据就有data的，没用就用mockData的
  const tableData = data.length > 0 ? data : mockData;
  const [currentPage, setCurrentPage] = useState(1);

  // 计算总页数
  const totalPages = Math.ceil(mockData.length / ITEMS_PER_PAGE);

  // 获取当前页的数据
  const currentData = mockData.slice(
    (currentPage - 1) * ITEMS_PER_PAGE,
    currentPage * ITEMS_PER_PAGE
  );

  return (
    <div className="w-full">
      {/* 表格 */}
      <Table>
        <TableHeader>
          <TableRow>
            {columns.map((col) => (
              <TableHead key={col.key}>{col.title}</TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {currentData.map((item) => (
            <TableRow key={item.id}>
              {columns.map((col) => (
                <TableCell
                  key={col.key}
                  className={col.key === 'token' ? 'font-medium' : ''}
                >
                  {col.key === 'actions' ? (
                    // ✅ 如果是 actions 列，渲染按钮
                    <div className="flex gap-2">
                      <button
                        className="px-3 py-1 text-sm text-blue-500"
                        onClick={() => console.log('View', item.id)}
                      >
                        View
                      </button>
                      <button
                        className="px-3 py-1 text-sm text-blue-500"
                        onClick={() => console.log('Add', item.id)}
                      >
                        Add Liquidity
                      </button>
                    </div>
                  ) : (
                    item[col.key]
                  )}
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>

      {/* 分页 */}
      <Pagination className="mt-4 justify-end">
        <PaginationContent>
          {/* 上一页 */}
          <PaginationItem>
            <PaginationPrevious
              onClick={() => setCurrentPage(Math.max(1, currentPage - 1))}
              className={currentPage === 1 ? 'pointer-events-none opacity-50' : ''}
            />
          </PaginationItem>

          {/* 页码 */}
          {[...Array(totalPages)].map((_, index) => (
            <PaginationItem key={index + 1}>
              <PaginationLink
                isActive={currentPage === index + 1}
                onClick={() => setCurrentPage(index + 1)}
              >
                {index + 1}
              </PaginationLink>
            </PaginationItem>
          ))}

          {/* 下一页 */}
          <PaginationItem>
            <PaginationNext
              onClick={() => setCurrentPage(Math.min(totalPages, currentPage + 1))}
              className={currentPage === totalPages ? 'pointer-events-none opacity-50' : ''}
            />
          </PaginationItem>
        </PaginationContent>
      </Pagination>
    </div>
  );
}
