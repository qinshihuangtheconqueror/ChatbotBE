import { Annotation } from '@langchain/langgraph';
import { BaseMessage } from '@langchain/core/messages';

// ─── Domain Types ────────────────────────────────────────────────────────────

export type SkillResult = {
    skill: string;
    success: boolean;
    data?: Record<string, unknown>;
    error?: string;
    llm_instruction?: string; // Mới thêm: Trực tiếp hướng dẫn LLM cách trả lời
};

export type GradeRecord = {
    classId: string;
    courseId: string;
    semester: string;
    examMark: number;          
    processMark: number;
    finalMarkLetter: string;   
};

export type AcademicResult = {
    semester: string;
    gpa?: number;
    cpa?: number;
    level?: number;            
};

export type StudentContext = {
    studentId: string;
    fullName: string;
    program: string;
    programId: string;
    school: string;
    schoolId: number;
    status: string;
    currentSemester?: string;
    grades?: GradeRecord[];
    academicResults?: AcademicResult[];
};

export type Citation = {
    source: 'kb' | 'hust_api' | 'neo4j';
    id: string;
    title?: string;
    section?: string;  
    link?: string;     
    anchor?: string;   // [C1], [C2]... 
};

export type ErrorState = {
    code: 'INVALID_INPUT' | 'SKILL_FAILED' | 'LLM_ERROR' | 'INTERNAL';
    message: string;
    where?: string;
};

export type RoutingMetadata = {
    intent?: string;
    confidence?: number;
    reason?: string;
    rule_matched?: boolean; // true = Đã bắt trúng Rule/Signal, bypass ReAct
};

export type TokenUsage = {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
};

// ─── State Annotation ────────────────────────────────────────────────────────

export const StateAnnotation = Annotation.Root({
    // ── Conversation ──────────────────────────────────────────────────────
    messages: Annotation<BaseMessage[]>({
        reducer: (x, y) => x.concat(y),
        default: () => [],
    }),
    history_summary: Annotation<string>({
        reducer: (_, y) => y ?? _,
        default: () => '',
    }),
    rewritten_query: Annotation<string>({
        reducer: (_, y) => y ?? _,
        default: () => '',
    }),
    hyde_query: Annotation<string | null>({
        reducer: (_, y) => y ?? _,
        default: () => null,
    }),
    semantic_intent: Annotation<string | null>({
        reducer: (_, y) => y ?? _,
        default: () => null,
    }),
    /**
     * Ảnh sinh viên đính kèm cho LƯỢT HỎI HIỆN TẠI (data-URI, đã qua sanitizeImages).
     * Cố ý để RIÊNG khỏi `messages`: nếu nhét content dạng mảng vào HumanMessage thì
     * mọi node đang kiểm tra `typeof content === 'string'` (ingress, rule-router,
     * signal-router, react.agent, compose) sẽ âm thầm nhận chuỗi rỗng và hỏng định tuyến.
     * Chỉ node compose đọc kênh này để dựng nội dung đa phương thức khi gọi LLM.
     */
    images: Annotation<string[]>({
        reducer: (_, y) => y ?? [],
        default: () => [],
    }),

    // ── Routing ───────────────────────────────────────────────────────────
    selected_skills: Annotation<string[]>({
        reducer: (_, y) => y,
        default: () => [],
    }),
    routing: Annotation<RoutingMetadata | null>({
        reducer: (_, y) => y,
        default: () => null,
    }),
    iteration_count: Annotation<number>({
        reducer: (x, y) => (y !== undefined ? y : x),
        default: () => 0,
    }),
    enrichment_queries: Annotation<Record<string, string> | null>({
        reducer: (_, y) => y ?? _,
        default: () => null,
    }),
    rule_matches: Annotation<string[]>({
        reducer: (_, y) => y,
        default: () => [],
    }),
    signal_scores: Annotation<Array<{skill: string, score: number}>>({
        reducer: (_, y) => y,
        default: () => [],
    }),

    // ── Skill data ────────────────────────────────────────────────────────
    student_context: Annotation<StudentContext | null>({
        reducer: (_, y) => y,
        default: () => null,
    }),
  
    skill_results: Annotation<SkillResult[]>({
    reducer: (_, y) => y, 
    default: () => [],
}),
    citations: Annotation<Citation[]>({
        reducer: (_, y) => y, 
        default: () => [],
    }),

    // ── Output ────────────────────────────────────────────────────────────
    draft_answer: Annotation<string | null>({
        reducer: (_, y) => y,
        default: () => null,
    }),
    final_text: Annotation<string | null>({
        reducer: (_, y) => y,
        default: () => null,
    }),
    thread_title: Annotation<string | undefined>({
        reducer: (x, y) => y ?? x,
        default: () => undefined,
    }),

    // ── Error & Metrics ───────────────────────────────────────────────────
    error: Annotation<ErrorState | null>({
        reducer: (_, y) => y,
        default: () => null,
    }),
    token_usage: Annotation<TokenUsage>({
        reducer: (x, y) => ({
            input_tokens: x.input_tokens + (y.input_tokens || 0),
            output_tokens: x.output_tokens + (y.output_tokens || 0),
            total_tokens: x.total_tokens + (y.total_tokens || 0),
        }),
        default: () => ({ input_tokens: 0, output_tokens: 0, total_tokens: 0 }),
    }),
});

// ─── Runtime Config ───────────────────────────────────────────────────────────

export type AgentRuntimeConfig = {
    thread_id: string;
    student_id: string;    
    request_id: string;
    options?: {
        locale?: 'vi' | 'en';
        trace?: boolean;
    };
};
