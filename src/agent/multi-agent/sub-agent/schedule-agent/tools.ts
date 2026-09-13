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
): Partial<AppState> {

    return (
        config?.configurable?.appState ??
        {}
    );
}

export function buildScheduleTools(
    registry: SkillRegistry,

    onSkillRun?: (
        patch: Partial<AppState>
    ) => void,

): StructuredTool[] {

    const tools: StructuredTool[] = [];

    // ─────────────────────────────────────────────
    // schedule
    // ─────────────────────────────────────────────

    if (registry.has('schedule')) {

        tools.push(
            tool(
                async (input, config) => {

                    try {

                        const state =
                            getRuntimeState(config);

                        const localState: Partial<AppState> = {
                            ...state,

                            rewritten_query:
                                input.query,

                            messages:
                                state?.messages ?? [],

                            student_context:
                                state?.student_context,
                        };

                        const patch =
                            await registry
                                .get('schedule')!
                                .run(
                                    localState as any,
                                    config,
                                );

                        onSkillRun?.(patch);

                        return formatToolOutput(
                            'schedule',
                            firstResult(patch),
                        );

                    } catch (error: any) {

                        return [
                            'STATUS: ERROR',
                            'MESSAGE: schedule tool failed',
                            `DETAIL: ${String(
                                error?.message ?? error,
                            )}`,
                        ].join('\n');
                    }
                },

                {
                    name: 'schedule',

                    description:
                        `
Tra cứu lịch học, thời khóa biểu, phòng học, lịch thi và thông tin học tập trong học kỳ hiện tại của sinh viên.

Tool này hỗ trợ:
- Xem thời khóa biểu hiện tại
- Tra cứu lịch học theo ngày / tuần
- Kiểm tra phòng học và ca học
- Xem lịch thi học kỳ
- Kiểm tra môn học hôm nay / ngày mai
- Phân tích tuần học theo tuần HUST
- Xử lý các môn đồ án, thực tập, thực hành

Tool hiểu các truy vấn tự nhiên như:
- Hôm nay học gì
- Mai có học không
- Lịch thi kỳ này
- Lịch học tuần này
- Kỳ trước học gì
- Môn nào học phòng TC
- Có thi tuần sau không

Kết quả trả về:
- schedule:
  + Danh sách lớp học hiện tại
  + thời gian học
  + phòng học
  + tuần học

- exams:
  + Danh sách lịch thi
  + ngày thi
  + phòng thi
  + nhóm thi

Nếu lịch thi chưa được công bố:
- Tool sẽ trả về exams rỗng và hướng dẫn sinh viên chờ phòng đào tạo cập nhật.

Nếu dữ liệu thời khóa biểu chưa đồng bộ:
- Tool trả về thông báo đồng bộ thay vì lỗi hệ thống nghiêm trọng.
                        `,

                    schema:
                        z.object({
                            query:
                                z
                                    .string()
                                    .min(1)
                                    .describe(
                                        'Câu hỏi liên quan tới lịch học, lịch thi, phòng học hoặc thời khóa biểu.',
                                    ),
                        }),
                },
            ),
        );
    }

    return tools;
}