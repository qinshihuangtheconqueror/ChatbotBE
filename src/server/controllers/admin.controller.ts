import { Controller, Post, Get, Headers, UnauthorizedException, Res, HttpStatus } from '@nestjs/common';
import { Response } from 'express';
import { CurriculumCacheService } from '@/agent/services/curriculum-cache.service';
import { HistoryService } from '@/server/services/history.service';
import { envConfig } from '@/common/config/env.config';

@Controller('admin') 
export class AdminController {
    constructor(
        private readonly curriculumCache: CurriculumCacheService,
        // 🌟 INJECT HISTORY SERVICE
        private readonly historyService: HistoryService
    ) {}

    // ====================================================================
    // HÀM KIỂM TRA TOKEN BẢO MẬT DÙNG CHUNG
    // ====================================================================
    private validateAdminToken(authHeader: string) {
        const validToken = envConfig.ADMIN_TOKEN;
        if (!validToken) {
            throw new UnauthorizedException('Hệ thống chưa cấu hình biến môi trường ADMIN_TOKEN!');
        }
        
        const isMatched = authHeader && (
            authHeader === `Bearer ${validToken}` || 
            authHeader === `bearer ${validToken}`
        );

        if (!isMatched) {
            throw new UnauthorizedException('Token không hợp lệ! Truy cập bị từ chối.');
        }
    }

    // ====================================================================
    // API 1: ĐỒNG BỘ DỮ LIỆU
    // Endpoint: POST /admin/sync-curriculum
    // ====================================================================
    @Post('sync-curriculum')
    async syncCurriculum(@Headers('authorization') authHeader: string) {
        // 1. Kiểm tra lớp khiên bảo mật
        this.validateAdminToken(authHeader);

        // 2. Token hợp lệ -> Kích hoạt tiến trình chạy ngầm
        this.curriculumCache.syncAllCurriculumsAndCourses().catch(e => {
            console.error('Lỗi khi chạy ngầm sync Curriculum:', e);
        });
        
        return { 
            status: 'success',
            message: 'Tiến trình đồng bộ Chương trình đào tạo & Môn học đã bắt đầu chạy ngầm!' 
        };
    }

    // ====================================================================
    // API 2: XUẤT DỮ LIỆU ĐÁNH GIÁ (FEEDBACK)
    // Endpoint: GET /admin/feedbacks
    // ====================================================================
    @Get('feedbacks')
    async getAdminFeedbacks(@Headers('authorization') authHeader: string) {
        // 1. Kiểm tra lớp khiên bảo mật
        this.validateAdminToken(authHeader);

        // 2. Gọi HistoryService để bóc tách dữ liệu
        console.log('Admin triggered: Pulling all student feedback logs');
        const logs = await this.historyService.getAllFeedbacks();
        
        // 3. Trích xuất list MSSV không trùng lặp (lọc bỏ các bản ghi không có ID)
        const uniqueStudents = Array.from(new Set(logs.map(log => log.studentId).filter(id => id !== 'Ẩn danh')));

        return {
            status: 'success',
            data: {
                total_feedbacks: logs.length,
                total_participating_students: uniqueStudents.length,
                participating_student_ids: uniqueStudents,
                feedbacks: logs
            }
        };
    }

    // ====================================================================
    // API 3: XUẤT TOÀN BỘ LỊCH SỬ CHAT (BACKUP)
    // Endpoint: GET /admin/export-chats
    // ====================================================================
    @Get('export-chats')
    async exportChatLogs(
        @Headers('authorization') authHeader: string,
        @Res() res: Response
    ) {
        try {
            // 1. Kiểm tra lớp khiên bảo mật
            this.validateAdminToken(authHeader);

            console.log('Admin triggered: Exporting all conversation logs to JSON file');

            // 2. Kích hoạt luồng Streaming để tạo file JSON
            const filePath = await this.historyService.exportAllMessagesToFile();

            // 3. Trả file về cho Client tải xuống
            return res.download(filePath, (err) => {
                if (err) {
                    console.error('Lỗi khi gửi file tải xuống qua stream:', err);
                    // Chỉ gửi response lỗi nếu header chưa bị khóa (chưa bắt đầu tải)
                    if (!res.headersSent) {
                        res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
                            status: 'error',
                            message: 'Lỗi trong quá trình tải file về máy.',
                        });
                    }
                }
            });
            
        } catch (error: any) {
            console.error('Lỗi API export-chats:', error);
            if (!res.headersSent) {
                return res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({ 
                    status: 'error',
                    message: 'Có lỗi xảy ra khi export dữ liệu hệ thống.',
                    error: error.message 
                });
            }
        }
    }

    // ====================================================================
    // API 4: XUẤT DỮ LIỆU THỐNG KÊ SO SÁNH (A/B TESTING)
    // Endpoint: GET /admin/compare-feedbacks
    // ====================================================================
    @Get('compare-feedbacks')
    async getAdminCompareFeedbacks(@Headers('authorization') authHeader: string) {
        // 1. Kiểm tra lớp khiên bảo mật
        this.validateAdminToken(authHeader);

        // 2. Gọi HistoryService để bóc tách dữ liệu
        console.log('Admin triggered: Pulling all dual-agent comparison logs');
        const logs = await this.historyService.getCompareFeedbacks();
        
        // 3. Trích xuất list MSSV không trùng lặp
        const uniqueStudents = Array.from(new Set(logs.map(log => log.studentId).filter(id => id !== 'Ẩn danh')));

        // 4. Tính toán thống kê nhanh (Win rate)
        const totalA = logs.filter(log => log.chosenLabel === 'A').length;
        const totalB = logs.filter(log => log.chosenLabel === 'B').length;
        const totalComparisons = logs.length;

        return {
            status: 'success',
            data: {
                total_comparisons: totalComparisons,
                total_participating_students: uniqueStudents.length,
                stats: {
                    chosen_A: totalA,
                    chosen_B: totalB,
                    win_rate_A: totalComparisons > 0 ? ((totalA / totalComparisons) * 100).toFixed(2) + '%' : '0%',
                    win_rate_B: totalComparisons > 0 ? ((totalB / totalComparisons) * 100).toFixed(2) + '%' : '0%'
                },
                feedbacks: logs // Danh sách chi tiết nằm ở đây
            }
        };
    }
}