import { Injectable, NestMiddleware, HttpException, HttpStatus } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import * as jwt from 'jsonwebtoken';
import { envConfig } from '@/common/config/env.config';
import { createLogger } from '@/common/logger/logger';
import { RedisClient } from '@/agent/tools/clients/redis.client';

const logger = createLogger('AuthMiddleware');

// ─── JWT Auth Middleware ─────────────────────────────────────────────────────

@Injectable()
export class AuthMiddleware implements NestMiddleware {
    use(req: Request, _res: Response, next: NextFunction): void {

        const authHeader = req.headers.authorization;

        // ── JWT path (production): Bearer token ──────────────────────────────
        if (authHeader?.startsWith('Bearer ')) {
            const token = authHeader.slice(7);
            try {
                const payload = jwt.verify(token, envConfig.JWT_SECRET) as any;
                (req as any).studentId = payload.student_id || payload.sub;
                return next();
            } catch {
                throw new HttpException('Unauthorized: invalid or expired token', HttpStatus.UNAUTHORIZED);
            }
        }

        // ── No valid auth → reject ────────────────────────────────────────────
        throw new HttpException('Unauthorized: missing Bearer token', HttpStatus.UNAUTHORIZED);
    }
}


// ─── Rate Limit Middleware ────────────────────────────────────────────────────

@Injectable()
export class RateLimitMiddleware implements NestMiddleware {
    private redis: RedisClient;

    constructor() {
        this.redis = new RedisClient();
    }

    async use(req: Request, _res: Response, next: NextFunction): Promise<void> {
        const studentId = (req as any).studentId || req.body?.student_id || 'anonymous';
        try {
            const exceeded = await this.redis.checkRateLimit(studentId, 60, 'api'); 
            if (exceeded) {
                logger.warn('Rate limit exceeded', { studentId });
                throw new HttpException(
                    { error: 'rate_limit_exceeded', message: 'Too many requests. Max 60/minute.' },
                    HttpStatus.TOO_MANY_REQUESTS,
                );
            }
        } catch (e: any) {
            if (e instanceof HttpException) throw e;
            // Redis down → allow request (fail open)
            logger.warn('Redis unavailable, skipping rate limit', { error: e.message });
        }
        next();
    }
}
