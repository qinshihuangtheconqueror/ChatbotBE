import Redis from 'ioredis';
import { envConfig } from '@/common/config/env.config';
import { createLogger } from '@/common/logger/logger';

const logger = createLogger('RedisClient');

export class RedisClient {
    private readonly client: Redis;

    constructor() {
        this.client = new Redis(envConfig.REDIS_URL, {
            lazyConnect: true,
            maxRetriesPerRequest: 0,   // don't retry — fail immediately
            connectTimeout: 300,        // 300ms connect timeout
            retryStrategy: () => null,  // disable reconnect loop when Redis is down
        });
        this.client.on('error', (e) => logger.error('Redis error', e));
    }

    async get(key: string): Promise<string | null> {
        return this.client.get(key);
    }

    async set(key: string, value: string, ttlSeconds: number): Promise<void> {
        await this.client.set(key, value, 'EX', ttlSeconds);
    }

    async del(key: string): Promise<void> {
        await this.client.del(key);
    }

    /** Rate limit check — returns true if limit exceeded.
     *  Uses INCR + always-EXPIRE to prevent permanent blocks if EXPIRE fails. */
    async checkRateLimit(studentId: string, maxPerMinute = 60, prefix = 'api'): Promise<boolean> {
        const key = `rl:${prefix}:${studentId}`;

        try {
            const count = await this.client.incr(key);

            if (count === 1) {
                // Lần đầu tạo key, gán thời gian sống là 60 giây
                await this.client.expire(key, 60);
            } else {
                // 🌟 LAYER BẢO VỆ: Nếu rớt mạng ở lần 1 khiến key bị bất tử,
                // chúng ta sẽ phát hiện và sửa sai ngay ở các lần tiếp theo.
                const ttl = await this.client.ttl(key);

                // Nếu ttl === -1 nghĩa là key tồn tại vĩnh viễn không có hạn sử dụng
                if (ttl === -1) {
                    await this.client.expire(key, 60);
                }
            }

            return count > maxPerMinute;
        } catch (error) {
            // Log lỗi để theo dõi, nhưng không chặn user nếu Redis đang chập chờn
            logger.error(`[RateLimit] Redis error for ${studentId}:`, error);
            return false;
        }
    }

    async ping(): Promise<string> {
        return this.client.ping();
    }
}
