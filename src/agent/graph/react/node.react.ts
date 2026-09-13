import { LangGraphRunnableConfig } from '@langchain/langgraph';
import { StateAnnotation } from '../graph/state';
import { LlmFactory } from '../../llm/llm.factory';
import { SkillRegistry } from '../../skills/registry';
import { runReActAgent } from './react.agent';
import { createLogger } from '@/common/logger/logger';

const logger = createLogger('ReactNode');

export function createReactNode(
    llmFactory?: LlmFactory,
    registry?: SkillRegistry,
) {
    return async function reactNode(
        state: typeof StateAnnotation.State,
        config?: LangGraphRunnableConfig,
    ): Promise<Partial<typeof StateAnnotation.State>> {

        if (!llmFactory || !registry) {
            return {
                draft_answer: "Hệ thống đang gặp sự cố. Vui lòng thử lại sau.",
                routing: { intent: 'react_error', confidence: 0, reason: 'Missing Dependencies' },
            };
        }

        // 1. ĐỌC DỮ LIỆU TỪ 2 ROUTER TRƯỚC ĐÓ
        const ruleMatches: string[] = state.rule_matches || [];
        const signalScores: Array<{skill: string, score: number}> = state.signal_scores || []; 

        // 🔥 GHI LOG ĐỂ PHỤC VỤ TUNE THAM SỐ SAU NÀY
        logger.info('ReactNode: Raw Inputs from Routers', { 
            ruleMatches, 
            signalScores 
        });

        // 2. HỢP NHẤT VÀ CỘNG ĐIỂM (Soft Boost +0.2)
        const scoreMap = new Map<string, number>();
        signalScores.forEach(s => scoreMap.set(s.skill, s.score));

        // Cộng 0.2 cho các skill lọt vào Rule Router, trần tối đa là 1.0
        ruleMatches.forEach(skill => {
            const currentScore = scoreMap.get(skill) || 0;
            const boostedScore = Math.min(currentScore + 0.1, 1.0); // Giới hạn max là 1.0
            scoreMap.set(skill, boostedScore);
        });

        // Sắp xếp giảm dần theo điểm mới
        const sortedSkills = Array.from(scoreMap.entries())
            .map(([skill, score]) => ({ skill, score }))
            .sort((a, b) => b.score - a.score);

        logger.info('ReactNode: Aggregated & Sorted Scores', { sortedSkills });

        // 3. DYNAMIC MARGIN CUT-OFF (Biên độ động)
        let allowedTools: string[] = [];
        
        if (sortedSkills.length > 0) {
            const maxScore = sortedSkills[0].score;
            const ABSOLUTE_MIN = 0.40; // Dưới 0.4 thì loại bỏ
            // Biên độ 0.15 thay vì 0.10: đo leave-one-out trên 145 ví dụ intents.json cho thấy
            // recall (skill ĐÚNG có lọt vào allowedTools không) tăng 97.9% -> 100%, đổi lại
            // LLM nhận trung bình 5.1 tool thay vì 3.7. Trần 6 tool bên dưới vẫn giữ nguyên.
            const MARGIN = 0.15;       // Lấy các tool chênh tối đa 0.15 so với top 1

            const dynamicThreshold = Math.max(ABSOLUTE_MIN, maxScore - MARGIN);

            for (const item of sortedSkills) {
                if (item.score >= dynamicThreshold) {
                    allowedTools.push(item.skill);
                } else {
                    break; 
                }
            }
        }

        // 4. XỬ LÝ CHITCHAT VÀ CAP LIMIT
        let isChitchatOnly = false;
        
        if (allowedTools.includes('chitchat')) {
            const chitchatScore = scoreMap.get('chitchat') || 0;
            allowedTools = allowedTools.filter(t => t !== 'chitchat');
            
            // Nếu sau khi loại các tool khác, không còn tool nào VÀ điểm chitchat khá cao
            if (allowedTools.length === 0 && chitchatScore > 0.5) {
                isChitchatOnly = true;
            }
        }

        // Khóa trần Tools để LLM không bị loạn
        if (allowedTools.length > 6) {
            allowedTools = allowedTools.slice(0, 6);
        }

        // 🔒 ÉP policy_search LUÔN có mặt (thêm SAU khi cắt trần để không bao giờ bị loại).
        // Nó rẻ (~0.8s) nhưng là lưới tra cứu tài liệu BAO TRÙM nhất; prompt của react.agent sẽ ép
        // LLM gọi SONG SONG, và react.agent còn có fallback nếu LLM vẫn quên. Bỏ qua nếu là chitchat thuần.
        if (!isChitchatOnly && registry.has('policy_search') && !allowedTools.includes('policy_search')) {
            allowedTools.push('policy_search');
        }

        logger.info('ReactNode: Final Tools passed to LLM', { allowedTools, isChitchatOnly });

        // ====================================================================
        // 🔥 LÁ CHẮN TỐI ƯU HÓA: BYPASS REACT AGENT NẾU LÀ CHITCHAT
        // ====================================================================
        if (isChitchatOnly) {
            logger.info('ReactNode: Fast-tracking Chitchat (Bypassing ReAct Agent LLM)');
            
            // Trả về State ngay lập tức, không thèm gọi `runReActAgent`
            return {
                routing: {
                    ...(state.routing ?? {}),
                    intent: 'direct_chitchat', // Báo cho Node sau biết đây là chitchat thuần túy
                    confidence: 0.99,
                    reason: 'Bypassed ReAct Agent due to high Chitchat score with no other tools',
                },
                // Đóng gói 1 cái skill_result ảo để Compose Node biết đường xưng hô (nếu cần)
                skill_results: [
                    ...(state.skill_results ?? []),
                    {
                        skill: 'chitchat',
                        success: true,
                        llm_instruction: "Đây là một câu chào hỏi, cảm ơn hoặc giao tiếp thông thường. Hãy trả lời thân thiện, lịch sự và ngắn gọn như một trợ lý ảo của ĐHBK Hà Nội. KHÔNG CẦN TÌM KIẾM DỮ LIỆU."
                    }
                ]
            };
        }

        // 5. GỌI LLM REACT AGENT CHO CÁC NGHIỆP VỤ CẦN TOOL
        try {
            const result = await runReActAgent(state, llmFactory, registry, allowedTools, config);

            return {
                skill_results: [
                    ...(state.skill_results ?? []),
                    ...result.skillResults,
                ],
                citations: result.citations,
                draft_answer: result.draftAnswer || undefined,
                token_usage: result.tokenUsage,
                routing: {
                    ...(state.routing ?? {}),
                    intent: result.toolsUsed.length > 0 ? `react_agent (${result.toolsUsed.join(', ')})` : 'react_agent_no_tool',
                    confidence: 0.9,
                    reason: `Boosted Pruned ReAct, allowed: ${allowedTools.join(',')}, used: ${result.toolsUsed.join(', ')}`,
                },
            };

        } catch (e) {
            logger.error('ReactNode: Router error', { error: String(e) });
            return {
                draft_answer: "Xin lỗi, tôi đang gặp chút khó khăn khi xử lý yêu cầu này. Bạn có thể thử hỏi lại được không?",
                routing: {
                    intent: 'react_error_fallback',
                    confidence: 0,
                    reason: `ReAct failed: ${String(e).slice(0, 80)}`,
                },
            };
        }
    };
}
