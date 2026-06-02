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

export interface Column {
  key: string;
  title: string;
}

const ITEMS_PER_PAGE = 5;

export default function DataTable({ data, columns, itemsPerpahe = 5 }) {


  //如果data有数据就有data的，没用就用mockData的
  const tableData = data
  const [currentPage, setCurrentPage] = useState(1);

  // 计算总页数
  const totalPages = Math.ceil(tableData.length / itemsPerpahe);

  // 获取当前页的数据
  const currentData = tableData.slice(
    (currentPage - 1) * itemsPerpahe,
    currentPage * itemsPerpahe
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

          {/* ✅ 智能分页 - 页码过多时用 ... 省略 */}
          {(() => {
            const pages: (number | 'ellipsis')[] = [];

            // 始终显示第一页
            pages.push(1);

            if (totalPages <= 7) {
              // 总页数 ≤ 7：全部显示
              for (let i = 2; i < totalPages; i++) {
                pages.push(i);
              }
            } else if (currentPage <= 4) {
              // 当前页靠左：1 2 3 4 5 ... last
              for (let i = 2; i <= 5; i++) {
                pages.push(i);
              }
              pages.push('ellipsis');
            } else if (currentPage >= totalPages - 3) {
              // 当前页靠右：1 ... last-4 last-3 last-2 last-1 last
              pages.push('ellipsis');
              for (let i = totalPages - 4; i < totalPages; i++) {
                pages.push(i);
              }
            } else {
              // 当前页在中间：1 ... current-1 current current+1 ... last
              pages.push('ellipsis');
              pages.push(currentPage - 1);
              pages.push(currentPage);
              pages.push(currentPage + 1);
              pages.push('ellipsis');
            }

            // 始终显示最后一页（如果不是第1页的话）
            if (totalPages > 1) {
              pages.push(totalPages);
            }

            return pages.map((page, index) =>
              page === 'ellipsis' ? (
                <PaginationItem key={`ellipsis-${index}`}>
                  <PaginationEllipsis />
                </PaginationItem>
              ) : (
                <PaginationItem key={page}>
                  <PaginationLink
                    isActive={currentPage === page}
                    onClick={() => setCurrentPage(page)}
                  >
                    {page}
                  </PaginationLink>
                </PaginationItem>
              )
            );
          })()}


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
