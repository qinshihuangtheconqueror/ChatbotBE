import { LangGraphRunnableConfig } from '@langchain/langgraph';
import { SkillDefinition } from './registry';
import { StateAnnotation } from '../graph/graph/state';
import { RedisClient } from '../tools/clients/redis.client';
import { createLogger } from '@/common/logger/logger';

const logger = createLogger('StudentInfoSkill');

export function createStudentInfoSkill(redis: RedisClient): SkillDefinition {
    return {
        name: 'student_info',
        description: 'Tra cứu thông tin cá nhân của sinh viên (họ tên, lớp, ngành học, giáo viên quản lý lớp), kết quả học tập tổng quan (CPA, tín chỉ, mức cảnh cáo) và hồ sơ mở rộng (học bổng, khen thưởng, đề tài đồ án/nghiên cứu khoa học).',

        async run(
            state: typeof StateAnnotation.State,
            config?: LangGraphRunnableConfig,
        ): Promise<Partial<typeof StateAnnotation.State>> {
            const studentId = config?.configurable?.student_id as string;
            if (!studentId) {
                return { skill_results: [{ skill: 'student_info', success: false, error: 'Mất thông tin định danh sinh viên. Vui lòng đăng nhập lại.' }] };
            }

            logger.info(`🚨 STUDENT INFO EXECUTED | student_id: ${studentId}`);

            try {
                // Lấy song song 3 kho dữ liệu cá nhân
                const [infoCache, academicCache, extendedProfileCache] = await Promise.all([
                    redis.get(`hustva:student:${studentId}:info`),
                    redis.get(`hustva:student:${studentId}:academic_results`),
                    redis.get(`hustva:student:${studentId}:extended_profile`)
                ]);

                // Nếu mất info cơ bản, coi như chưa kéo được gì
                if (!infoCache) {
                    return { 
                        skill_results: [{ 
                            skill: 'student_info', 
                            success: false, 
                            error: 'Thông tin cá nhân của bạn đang được hệ thống đồng bộ ngầm. Vui lòng hỏi lại sau khoảng 1 phút nhé!' 
                        }] 
                    };
                }

                // 1. Xử lý Basic Info
                const basicInfo = JSON.parse(infoCache);

                // 2. Xử lý Academic Results (Chỉ lấy kỳ mới nhất)
                let latestAcademicResult = null;
                if (academicCache) {
                    const allResults: any[] = JSON.parse(academicCache);
                    if (Array.isArray(allResults) && allResults.length > 0) {
                        // Sắp xếp giảm dần theo kỳ để chắc chắn phần tử đầu tiên là mới nhất
                        allResults.sort((a, b) => String(b.semester).localeCompare(String(a.semester)));
                        latestAcademicResult = allResults[0];
                    }
                }

                // 3. Xử lý Extended Profile (Hồ sơ mở rộng: Đồ án, Khen thưởng, Học bổng)
                let extendedProfile: any = null;
                let isExtendedSyncing = false;
                
                if (extendedProfileCache) {
                    extendedProfile = JSON.parse(extendedProfileCache);
                    // Ẩn đi crypt_studentid vì LLM không cần biết chuỗi hash mã hóa này làm gì
                    if (extendedProfile?.crypt_studentid) {
                        delete extendedProfile.crypt_studentid;
                    }
                } else {
                    isExtendedSyncing = true; // Đánh dấu là luồng chậm eHUST vẫn chưa chạy xong
                }

                // Đóng gói dữ liệu trả về
                const data = {
                    basic_info: basicInfo,
                    latest_academic_summary: latestAcademicResult || { note: "Chưa có dữ liệu kết quả học tập." },
                    extended_profile: extendedProfile || { note: "Đang chờ đồng bộ ngầm từ cơ sở dữ liệu sâu..." },
                    is_syncing_extended_data: isExtendedSyncing
                };

                // Xây dựng LLM Instruction để mô hình hiểu cách xưng hô và giải thích thuật ngữ
                let llm_instruction = `
HƯỚNG DẪN XỬ LÝ DỮ LIỆU THÔNG TIN SINH VIÊN:
- 'basic_info': Chứa thông tin cốt lõi. 'teachers' thường là Giáo viên chủ nhiệm/Cố vấn học tập.
- 'latest_academic_summary': Chứa tổng kết của kỳ GẦN NHẤT. 
   + 'cpa': Điểm trung bình tích lũy toàn khóa.
   + 'gpa': Điểm trung bình riêng của kỳ đó.
   + 'cumulate_credit': Tổng tín chỉ đã tích lũy (qua môn).
   + 'warning_level': Mức độ cảnh cáo học tập (0 là an toàn, >0 là đang bị cảnh cáo).
- 'extended_profile': Chứa các thông tin về Khen thưởng (reward), Học bổng (scholarship), và Đề tài nghiên cứu/Đồ án (projects). Trong projects, 'teacher_name' là Giảng viên hướng dẫn đồ án đó.

Quy tắc giao tiếp: Dùng giọng điệu thân thiện, xưng hô phù hợp (ví dụ: "CPA hiện tại của bạn là..."). Không liệt kê máy móc tất cả thông tin nếu sinh viên chỉ hỏi 1 mục cụ thể.
`;

                if (isExtendedSyncing) {
                    llm_instruction += `\nLƯU Ý QUAN TRỌNG: Dữ liệu 'extended_profile' (Đồ án, Học bổng, Khen thưởng, Địa chỉ) hiện tại đang bị trống vì hệ thống đang lấy ngầm (mất khoảng 30s). Nếu sinh viên hỏi về các thông tin này, hãy nói: "Dữ liệu hồ sơ mở rộng của bạn đang được hệ thống đồng bộ. Bạn vui lòng chờ khoảng 30 giây rồi hỏi lại mình nhé!"`;
                }


                return {
                    skill_results: [{ 
                        skill: 'student_info', 
                        success: true, 
                        data: data,
                        llm_instruction: llm_instruction
                    }],
                };

            } catch (error: any) {
                logger.error(`❌ StudentInfo Error | ${studentId}`, { error: error.message });
                return { 
                    skill_results: [{ 
                        skill: 'student_info', 
                        success: false, 
                        error: 'Lỗi hệ thống khi truy xuất hồ sơ sinh viên.' 
                    }] 
                };
            }
        },
    };
}