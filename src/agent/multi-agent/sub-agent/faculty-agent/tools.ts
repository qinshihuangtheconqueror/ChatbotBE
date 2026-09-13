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

export function buildFacultyCareerTools(
    registry: SkillRegistry,

    onSkillRun?: (
        patch: Partial<AppState>
    ) => void,

): StructuredTool[] {

    const tools: StructuredTool[] = [];

    // ─────────────────────────────────────────────
    // teacher_topics
    // ─────────────────────────────────────────────

    if (registry.has('teacher_topics')) {

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
                            .get('teacher_topics')!
                            .run(localState as any, config);

                    onSkillRun?.(patch);

                    return formatToolOutput(
                        'teacher_topics',
                        firstResult(patch),
                    );
                },
                {
    name: 'teacher_topics',

    description:
        `
Tìm kiếm giảng viên và tra cứu danh sách đề tài nghiên cứu, đồ án, thực tập hoặc hướng nghiên cứu mà giảng viên đang hướng dẫn.

Tool này hỗ trợ:
- Tìm giảng viên theo tên
- Fuzzy matching tên giảng viên
- Tìm đề tài do giảng viên hướng dẫn
- Ưu tiên giảng viên cùng viện/khoa với sinh viên
- Gợi ý hướng nghiên cứu phù hợp

Tool tự động:
- Tìm kiếm giảng viên từ hệ thống HUST
- Ranking giảng viên theo mức độ khớp với query
- Boost điểm cho giảng viên cùng school/khoa với sinh viên
- Tải danh sách đề tài từ topic cache
- Trả về các giảng viên phù hợp nhất cùng toàn bộ đề tài

Tool hỗ trợ tìm kiếm bằng:
- Họ tên giảng viên
- Tên không dấu
- Từ khóa gần đúng
- Sai chính tả nhẹ
- Tên viện/khoa/bộ môn

Nếu có nhiều giảng viên trùng tên:
- Tool sẽ ưu tiên:
  + cùng school
  + score matching cao hơn
  + mức độ liên quan cao hơn

Nếu không tìm thấy giảng viên phù hợp:
- Tool trả về danh sách rỗng thay vì lỗi hệ thống.
        `,

    schema:
        z.object({
            query:
                z
                    .string()
                    .min(1)
                    .describe(
                        'Tên giảng viên, bộ môn, viện/khoa hoặc từ khóa dùng để tìm đề tài nghiên cứu và đồ án.',
                    ),
        }),
}
                
            ),
        );
    }

    // ─────────────────────────────────────────────
    // company_topics
    // ─────────────────────────────────────────────

    if (registry.has('company_topics')) {

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
                            .get('company_topics')!
                            .run(localState as any, config);

                    onSkillRun?.(patch);

                    return formatToolOutput(
                        'company_topics',
                        firstResult(patch),
                    );
                },
                {
    name: 'company_topics',

    description:
        `
Tìm kiếm doanh nghiệp và tra cứu danh sách đề tài thực tập, đồ án hoặc nghiên cứu phù hợp với sinh viên.

Tool này hỗ trợ:
- Tìm công ty theo tên hoặc từ khóa
- Semantic matching và fuzzy search tên công ty
- Tra cứu đề tài thực tập / đồ án của từng công ty
- Lọc đề tài theo đơn vị đào tạo của sinh viên
- Gợi ý cơ hội thực tập phù hợp với ngành học

Tool tự động:
- Tìm kiếm công ty từ hệ thống doanh nghiệp
- Ranking các công ty theo mức độ phù hợp với query
- Tải danh sách đề tài từ topic cache
- Lọc đề tài theo school / viện / khoa của sinh viên

Tool hỗ trợ tìm kiếm bằng:
- Tên công ty
- Tên viết tắt
- Từ khóa gần đúng
- Sai chính tả nhẹ
- Từ khóa liên quan doanh nghiệp

Kết quả trả về:
- results:
  + Danh sách công ty phù hợp
- company_info:
  + Thông tin công ty
- matched_topics:
  + Danh sách đề tài phù hợp với sinh viên
- ranking_score:
  + Điểm matching giữa query và công ty
- total_topics_in_db:
  + Tổng số đề tài của công ty trong hệ thống

Nếu không tìm thấy công ty phù hợp, tool sẽ trả về danh sách rỗng thay vì lỗi hệ thống.
        `,

    schema:
        z.object({
            query:
                z
                    .string()
                    .min(1)
                    .describe(
                        'Tên công ty, tên viết tắt hoặc từ khóa dùng để tìm doanh nghiệp và đề tài thực tập/đồ án.',
                    ),
        }),
}
            ),
        );
    }

    return tools;
}