import { LangGraphRunnableConfig } from '@langchain/langgraph';
import { SkillDefinition } from './registry';
import { StateAnnotation } from '../graph/graph/state';
import { RedisClient } from '../tools/clients/redis.client';
import { createLogger } from '@/common/logger/logger';

const logger = createLogger('AcademicSkill');

export function createAcademicSkill(
    redis: RedisClient,
): SkillDefinition {
    return {
        name: 'academic',
        description:
            'Lấy thông tin tổng quát về kết quả học tập, GPA, CPA, tín chỉ tích lũy, tín chỉ nợ, cảnh cáo học tập của sinh viên trong tất cả các kỳ.',

        async run(
            state: typeof StateAnnotation.State,
            config?: LangGraphRunnableConfig,
        ): Promise<Partial<typeof StateAnnotation.State>> {
            const studentId = config?.configurable?.student_id as string;
            
            if (!studentId) {
                logger.error('AcademicSkill: Bị thiếu tham số student_id trong config');
                return { 
                    skill_results: [{ skill: 'academic', success: false, error: 'Hệ thống bị mất thông tin định danh sinh viên. Vui lòng đăng nhập lại.' }] 
                };
            }

            logger.info(`🚨 ACADEMIC SKILL EXECUTED | student_id=${studentId}`);

            try {
                const academicCache = await redis.get(`hustva:student:${studentId}:academic_results`);

                if (!academicCache) {
                    logger.warn(`AcademicSkill: Không tìm thấy cache academic_results cho ${studentId}`);
                    return {
                        skill_results: [{ 
                            skill: 'academic', 
                            success: false, 
                            error: 'Dữ liệu điểm của bạn đang được hệ thống đồng bộ ngầm. Vui lòng hỏi lại sau khoảng 1 phút nhé!' 
                        }]
                    };
                }

                const academicResults = JSON.parse(academicCache);

                if (Array.isArray(academicResults) && academicResults.length === 0) {
                    return {
                        skill_results: [{ 
                            skill: 'academic', 
                            success: true, 
                            data: { academic_results: [] },
                            llm_instruction: "Sinh viên chưa có kết quả tổng kết của kỳ học nào trong hệ thống."
                        }]
                    };
                }

                if (Array.isArray(academicResults)) {
                    academicResults.sort((a, b) => String(b.semester).localeCompare(String(a.semester)));
                }

                const data = {
                    academic_results: academicResults
                };

                const llm_instruction = `
                    - 'cumulate_credit': Tổng tín chỉ TÍCH LŨY (đã qua).
                    - 'register_credit': Tổng tín chỉ ĐÃ ĐĂNG KÝ.
                    - Tín chỉ nợ/trượt (nếu sinh viên hỏi) có thể ước lượng bằng (register_credit - cumulate_credit) của các kỳ đã kết thúc.
                    - 'warning_level': Mức Cảnh cáo học tập (0 là an toàn).
                `;

                logger.info(`✅ Academic data retrieved for ${studentId} (${academicResults.length} semesters)`);

                return {
                    skill_results: [{ 
                        skill: 'academic', 
                        success: true, 
                        data: data,
                        llm_instruction: llm_instruction 
                    }],
                };

            } catch (error: any) {
                logger.error(`❌ AcademicSkill Error | ${studentId}`, { error: error.message });
                return {
                    skill_results: [{ 
                        skill: 'academic', 
                        success: false, 
                        error: 'Rất tiếc, máy chủ cơ sở dữ liệu đang gặp sự cố khi đọc điểm của bạn.' 
                    }],
                };
            }
        },
    };
}