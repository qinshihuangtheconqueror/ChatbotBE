import { Controller, Get, Delete, Param, Req, HttpException, HttpStatus } from '@nestjs/common';
import type { Request } from 'express';
import { HistoryService } from '@/server/services/history.service';
import { createLogger } from '@/common/logger/logger';

const logger = createLogger('HistoryController');

/**
 * HistoryController — REST API cho lịch sử hội thoại.
 *
 * Tất cả endpoints yêu cầu JWT Auth (qua AuthMiddleware).
 * Ownership được enforce: mỗi sinh viên chỉ xem/xóa thread của mình.
 *
 * Endpoints:
 *   GET    /v1/history/threads           → Danh sách threads (cho sidebar)
 *   GET    /v1/history/threads/:threadId → Chi tiết 1 thread
 *   DELETE /v1/history/threads/:threadId → Xóa 1 thread
 */
@Controller('v1/history')
export class HistoryController {
    constructor(private readonly historyService: HistoryService) {}

    /** Lấy studentId đã được verify từ AuthMiddleware */
    private getStudentId(req: Request): string {
        const studentId = (req as any).studentId;
        if (!studentId) {
            throw new HttpException('Unauthorized', HttpStatus.UNAUTHORIZED);
        }
        return studentId;
    }

    /**
     * GET /v1/history/threads
     * Trả về danh sách threads tóm tắt, sorted newest-first, max 60.
     */
    @Get('threads')
    async listThreads(@Req() req: Request) {
        const studentId = this.getStudentId(req);

        const threads = await this.historyService.getThreadsList(studentId);
        return { threads };
    }

    /**
     * GET /v1/history/threads/:threadId
     * Trả về toàn bộ messages trong 1 thread.
     */
    @Get('threads/:threadId')
    async getThread(@Param('threadId') threadId: string, @Req() req: Request) {
        const studentId = this.getStudentId(req);
        logger.info('getThread', { studentId, threadId });

        const thread = await this.historyService.getThreadDetail(threadId, studentId);
        if (!thread) {
            throw new HttpException('Thread not found', HttpStatus.NOT_FOUND);
        }
        return thread;
    }

    /**
     * DELETE /v1/history/threads/:threadId
     * Xóa 1 thread (chỉ owner mới xóa được).
     */
    @Delete('threads/:threadId')
    async deleteThread(@Param('threadId') threadId: string, @Req() req: Request) {
        const studentId = this.getStudentId(req);
        logger.info('deleteThread', { studentId, threadId });

        const deleted = await this.historyService.deleteThread(threadId, studentId);
        if (!deleted) {
            throw new HttpException('Thread not found or not owned by you', HttpStatus.NOT_FOUND);
        }
        return { success: true };
    }
}
