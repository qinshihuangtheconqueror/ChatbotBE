import { LangGraphRunnableConfig } from '@langchain/langgraph';
import { SkillDefinition } from './registry';
import { StateAnnotation } from '../graph/graph/state';
import { RedisClient } from '../tools/clients/redis.client';
import { HustApiClient } from '../tools/clients/hust-api.client';
import { TopicCacheService } from '../services/topic-cache.service';
import { createLogger } from '@/common/logger/logger';

const logger = createLogger('TeacherTopicsSkill');

// Key lưu trữ toàn bộ hồ sơ Giảng viên đã từng được tìm thấy
const GLOBAL_TEACHERS_CACHE_KEY = 'hustva:global_teachers_cache';
const TTL_30_DAYS = 30 * 24 * 60 * 60;
export function createTeacherTopicsSkill(
    redis: RedisClient,
    hustApi: HustApiClient,
    topicCacheService: TopicCacheService
): SkillDefinition {
    return {
        name: 'teacher_topics',
        description: 'Tìm kiếm danh sách đề tài nghiên cứu, đồ án của một Giảng viên cụ thể trong trường của sinh viên.',

        async run(
            state: typeof StateAnnotation.State & { extracted_teacher_name?: string },
            config?: LangGraphRunnableConfig,
        ): Promise<Partial<typeof StateAnnotation.State>> {
            const studentId = config?.configurable?.student_id as string;
            if (!studentId) return { skill_results: [] };

            const cleanKeyword = state.extracted_teacher_name?.trim().toLowerCase() || '';

            if (!cleanKeyword || cleanKeyword.length < 2) {
                return { skill_results: [{ skill: 'teacher_topics', success: false, error: 'Vui lòng cung cấp rõ tên Giảng viên cần tìm.' }] };
            }

            try {
                // 1. Kéo thông tin trường của sinh viên
                const infoCache = await redis.get(`hustva:student:${studentId}:info`);
                const studentSchool = infoCache ? JSON.parse(infoCache).school?.toLowerCase() || '' : '';

                if (!studentSchool) {
                    logger.warn(`Không tìm thấy thông tin trường của sinh viên ${studentId} trong Cache.`);
                }

                // HÀM CHUẨN HÓA CHỮ VIỆT KHÔNG DẤU
                const normalize = (str: string) => str ? str.toLowerCase().trim() : '';
                const sSchoolNorm = normalize(studentSchool);
                const qKeywordNorm = normalize(cleanKeyword);
                const qWordsCount = qKeywordNorm.split(/\s+/).length;

                // 2. LẤY DANH SÁCH GV TỪ REDIS POOL
                let cachedTeachers: any[] = [];
                try {
                    const cacheStr = await redis.get(GLOBAL_TEACHERS_CACHE_KEY);
                    if (cacheStr) cachedTeachers = JSON.parse(cacheStr);
                } catch (e) {
                    logger.error('Lỗi khi đọc cache danh sách giảng viên', e);
                }

                // 3. GỌI API SEARCH LẤY TOP 20
                logger.info(`🚨 TEACHER EXTRACT | Search API với: "${cleanKeyword}"`);
                const searchRes: any = await hustApi.searchTeacher(cleanKeyword);
                const apiTeachers = Array.isArray(searchRes) ? searchRes : searchRes?.data || [];

                // 4. GỘP DỮ LIỆU & LOẠI BỎ TRÙNG LẶP (DEDUPLICATE)
                const mergedMap = new Map();
                
                // Nạp API vào trước (để lấy data mới nhất nếu có cập nhật)
                apiTeachers.forEach((t: any) => mergedMap.set(t.id, t));
                
                // Nạp Cache vào sau (chỉ thêm những người API bị hụt do limit 20)
                cachedTeachers.forEach((t: any) => {
                    if (!mergedMap.has(t.id)) mergedMap.set(t.id, t);
                });

                const allTeachers = Array.from(mergedMap.values());

                // 🚀 LƯU LẠI VÀO REDIS CHO NHỮNG LẦN SAU (Fire & Forget)
                redis.set(GLOBAL_TEACHERS_CACHE_KEY, JSON.stringify(allTeachers), TTL_30_DAYS).catch(e => logger.error('Lỗi lưu cache giảng viên', e));

                // 5. LỌC TUYỆT ĐỐI THEO TÊN + TRƯỜNG VÀ TÍNH % MATCH
                let highMatchTeachers: any[] = [];
                let lowMatchTeachers: any[] = [];

                allTeachers.forEach((t: any) => {
                    const tSchoolNorm = normalize(t.schoolName);
                    const tFullNameNorm = normalize(t.fullName);
                    
                    // KIỂM TRA ĐIỀU KIỆN TIÊN QUYẾT:
                    // - Phải có trường và thuộc trường của Sinh viên
                    // - Tên GV phải chứa từ khóa tìm kiếm (để loại những GV cũ không liên quan trong Cache)
                    const isSchoolMatch = !sSchoolNorm || (tSchoolNorm && tSchoolNorm.includes(sSchoolNorm));
                    
                    if (isSchoolMatch && tFullNameNorm.includes(qKeywordNorm)) {
                        
                        const tWordsCount = tFullNameNorm.split(/\s+/).length;
                        const matchRatio = qWordsCount / tWordsCount;

                        if (matchRatio >= 0.5) {
                            highMatchTeachers.push(t);
                        } else {
                            lowMatchTeachers.push(t);
                        }
                    }
                });

                if (highMatchTeachers.length === 0 && lowMatchTeachers.length === 0) {
                     return {
                        skill_results: [{
                            skill: 'teacher_topics',
                            success: true,
                            data: { keyword: cleanKeyword },
                            llm_instruction: `Tìm thấy giảng viên tên "${cleanKeyword}" nhưng thuộc các Viện/Trường khác, không có ai thuộc trường/viện hiện tại của sinh viên. Báo cho sinh viên biết điều này.`
                        }]
                    };
                }

                // 6. KỊCH BẢN XỬ LÝ KẾT QUẢ ĐẦU RA
                const finalResults: any = {
                    exact_matches: [], // >= 50% -> Lấy đề tài
                    need_clarification: [] // < 50% -> Chỉ lấy tên
                };

                let llm_instruction = "";

                // TH1: TÌM RA DUY NHẤT 1 CÔ (Đặc quyền: Auto Lấy đề tài luôn)
                if (highMatchTeachers.length + lowMatchTeachers.length === 1) {
                    const theTeacher = highMatchTeachers.length > 0 ? highMatchTeachers[0] : lowMatchTeachers[0];
                    const topics = await topicCacheService.getTeacherTopicsWithCache(theTeacher.id);
                    finalResults.exact_matches.push({
                        teacher_info: { id: theTeacher.id, full_name: theTeacher.fullName, email: theTeacher.email },
                        topics: topics
                    });
                    llm_instruction = "Hệ thống tìm thấy 1 giảng viên duy nhất khớp tên trong trường của sinh viên. Trình bày chi tiết các đề tài nghiên cứu này.";
                } 
                // TH2: CÓ TỪ 2 CÔ TRỞ LÊN CÙNG TRƯỜNG -> ÁP DỤNG LUẬT 50%
                else {
                    // Nhóm High Match: Kéo đề tài
                    for (const teacher of highMatchTeachers) {
                        const topics = await topicCacheService.getTeacherTopicsWithCache(teacher.id);
                        finalResults.exact_matches.push({
                            teacher_info: { id: teacher.id, full_name: teacher.fullName, email: teacher.email },
                            topics: topics
                        });
                    }

                    // Nhóm Low Match: Chỉ hiện tên để hỏi lại
                    for (const teacher of lowMatchTeachers) {
                        finalResults.need_clarification.push({
                            id: teacher.id, full_name: teacher.fullName, email: teacher.email
                        });
                    }

                    // Điều hướng LLM Prompt
                    if (finalResults.exact_matches.length > 0 && finalResults.need_clarification.length === 0) {
                        llm_instruction = "Tìm thấy các giảng viên khớp với tên và đã có thông tin đề tài. Hãy liệt kê cho sinh viên chọn.";
                    } else if (finalResults.exact_matches.length === 0 && finalResults.need_clarification.length > 0) {
                        llm_instruction = "Từ khóa quá chung chung, tìm thấy nhiều giảng viên cùng trường nhưng không thể xác định cụ thể (match < 50%). Hãy liệt kê danh sách 'need_clarification' và YÊU CẦU sinh viên cung cấp đầy đủ họ tên để tìm đề tài.";
                    } else {
                        llm_instruction = "Tìm thấy một số giảng viên khớp tốt (đã kèm đề tài) và một số giảng viên tên tương tự. Hãy liệt kê các đề tài trước, sau đó hỏi sinh viên nếu họ đang tìm một giảng viên khác trong danh sách chưa rõ.";
                    }
                }

                return {
                    skill_results: [{ 
                        skill: 'teacher_topics', 
                        success: true, 
                        data: finalResults, 
                        llm_instruction: llm_instruction 
                    }]
                };

            } catch (error: any) {
                logger.error(`❌ Teacher Topics Error`, { error: error.message });
                return { skill_results: [{ skill: 'teacher_topics', success: false, error: 'Lỗi hệ thống khi tìm kiếm giảng viên.' }] };
            }
        }
    };
}