import {
    Injectable,
    HttpException,
    HttpStatus,
} from '@nestjs/common';
import type { Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { MultiAgentProvider } from './multi-agent.provider';
import { AgentProvider } from './agent.provider';
import { ChatRequestDto } from '@/server/dtos/chat.request.dto';
import { createLogger } from '@/common/logger/logger';
import { RedisClient } from '@/agent/tools/clients/redis.client';
import { envConfig } from '@/common/config/env.config';
import { HistoryService } from '@/server/services/history.service';

const logger = createLogger('ChatService');

type AgentMode = 'single-agent' | 'dual';

@Injectable()
export class ChatService {
    private readonly singleRatio = Number(envConfig.SINGLE_AGENT_RATIO) || 0.0;
    private readonly redisClient = new RedisClient();

    constructor(
        private readonly multiAgentProvider: MultiAgentProvider,
        private readonly singleAgentProvider: AgentProvider,
        private readonly historyService: HistoryService,
    ) { }

    async enforceRateLimit(studentId: string): Promise<void> {
        const isExceeded = await this.redisClient.checkRateLimit(studentId, 5, 'chat');
        if (isExceeded) {
            logger.warn('Chat rate limit exceeded', { student: studentId });
            throw new HttpException('RATE_LIMIT_EXCEEDED', HttpStatus.TOO_MANY_REQUESTS);
        }
    }

    private selectMode(): AgentMode {
        return Math.random() < this.singleRatio ? 'single-agent' : 'dual';
    }

    // 🔥 FIX 1: Ép dùng chung 1 Request ID cho cả 2 luồng
    private buildCtx(dto: ChatRequestDto, mode: string, sharedRequestId: string, isDual: boolean) {
        return {
            user_key: dto.student_id || 'anonymous',
            thread_id: dto.thread_id,
            request_id: sharedRequestId,
            agent_mode: mode,
            is_dual: isDual,
        };
    }

    async handleRespond(dto: ChatRequestDto) {
        const mode = this.selectMode();
        const sharedRequestId = uuidv4(); // Tạo ID 1 lần
        const isDual = mode === 'dual';

        logger.info('Routing request', { mode, user: dto.student_id, thread_id: dto.thread_id });

        if (mode === 'single-agent') {
            const result = await this.singleAgentProvider.getFacade().invoke(
                { kind: 'message', message: { text: dto.message }, images: dto.images, options: dto.options },
                this.buildCtx(dto, mode, sharedRequestId, isDual),
            );
            return { ...result, metadata: { agent_mode: 'single-agent' } };
        }

        const [singleResult, multiResult] = await Promise.all([
            this.singleAgentProvider.getFacade().invoke(
                { kind: 'message', message: { text: dto.message }, images: dto.images, options: dto.options },
                this.buildCtx(dto, 'single-agent', sharedRequestId, isDual),
            ),
            this.multiAgentProvider.getFacade().invoke(
                { kind: 'message', message: { text: dto.message }, images: dto.images, options: dto.options },
                this.buildCtx(dto, 'multi-agent', sharedRequestId, isDual),
            ),
        ]);

        return {
            type: 'dual-response',
            responses: [
                { id: 'single', mode: 'single-agent', result: singleResult },
                { id: 'multi', mode: 'multi-agent', result: multiResult },
            ],
            metadata: { agent_mode: 'dual' },
        };
    }

    async handleStream(dto: ChatRequestDto, res: Response): Promise<void> {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.flushHeaders();

        const mode = this.selectMode();
        const sharedRequestId = uuidv4(); // 🔥 FIX 1 (tt): Tạo ID chung cho Stream
        const isDual = mode === 'dual';

        logger.info('Streaming request routed', { mode, user: dto.student_id, thread_id: dto.thread_id });

        try {
            res.write(`data: ${JSON.stringify({ type: 'agent.selected', mode })}\n\n`);

            if (mode === 'single-agent') {
                const stream = this.singleAgentProvider.getFacade().stream(
                    { kind: 'message', message: { text: dto.message }, images: dto.images, options: dto.options },
                    this.buildCtx(dto, 'single-agent', sharedRequestId, isDual),
                );
                for await (const event of stream) {
                    res.write(`data: ${JSON.stringify(event)}\n\n`);
                }
                return;
            }

            const singleStream = this.singleAgentProvider.getFacade().stream(
                { kind: 'message', message: { text: dto.message }, images: dto.images, options: dto.options },
                this.buildCtx(dto, 'single-agent', sharedRequestId, isDual),
            );

            const multiStream = this.multiAgentProvider.getFacade().stream(
                { kind: 'message', message: { text: dto.message }, images: dto.images, options: dto.options },
                this.buildCtx(dto, 'multi-agent', sharedRequestId, isDual),
            );

            let accA = '';
            let accB = '';
            let threadTitleToSave: string | undefined;

            const singleTask = (async () => {
                for await (const event of singleStream) {
                    if (res.writableEnded) break;
                    if (event.type === 'message.delta') accA += event.delta;
                    if (event.type === 'run.completed' && event.title) {
                        threadTitleToSave = event.title;
                    }
                    res.write(`data: ${JSON.stringify({ lane: 'single', ...event })}\n\n`);
                }
            })();

            const multiTask = (async () => {
                for await (const event of multiStream) {
                    if (res.writableEnded) break;
                    
                    // Cấm cửa event vòng đời của nhánh Multi để Frontend không đẻ session
                    if (event.type === 'run.started' || event.type === 'run.completed') continue; 
                    
                    if (event.type === 'message.delta') accB += event.delta;
                    res.write(`data: ${JSON.stringify({ lane: 'multi', ...event })}\n\n`);
                }
            })();

            await Promise.allSettled([singleTask, multiTask]);

            // 🔥 CHỐT HẠ: LƯU DATABASE TẠI ORCHESTRATOR
            const cleanA = accA.replace(/\[STATUS:(.*?)\]/g, '').replace(/\[COMPOSE_DONE\]/g, '').trim();
            const cleanB = accB.replace(/\[STATUS:(.*?)\]/g, '').replace(/\[COMPOSE_DONE\]/g, '').trim();

            await this.historyService.saveDualContext(
                dto.thread_id,
                dto.student_id || 'anonymous',
                dto.message,
                cleanA,
                cleanB,
                threadTitleToSave
            );

        } catch (e: any) {
            logger.error('Stream error', e);
            res.write(`data: ${JSON.stringify({ type: 'run.failed', error: { code: 'INTERNAL', message: 'Stream error' } })}\n\n`);
        } finally {
            res.end();
        }
    }
}