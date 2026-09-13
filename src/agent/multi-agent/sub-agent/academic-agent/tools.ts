import {
    tool,
    StructuredTool,
} from '@langchain/core/tools';

import { z } from 'zod';

import { SkillRegistry } from '../../../skills/registry';

import { LangGraphRunnableConfig } from '@langchain/langgraph';

import { StateAnnotation } from '../../graph/state';

import { firstResult } from '../shared/tool-helpers';

import { formatToolOutput } from '../shared/tool-output';

type AppState =
    typeof StateAnnotation.State;

function getRuntimeState(
    config?: LangGraphRunnableConfig,
): AppState {

    return config?.configurable?.appState;
}

export function buildAcademicTools(
    registry: SkillRegistry,

    onSkillRun?: (
        patch: Partial<AppState>
    ) => void,

): StructuredTool[] {

    const tools: StructuredTool[] = [];

    // ─────────────────────────────────────────────
    // student_info
    // ─────────────────────────────────────────────

    if (registry.has('student_info')) {

        tools.push(
            tool(
                async (_, config) => {

                    const state =
                        getRuntimeState(config);

                    const patch =
                        await registry
                            .get('student_info')!
                            .run(state as any, config);

                    onSkillRun?.(patch);

                    return formatToolOutput(
                        'student_info',
                        firstResult(patch),
                    );
                },
                {
    name: 'student_info',

    description:
        `
Tra cứu hồ sơ và thông tin tổng quan của sinh viên từ hệ thống đào tạo.

Tool này dùng để truy xuất:
- Thông tin cá nhân cơ bản
- MSSV, lớp, ngành học, khóa học
- Giáo viên chủ nhiệm / cố vấn học tập
- Kết quả học tập tổng quan kỳ gần nhất
- GPA / CPA / tín chỉ tích lũy
- Mức cảnh báo học tập
- Hồ sơ mở rộng:
  + Học bổng
  + Khen thưởng
  + Đề tài nghiên cứu / đồ án
  + Giảng viên hướng dẫn

Tool tự động tổng hợp dữ liệu từ nhiều nguồn cache học vụ và hồ sơ sinh viên.

Kết quả trả về có thể bao gồm:
- basic_info
- latest_academic_summary
- extended_profile

        `,

    schema:
        z.object({}),
}
            ),
        );
    }

    // ─────────────────────────────────────────────
    // academic
    // ─────────────────────────────────────────────

    if (registry.has('academic')) {

        tools.push(
            tool(
                async (_, config) => {

                    const state =
                        getRuntimeState(config);

                    const patch =
                        await registry
                            .get('academic')!
                            .run(state as any, config);

                    onSkillRun?.(patch);

                    return formatToolOutput(
                        'academic',
                        firstResult(patch),
                    );
                },
                {
    name: 'academic',

    description:
        `
Tra cứu kết quả học tập tổng quan của sinh viên theo từng học kỳ.

Tool này dùng để truy xuất:
- GPA của từng kỳ học
- CPA tích lũy toàn khóa
- Tổng tín chỉ tích lũy
- Tổng tín chỉ đăng ký
- Tín chỉ nợ / tín chỉ chưa đạt
- Mức cảnh báo học tập
- Thống kê kết quả học tập qua các kỳ

Tool phù hợp cho các câu hỏi mang tính tổng quan học vụ, không dùng để tra cứu điểm chi tiết của từng môn học cụ thể.
        `,

    schema:
        z.object({}),
}
            ),
        );
    }

    // ─────────────────────────────────────────────
    // grade_lookup
    // ─────────────────────────────────────────────

    if (registry.has('grade_lookup')) {

        tools.push(
            tool(
                async (input, config) => {

                    const state =
                        getRuntimeState(config);

                    const localState = {
                        ...state,
                        rewritten_query:
                            input.query,
                    };

                    const patch =
                        await registry
                            .get('grade_lookup')!
                            .run(localState as any, config);

                    onSkillRun?.(patch);

                    return formatToolOutput(
                        'grade_lookup',
                        firstResult(patch),
                    );
                },
                {
    name: 'grade_lookup',

    description:
        `
Tra cứu điểm số của môn học từ bảng điểm cá nhân sinh viên.

Có thể lấy full bảng điểm bằng cách input kì học: VD: 20251 20232 

Tool hỗ trợ tìm kiếm thông minh bằng:
- Mã môn học (VD: IT3150)
- Tên môn tiếng Việt
- Tên môn tiếng Anh
- Tên viết tắt / abbreviation
- Từ khóa gần đúng hoặc viết sai chính tả nhẹ

Kết quả có thể bao gồm:
- Điểm quá trình
- Điểm cuối kỳ
- Điểm chữ
- Số tín chỉ
- Học kỳ đã học
- Trạng thái đạt / không đạt

Nếu không tìm thấy exact match, tool sẽ trả về các môn gần giống nhất để assistant hỏi lại người dùng.
        `,

    schema:
        z.object({
            query:
                z
                    .string()
                    .min(1)
                    .describe(
                        'Tên môn học, mã môn học hoặc từ khóa cần tra cứu điểm.',
                    ),
        }),
}
            ),
        );
    }

    // ─────────────────────────────────────────────
    // course_info
    // ─────────────────────────────────────────────

    if (registry.has('course_info')) {

        tools.push(
            tool(
                async (input, config) => {

                    const state =
                        getRuntimeState(config);

                    const localState = {
                        ...state,
                        rewritten_query:
                            input.query,
                    };

                    const patch =
                        await registry
                            .get('course_info')!
                            .run(localState as any, config);

                    onSkillRun?.(patch);

                    return formatToolOutput(
                        'course_info',
                        firstResult(patch),
                    );
                },
                {
    name: 'course_info',

    description:
        `
Tra cứu thông tin chi tiết của môn học nằm trong chương trình đào tạo của sinh viên.

Tool này sử dụng semantic matching và fuzzy search để tìm kiếm môn học theo:
- Mã môn học
- Tên môn tiếng Việt
- Tên môn tiếng Anh
- Tên viết tắt / abbreviation
- Từ khóa gần đúng hoặc sai chính tả nhẹ

Phạm vi tìm kiếm chỉ giới hạn trong các môn thuộc chương trình đào tạo của sinh viên hiện tại.

Tool hỗ trợ truy xuất:
- Tên môn học
- Mã môn học
- Số tín chỉ
- Học kỳ đề xuất
- Môn bắt buộc / tự chọn
- Trọng số thi cuối kỳ
- Khối kiến thức / module
- Mô tả môn học
- Slide bài giảng
- Đề cương môn học
- Tài liệu thực hành
- Danh sách giảng viên phụ trách

Nếu không tìm thấy exact match, tool sẽ trả về các môn học gần giống nhất để assistant hỏi lại sinh viên xác nhận.
        `,

    schema:
        z.object({
            query:
                z
                    .string()
                    .min(1)
                    .describe(
                        'Tên môn học, mã môn học hoặc từ khóa dùng để tra cứu thông tin môn học.',
                    ),
        }),
},
            ),
        );
    }

    // ─────────────────────────────────────────────
    // program
    // ─────────────────────────────────────────────

    if (registry.has('program')) {

        tools.push(
            tool(
                async (_, config) => {

                    const state =
                        getRuntimeState(config);

                    const patch =
                        await registry
                            .get('program')!
                            .run(state as any, config);

                    onSkillRun?.(patch);

                    return formatToolOutput(
                        'program',
                        firstResult(patch),
                    );
                },
                {
    name: 'program',

    description:
        `
Phân tích tiến độ chương trình đào tạo và tư vấn chiến lược học tập cho sinh viên.

Tool này hoạt động như một Academic Advisor thông minh, sử dụng:
- Hồ sơ sinh viên
- Chương trình đào tạo
- Bảng điểm
- Lịch học hiện tại
- Kết quả học tập tích lũy

để phân tích tình trạng học tập và đưa ra gợi ý đăng ký môn học phù hợp.

Tool hỗ trợ:
- Kiểm tra tiến độ chương trình đào tạo
- Phân tích môn còn thiếu / môn nợ
- Xác định môn rớt cần học lại
- Gợi ý đăng ký môn học theo từng học kỳ
- Tư vấn học kỳ chính / học kỳ hè
- Phân tích cải thiện CPA / nâng hạng bằng
- Theo dõi tiến độ các khối mô-đun
- Kiểm tra tiến độ Thể chất / Triết
- Tư vấn chiến lược tốt nghiệp đúng hạn

Tool phù hợp cho các câu hỏi tư vấn học vụ, chiến lược đăng ký môn học và lập kế hoạch tốt nghiệp.
        `,

    schema:
        z.object({}),
}
            ),
        );
    }

    return tools;
}