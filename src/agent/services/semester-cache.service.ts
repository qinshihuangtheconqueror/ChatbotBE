import { Injectable, OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { RedisClient } from '@/agent/tools/clients/redis.client';
import { HustApiClient } from '@/agent/tools/clients/hust-api.client';
import { createLogger } from '@/common/logger/logger';

const logger = createLogger('SemesterCacheService');

// Định nghĩa interface để dễ quản lý dữ liệu
export interface SemesterContext {
    semester: string;
    startDate: number;
    startDateFormatted: string; 
    endDate: number;
    endDateFormatted: string;  
    startWeek: number;
    currentWeek: number;
    absoluteCurrentWeek: number;
    lastUpdatedAt: string;
}

@Injectable()
export class SemesterCacheService implements OnModuleInit {
    private readonly REDIS_KEY = 'hustva:global:semester:current';

    async onModuleInit() {
        const cachedStr = await this.redis.get(this.REDIS_KEY);

        if (!cachedStr) {
            logger.info('Server khởi động: Đang pre-warm Semester Cache...');
            // Không block tiến trình khởi động server
            this.syncCurrentSemesterToRedis().catch(e => 
                logger.error('Pre-warm Semester thất bại', { error: String(e) })
            );
        } else {
            logger.info('Semester Cache đã có sẵn phiên bản mới nhất, bỏ qua đồng bộ.');
        }
    }

    constructor(
        private readonly redis: RedisClient,
        private readonly hustApi: HustApiClient
    ) {}

    private formatDateVN(timestamp: number): string {
        return new Date(timestamp).toLocaleDateString('vi-VN', {
            day: '2-digit',
            month: '2-digit',
            year: 'numeric',
            timeZone: 'Asia/Ho_Chi_Minh'
        }); 
    }

    /**
     * Lấy dữ liệu từ API, tính toán và lưu vào Redis
     * @param isRetry Cờ đánh dấu xem đây có phải là lần gọi lại do rã đông không
     */
    async syncCurrentSemesterToRedis(isRetry = false): Promise<SemesterContext | null> {
        try {
            logger.info(`Bắt đầu đồng bộ thông tin Học kỳ... (Retry: ${isRetry})`);
            
            const response = await this.hustApi.getSemesters();
            const semesters: any[] = Array.isArray(response) ? response : (response as any)?.data || [];

            if (semesters.length === 0) {
                logger.error('API trả về danh sách kỳ học rỗng!');
                return null;
            }

            const validSemesters = semesters.filter(s => s.absoluteCurrentWeek !== -1);
            validSemesters.sort((a, b) => b.semester.localeCompare(a.semester));
            
            const currentSem = validSemesters[0];
            if (!currentSem) return null;

            const nowMs = Date.now();
            const startMs = currentSem.startDate;
            
            const diffInDays = Math.floor((nowMs - startMs) / 86400000);
            
            let calculatedCurrentWeek = Math.floor(diffInDays / 7) + 1;
            if (calculatedCurrentWeek < 1) calculatedCurrentWeek = 1;

            const calculatedAbsoluteWeek = currentSem.startWeek + calculatedCurrentWeek - 1;

            const cacheData: SemesterContext = {
                semester: currentSem.semester,
                startDate: currentSem.startDate,
                startDateFormatted: this.formatDateVN(currentSem.startDate), 
                endDate: currentSem.endDate,
                endDateFormatted: this.formatDateVN(currentSem.endDate),     
                startWeek: currentSem.startWeek,
                currentWeek: calculatedCurrentWeek,
                absoluteCurrentWeek: calculatedAbsoluteWeek,
                lastUpdatedAt: new Date().toISOString()
            };

            const TTL_30_DAYS = 30 * 24 * 60 * 60;
            // Ghi đè trực tiếp lên Cache cũ
            await this.redis.set(this.REDIS_KEY, JSON.stringify(cacheData), TTL_30_DAYS);
            
            logger.info(`Đã cache thành công kỳ ${cacheData.semester} - Tuần ${cacheData.currentWeek}`, { ...cacheData });
            
            return cacheData;

        } catch (error: any) {
            // ANTI-COLD-START LOGIC
            // Nếu bị lỗi (đặc biệt là timeout) và chưa từng retry
            if (!isRetry) {
                logger.warn('API có dấu hiệu rã đông (Timeout). Đang nghỉ 3s để gọi lại lần 2...');
                // Nghỉ 3 giây để server trường tỉnh hẳn
                await new Promise(resolve => setTimeout(resolve, 3000));
                // Đệ quy gọi lại chính nó với cờ isRetry = true
                return this.syncCurrentSemesterToRedis(true);
            }

            // Nếu đã retry rồi mà vẫn xịt thì chịu
            logger.error('Lỗi khi đồng bộ thông tin Học kỳ', { error: String(error) });
            return null;
        }
    }

    /**
     * CRON 1: Chạy vào lúc 00:01 sáng Thứ 2 hàng tuần.
     * Mục đích: Tự động cộng currentWeek lên 1 và ghi đè vào Redis.
     */
    @Cron('1 0 * * 1', { name: 'update_current_week', timeZone: 'Asia/Ho_Chi_Minh' })
    async handleWeeklyUpdate() {
        logger.info('Cron Weekly: Đang cập nhật Tuần học mới...');
        await this.syncCurrentSemesterToRedis();
    }

    /**
     * CRON 2: Chạy vào lúc 02:00 sáng mỗi ngày.
     * Mục đích: Kiểm tra xem đã hết kỳ chưa. Nếu ngày hiện tại > endDate, 
     * báo hiệu cần check API để lấy kỳ mới.
     */
    @Cron(CronExpression.EVERY_DAY_AT_2AM, { name: 'check_semester_transition', timeZone: 'Asia/Ho_Chi_Minh' })
    async handleDailyTransitionCheck() {
        const cachedStr = await this.redis.get(this.REDIS_KEY);
        if (!cachedStr) {
            await this.syncCurrentSemesterToRedis();
            return;
        }

        const cached: SemesterContext = JSON.parse(cachedStr);
        const nowMs = Date.now();

        // Nếu ngày hiện tại đã vượt qua endDate của kỳ trước, tiến hành sync lại API để hứng kỳ mới
        if (nowMs > cached.endDate) {
            logger.info('Cron Daily: Đã kết thúc kỳ học cũ, tiến hành quét kỳ học mới...');
            await this.syncCurrentSemesterToRedis();
        }
    }
}