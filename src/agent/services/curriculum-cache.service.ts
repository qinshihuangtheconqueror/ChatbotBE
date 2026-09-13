import { Injectable } from '@nestjs/common';
import { RedisClient } from '@/agent/tools/clients/redis.client';
import { HustApiClient } from '@/agent/tools/clients/hust-api.client';
import { EHustDbApiClient } from '@/agent/tools/clients/ehust-db.client'; // IMPORT MỚI
import { createLogger } from '@/common/logger/logger';
import * as fs from 'fs';
import * as path from 'path';

const logger = createLogger('CurriculumCacheService');
const TTL_1_YEAR = 365 * 24 * 60 * 60;

@Injectable()
export class CurriculumCacheService {
    constructor(
        private readonly redis: RedisClient,
        private readonly hustApi: HustApiClient,
        private readonly ehustDbApi: EHustDbApiClient // INJECT MỚI
    ) {}

    /**
     * Hàm tiện ích: Loại bỏ mã HTML, trả về Text thuần cho LLM
     */
    private stripHtmlToText(html: string): string {
        if (!html) return '';
        
        // 1. Loại bỏ tất cả các thẻ HTML (VD: <p>, <span>, <div>, <br>)
        let text = html.replace(/<[^>]*>?/gm, ' ');
        
        // 2. Decode các ký tự HTML Entities phổ biến
        text = text.replace(/&nbsp;/g, ' ')
                   .replace(/&amp;/g, '&')
                   .replace(/&lt;/g, '<')
                   .replace(/&gt;/g, '>')
                   .replace(/&quot;/g, '"')
                   .replace(/&#39;/g, "'");
                   
        // 3. Dọn dẹp các dấu cách thừa thãi và xuống dòng do HTML để lại
        return text.replace(/\s+/g, ' ').trim();
    }

    private async getProgramIdsFromCsv(): Promise<string[]> {
        const csvPath = path.join(__dirname, '..', '..', 'common', 'data', 'hust_majors.csv');
        try {
            const fileContent = fs.readFileSync(csvPath, 'utf-8');
            const lines = fileContent.split('\n').filter(line => line.trim() !== '');
            const programIds: string[] = [];
            for (let i = 1; i < lines.length; i++) {
                const columns = lines[i].split(',');
                if (columns.length >= 2) {
                    programIds.push(columns[1].trim());
                }
            }
            return programIds;
        } catch (error) {
            logger.error('Lỗi đọc CSV', { error: String(error) });
            return [];
        }
    }

    async syncAllCurriculumsAndCourses(): Promise<void> {
        logger.info('BẮT ĐẦU ĐỒNG BỘ CHƯƠNG TRÌNH ĐÀO TẠO & MÔN HỌC');

        const programIds = await this.getProgramIdsFromCsv();
        if (programIds.length === 0) return;

        const globalCourseIds = new Set<string>();
        const programSkeletons: Record<string, any> = {};

        // ==================================================================
        // BƯỚC 1: XỬ LÝ KHO 2 - BỘ KHUNG CTĐT (PROGRAM SKELETONS)
        // ==================================================================
        logger.info(`Đang kéo dữ liệu CTĐT cho ${programIds.length} ngành...`);
        const BATCH_SIZE = 5;
        
        for (let i = 0; i < programIds.length; i += BATCH_SIZE) {
            const batch = programIds.slice(i, i + BATCH_SIZE);
            const promises = batch.map(async (programId) => {
                try {
                    const progData: any = await this.hustApi.getProgram(programId);
                    if (!progData || !progData.allCourseModules) return;

                    const modules = progData.allCourseModules.filter((m: any) => m.parentId === -1);
                    const moduleMap = new Map(modules.map((m: any) => [m.id, m.name]));

                    const courses = progData.allCourseModules
                        .filter((m: any) => m.parentId !== -1)
                        .map((c: any) => {
                            globalCourseIds.add(c.courseId);

                            const moduleName = String(moduleMap.get(c.parentId)) || 'Chưa phân loại';
                            let semester = c.semester;

                            // XỬ LÝ RIÊNG: Đưa các môn Giáo dục thể chất về kỳ -1
                            if (moduleName.toLowerCase().includes('thể chất')) {
                                semester = -1;
                            }

                            return {
                                course_id: c.courseId,
                                course_name: c.name,
                                module_name: moduleName,
                                semester: semester,
                                optional: c.optional,
                                credit: c.credit,
                                exam_weight: c.examWeight // BỔ SUNG EXAM WEIGHT (Hệ số QT-CK)
                            };
                        });
                    
                    courses.sort((a: any, b: any) => {
                        // Cấp độ 0: Ép toàn bộ môn "Giáo dục thể chất" lên trên cùng của JSON
                        const isPeA = a.module_name.toLowerCase().includes('thể chất') ? 0 : 1;
                        const isPeB = b.module_name.toLowerCase().includes('thể chất') ? 0 : 1;
                        if (isPeA !== isPeB) {
                            return isPeA - isPeB;
                        }

                        // Cấp độ 1: Sắp xếp gom nhóm theo Khối kiến thức (Module)
                        if (a.module_name !== b.module_name) {
                            return a.module_name.localeCompare(b.module_name, 'vi');
                        }

                        // Cấp độ 2: Trong cùng Khối kiến thức, sắp xếp theo Kỳ học (Tăng dần)
                        const semA = a.semester || 99; // Môn nào không có kỳ thì đẩy xuống cuối block
                        const semB = b.semester || 99;
                        if (semA !== semB) {
                            return semA - semB;
                        }

                        // Cấp độ 3: Cùng Khối, cùng Kỳ -> Sắp xếp theo ABC của Mã môn
                        return a.course_id.localeCompare(b.course_id);
                    });

                    programSkeletons[programId] = {
                        program_id: programId,
                        program_name: progData.name,
                        program_name_en: progData.nameEn,
                        root_id: progData.rootId, 
                        root_name: progData.rootName, 
                        learning_outcomes: this.stripHtmlToText(progData.learningOutcomes),
                        total_credit: progData.totalCredit,
                        courses: courses
                    };
                    
                    logger.info(`Đã xử lý xong khung CTĐT ngành: ${programId}`);
                } catch (err) {
                    logger.warn(`Lỗi khi kéo CTĐT ngành ${programId}`, { error: String(err) });
                }
            });

            await Promise.all(promises);
            await new Promise(res => setTimeout(res, 1000));
        }

        for (const [pId, skeleton] of Object.entries(programSkeletons)) {
            await this.redis.set(`hustva:program:${pId}`, JSON.stringify(skeleton), TTL_1_YEAR);
        }
        logger.info(`✅ KHO 2 HOÀN TẤT: ${Object.keys(programSkeletons).length} CTĐT.`);

        if (programIds.length > 0) {
            const sampleProgramId = programIds[0];
            logger.info(`🔍 [SAMPLE DATA] Khung CTĐT của ngành ${sampleProgramId}: \n${JSON.stringify(programSkeletons[sampleProgramId], null, 2)}`);
        }

        // ==================================================================
        // BƯỚC 2: XỬ LÝ KHO 1 - TỪ ĐIỂN MÔN HỌC TỪ EHUST DB
        // ==================================================================
        logger.info('Đang cào dữ liệu Toàn bộ môn học (fetchCourses)...');
        try {
            const allCoursesResponse: any = await this.ehustDbApi.fetchCourses();
            const allCoursesArray: any[] = Array.isArray(allCoursesResponse) ? allCoursesResponse : allCoursesResponse?.data || [];

            let savedCoursesCount = 0;
            const courseSavePromises: Promise<void>[] = [];

            const replaceRoman = (str: string) => str.replace(/\b(i{1,3}|iv|v)\b/g, match => {
                if (match === 'iv') return '4';
                if (match === 'v') return '5';
                return String(match.length);
            });

            // Helper: Loại bỏ dấu tiếng Việt
            const removeAccents = (str: string) => str ? str.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim() : '';

            // Helper: Sinh từ viết tắt (Đã nâng cấp)
            const generateAbbrs = (rawName: string) => {
                let normName = removeAccents(rawName);
                if (!normName) return [];
                
                // 1. Đổi số La Mã (VD: giai tich i -> giai tich 1)
                normName = replaceRoman(normName);

                // 2. Tách từ: CHÚ Ý thêm replace(/-/g, ' ') để chặt dấu gạch ngang của Object-Oriented
                const words = normName.replace(/-/g, ' ').split(/\s+/).filter(w => w.length > 0);
                if (words.length === 0) return [];

                // 3. Lấy tất cả chữ cái đầu (VD: Nhập môn công nghệ phần mềm -> nmcnpm)
                const abbrFull = words.map(w => w.charAt(0)).join('');
                
                // 4. Lấy chữ cái đầu nhưng bỏ qua các từ nối
                const stopWords = ['va', 'cua', 'cho', 'and', 'of', 'in', 'the', 'for'];
                const filteredWords = words.filter(w => !stopWords.includes(w));
                const abbrShort = filteredWords.map(w => w.charAt(0)).join('');
                
                // Trả về mảng unique, chỉ giữ từ >= 2 ký tự
                return [...new Set([abbrFull, abbrShort])].filter(a => a.length >= 2);
            };

            for (const c of allCoursesArray) {
                if (globalCourseIds.has(c.course_id)) {
                    
                    // TẠO LIST VIẾT TẮT CHO CẢ TIẾNG VIỆT VÀ TIẾNG ANH
                    const abbrsVn = generateAbbrs(c.course_name_vn);
                    const abbrsEn = generateAbbrs(c.course_name_en);
                    // Gộp lại và loại bỏ trùng lặp (ví dụ lỡ tên VN và EN giống hệt nhau)
                    const combinedAbbrs = [...new Set([...abbrsVn, ...abbrsEn])];

                    const courseDetail = {
                        course_id: c.course_id,
                        course_name_vn: c.course_name_vn,
                        course_name_en: c.course_name_en,
                        abbrs: combinedAbbrs, // [BỔ SUNG TRƯỜNG MỚI NÀY VÀO CACHE]
                        credit: c.credit,
                        ects: c.ects,
                        credit_info: c.credit_info,
                        exam_type: c.exam_type,
                        link_slide_urls: c.link_slide_urls,
                        outline_urls: c.outline_urls,
                        practice_urls: c.practice_urls,
                        description: this.stripHtmlToText(c.description), 
                        resume: this.stripHtmlToText(c.resume),           
                        staff_names: c.staff_names,
                        prerequisite: c.prerequisite || '', // Học phần tiên quyết
                        corequisite: c.corequisite || '',   // Học phần song hành
                        prior: c.prior || ''                // Học phần học trước
                    };

                    if (savedCoursesCount === 0) {
                        logger.info(`🔍 [SAMPLE DATA] Chi tiết môn học mẫu (${c.course_id}): \n${JSON.stringify(courseDetail, null, 2)}`);
                    }

                    const promise = this.redis.set(`hustva:course:${c.course_id}`, JSON.stringify(courseDetail), TTL_1_YEAR);
                    courseSavePromises.push(promise);
                    savedCoursesCount++;
                }
            }

            await Promise.all(courseSavePromises);
            logger.info(`✅ KHO 1 HOÀN TẤT: ${savedCoursesCount} môn học hợp lệ.`);

        } catch (error) {
            logger.error('Lỗi khi xử lý kho Từ điển Môn học (Bước 2)', { error: String(error) });
        }

        logger.info('🎉 ĐỒNG BỘ GLOBAL CACHE HOÀN TẤT THÀNH CÔNG!');
    }
}