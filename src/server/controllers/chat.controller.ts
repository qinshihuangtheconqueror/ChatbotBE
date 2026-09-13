import { Controller, Post, Body, Res, Req, Get, HttpCode, HttpException, HttpStatus } from '@nestjs/common';
import type { Request, Response } from 'express';
import { ChatService } from '@/server/services/chat.service';
import { HistoryService } from '@/server/services/history.service';
import { ChatRequestDto } from '@/server/dtos/chat.request.dto';
import { getLangfuseClient } from '@/agent/tracing/langfuse-direct.tracer';
import { createLogger } from '@/common/logger/logger';
import { sanitizeImages } from '@/agent/multimodal';

const logger = createLogger('ChatController');

/**
 * Resolve the verified student ID:
 *   - Auth middleware stamps req.studentId from JWT or body.student_id
 *   - We ALWAYS use req.studentId, NOT dto.student_id
 *   - If someone sends a different student_id in the body → reject (403)
 *   Security: prevents querying another student's grades/data.
 */
function resolveStudentId(req: Request, dto: ChatRequestDto): string {
    const verified: string = (req as any).studentId;
    if (!verified) {
        throw new HttpException('Unauthorized: no verified student identity', HttpStatus.UNAUTHORIZED);
    }
    // If body also contains a student_id that differs → security violation
    if (dto.student_id && dto.student_id !== verified) {
        logger.warn('SECURITY: body student_id differs from auth-verified — rejecting', {
            body: dto.student_id,
            verified,
        });
        throw new HttpException(
            'Forbidden: you can only query your own data',
            HttpStatus.FORBIDDEN,
        );
    }
    return verified;
}

@Controller('v1/chat')
export class ChatController {
    constructor(
        private readonly chatService: ChatService,
        private readonly historyService: HistoryService,
    ) { }

    /** POST /v1/chat/respond — sync response */
    @Post('respond')
    @HttpCode(200)
    async respond(@Body() body: ChatRequestDto, @Req() req: Request) {
        const studentId = resolveStudentId(req, body);

        await this.chatService.enforceRateLimit(studentId);

        logger.info('respond', { thread: body.thread_id, student: studentId });
        const images = sanitizeImages(body.images).images;
        return this.chatService.handleRespond({ ...body, student_id: studentId, images });
    }

    /** POST /v1/chat/stream — SSE streaming */
    @Post('stream')
    @HttpCode(200)
    async stream(@Body() body: ChatRequestDto, @Req() req: Request, @Res() res: Response): Promise<void> {
        const studentId = resolveStudentId(req, body);

        await this.chatService.enforceRateLimit(studentId);

        logger.info('stream', { thread: body.thread_id, student: studentId });
        const images = sanitizeImages(body.images).images;
        return this.chatService.handleStream({ ...body, student_id: studentId, images }, res);
    }

    /** POST /v1/chat/feedback — Lấy đánh giá user */
    @Post('feedback')
    @HttpCode(200)
    async applyFeedback(@Body() body: any, @Req() req: Request) {
        resolveStudentId(req, { student_id: body.studentId } as any);
        
        logger.info('Feedback API triggered', { threadId: body.threadId, type: body.type });
        
        // 1. Log to Langfuse (Giữ nguyên cho cả 2 luồng)
        try {
            const client = getLangfuseClient();
            if (client) {
                client.score({
                    traceId: body.threadId,
                    name: body.type === 'comparison' ? 'dual_comparison' : 'user_feedback',
                    value: body.like ? 1 : 0, 
                    comment: body.comment 
                });
            }
        } catch (e) {
            logger.warn('Langfuse score failed', { error: (e as Error).message });
        }

        // 2. RẼ NHÁNH XỬ LÝ TRÊN MONGODB
        if (body.type === 'comparison') {
            // Luồng A/B Testing: Lưu feedback đầy đủ + Hợp nhất mảng turns
            await this.historyService.processComparisonSelection(
                body.threadId,
                body.messageId,     // ID gốc (ví dụ: abc-msg-1)
                body.userQuestion,   // Câu hỏi user
                body.botAnswer,      // Câu ĐƯỢC CHỌN (Chosen)
                body.rejectedAnswer, // Câu BỊ LOẠI (Rejected)
                body.comment         // [COMPARE] Chosen: A/B
            );
        } else {
            // Luồng Like/Dislike thông thường của câu Single
            await this.historyService.addFeedback(
                body.threadId, 
                body.messageId, 
                body.like, 
                body.comment,
                body.userQuestion, 
                body.botAnswer   
            );
        }
        
        return { success: true };
    }
}

@Controller('health')
export class HealthController {
    @Get()
    health() {
        return { status: 'ok', ts: new Date().toISOString(), version: '3.0.0' };
    }
}
