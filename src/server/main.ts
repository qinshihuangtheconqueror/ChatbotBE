import './instrumentation'; // ← MUST be first: initializes OTel for @langfuse/langchain v4
import 'dotenv/config';
import { webcrypto } from 'node:crypto';
if (!globalThis.crypto) (globalThis as any).crypto = webcrypto;

process.on('unhandledRejection', (reason: any, promise: Promise<any>) => {
    console.error('🚨 [CRITICAL SHIELD] Đã chặn một Unhandled Rejection làm sập Server:', reason?.message || reason);
});

process.on('uncaughtException', (err: Error) => {
    console.error('🚨 [CRITICAL SHIELD] Đã chặn một Uncaught Exception:', err.message);
});

import { NestFactory } from '@nestjs/core';
import * as express from 'express';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from '@/server/app.module';
import { envConfig } from '@/common/config/env.config';

import { warmupSignalRouter } from '@/agent/graph/graph/node.signal-router';

async function bootstrap() {
    const app = await NestFactory.create(AppModule);
    app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));

    // Body limit: mặc định của Express là 100KB — một ảnh base64 sẽ bị 413 ngay.
    // Trần này khớp với MAX_TOTAL_IMAGE_BYTES (12MB) trong multimodal.ts, cộng
    // biên cho phần phình ~33% của base64 và phần text.
    app.use(express.json({ limit: '20mb' }));
    app.use(express.urlencoded({ limit: '20mb', extended: true }));
    
    // CORS: restrict origins from env (comma-separated list)
    // Chuẩn hoá: bỏ khoảng trắng, bỏ dấu '/' ở cuối, hạ thường.
    // Lý do: browser gửi Origin KHÔNG BAO GIỜ có '/' ở cuối, nên nếu env ghi
    // "https://hustva.vbee.ai/" thì so khớp chuỗi sẽ trượt và chặn nhầm domain thật.
    const normalizeOrigin = (s: string) => s.trim().replace(/\/+$/, '').toLowerCase();
    const allowedOrigins = envConfig.ALLOWED_ORIGINS.split(',').map(normalizeOrigin).filter(Boolean);
    app.enableCors({
        origin: (origin, cb) => {
            // Allow requests with no origin (server-to-server, curl, mobile apps)
            if (!origin || allowedOrigins.includes(normalizeOrigin(origin))) return cb(null, true);
            cb(new Error(`CORS blocked: ${origin}`));
        },
        credentials: true,
    });

    // 🔥 GỌI WARMUP TRƯỚC KHI SERVER MỞ CỔNG LẮNG NGHE (Chặn tiến trình chờ nạp xong RAM)
    console.log('⏳ Đang nạp bộ nhớ kNN Signal Router vào RAM...');
    try {
        await warmupSignalRouter();
        console.log('✅ Nạp kNN Signal Router thành công!');
    } catch (error) {
        console.error('❌ Lỗi khi nạp kNN Signal Router:', error);
    }

    const port = envConfig.PORT;
    await app.listen(port);
    console.log(`🚀 HustVA V3 running on http://localhost:${port}`);
}

void bootstrap();
