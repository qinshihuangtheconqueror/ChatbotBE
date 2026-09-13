import { Injectable } from '@nestjs/common';
import { RedisClient } from '@/agent/tools/clients/redis.client';
import { HustApiClient } from '@/agent/tools/clients/hust-api.client';
import { createLogger } from '@/common/logger/logger';

const logger = createLogger('TopicCacheService');

// Thời gian sống của Cache: 7 ngày (Thích hợp cho mùa đăng ký đồ án)
const TTL_7_DAYS = 7 * 24 * 60 * 60;

@Injectable()
export class TopicCacheService {
    constructor(
        private readonly redis: RedisClient,
        private readonly hustApi: HustApiClient
    ) {}

    /**
     * Hàm tiện ích: Dọn dẹp HTML bẩn trong mô tả đề tài
     */
    private stripHtmlToText(html: string): string {
        if (!html) return '';
        let text = html.replace(/<[^>]*>?/gm, ' ');
        text = text.replace(/&nbsp;/g, ' ')
                   .replace(/&amp;/g, '&')
                   .replace(/&lt;/g, '<')
                   .replace(/&gt;/g, '>')
                   .replace(/&quot;/g, '"')
                   .replace(/&#39;/g, "'");
        return text.replace(/\s+/g, ' ').trim();
    }

    /**
     * LẤY DANH SÁCH ĐỀ TÀI GIẢNG VIÊN (CÓ LAZY CACHE)
     */
    async getTeacherTopicsWithCache(teacherId: string): Promise<any[]> {
        const cacheKey = `hustva:teacher:${teacherId}:topics`;

        try {
            // 1. Kiểm tra Cache
            const cachedData = await this.redis.get(cacheKey);
            if (cachedData) {
                logger.info(`[Hit Cache] Đã lấy đề tài của GV ${teacherId} từ Redis.`);
                return JSON.parse(cachedData);
            }

            // 2. Miss Cache -> Gọi API eHUST
            logger.info(`[Miss Cache] Đang fetch đề tài của GV ${teacherId} từ API...`);
            const response: any = await this.hustApi.getTeacherResearchTopics(teacherId);
            
            const rawTopics = Array.isArray(response) ? response : response?.data || [];

            // 3. Lọc và chuẩn hóa các trường dữ liệu theo đúng yêu cầu
            const cleanTopics = rawTopics.map((t: any) => ({
                id: t.id,
                title: t.title,
                description: t.description,
                student_num: t.studentNum,
                type_names: t.typeNames
            }));

            // 4. Lưu vào Redis
            await this.redis.set(cacheKey, JSON.stringify(cleanTopics), TTL_7_DAYS);
            
            return cleanTopics;

        } catch (error) {
            logger.error(`Lỗi khi lấy đề tài của GV ${teacherId}`, { error: String(error) });
            return []; // Trả về mảng rỗng để không làm gãy luồng LLM
        }
    }

    /**
     * LẤY DANH SÁCH ĐỀ TÀI CÔNG TY (CÓ LAZY CACHE)
     */
    async getCompanyTopicsWithCache(companyId: string): Promise<any[]> {
        const cacheKey = `hustva:company:${companyId}:topics`;

        try {
            // 1. Kiểm tra Cache
            const cachedData = await this.redis.get(cacheKey);
            if (cachedData) {
                logger.info(`[Hit Cache] Đã lấy đề tài của Công ty ${companyId} từ Redis.`);
                return JSON.parse(cachedData);
            }

            // 2. Miss Cache -> Gọi API eHUST
            logger.info(`[Miss Cache] Đang fetch đề tài của Công ty ${companyId} từ API...`);
            const response: any = await this.hustApi.getCompanyTopics(companyId);
            
            const rawTopics = Array.isArray(response) ? response : response?.data || [];

            // 3. Lọc và chuẩn hóa các trường dữ liệu theo đúng yêu cầu
            const cleanTopics = rawTopics.map((c: any) => ({
                id: c.id,
                root_id: c.rootId,
                unit_names: c.unitNames,
                salary_offer: c.salaryOffer,
                title: c.title,
                description: this.stripHtmlToText(c.description),
                student_num: c.studentNum,
                type_names: c.typeNames
            }));

            // 4. Lưu vào Redis
            await this.redis.set(cacheKey, JSON.stringify(cleanTopics), TTL_7_DAYS);
            
            return cleanTopics;

        } catch (error) {
            logger.error(`Lỗi khi lấy đề tài của Công ty ${companyId}`, { error: String(error) });
            return [];
        }
    }
}