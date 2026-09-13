import { LangGraphRunnableConfig } from '@langchain/langgraph';
import { StateAnnotation } from './state';
import { createLogger } from '@/common/logger/logger';

const logger = createLogger('HandleErrorNode');

export async function handleErrorNode(
    state: typeof StateAnnotation.State,
    _config?: LangGraphRunnableConfig,
): Promise<Partial<typeof StateAnnotation.State>> {
    const err = state.error;
    logger.error('Handling graph error', err, { code: err?.code, where: err?.where });
    
    const errorText = err?.code === 'SKILL_FAILED'
        ? 'Xin lỗi, hệ thống hiện không thể lấy dữ liệu. Vui lòng thử lại sau vài phút.'
        : err?.code === 'INVALID_INPUT'
            ? 'Câu hỏi không hợp lệ. Vui lòng nhập lại.'
            : 'Xin lỗi, đã xảy ra lỗi không mong muốn. Vui lòng thử lại.';

    return { final_text: errorText };
}
