import { Annotation } from '@langchain/langgraph';
import { BaseMessage } from '@langchain/core/messages';

// ─── Domain Types ────────────────────────────────────────────────────────────

export type SkillResult = {
    skill: string;
    success: boolean;
    data?: Record<string, unknown>;
    error?: string;
    llm_instruction?: string;
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
    anchor?: string;
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
    rule_matched?: boolean;
};

export type TokenUsage = {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
};

export type IntentFlags = {
    need_policy?: boolean;
    need_schedule?: boolean;
    need_academic?: boolean;
    need_profile?: boolean;
    need_transcript?: boolean;
    need_teacher_advisor?: boolean;
    privacy_blocked?: boolean;
    [key: string]: unknown;
};

export type RetrievedContext = {
    title?: string;
    content: string;
    source?: string;
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

    policy_contexts: Annotation<RetrievedContext[]>({
    reducer: (_, b) => b,
    default: () => [],
}),

    // ── Routing ───────────────────────────────────────────────────────────
    ml_route: Annotation<{ agent: string; confidence: number; intent: string; use_ml: boolean; error?: string; }>(),

    selected_skills: Annotation<string[]>({
        reducer: (_, y) => y,
        default: () => [],
    }),

    routing: Annotation<RoutingMetadata | null>({
        reducer: (_, y) => y,
        default: () => null,
    }),

    intent_flags: Annotation<IntentFlags | null>({
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

        current_agent: Annotation<string | null>({
    reducer: (_, y) => y,
    default: () => null,
    }),

    supervisor_decision: Annotation<{
    agents: string[];
    reasoning?: string;
} | null>({
    reducer: (_, y) => y,
    default: () => null,
}),

    // ── Student Context ───────────────────────────────────────────────────

    student_context: Annotation<StudentContext | null>({
        reducer: (_, y) => y,
        default: () => null,
    }),

    target_semester: Annotation<string | null>({
        reducer: (_, y) => y,
        default: () => null,
    }),

    // ── Skill Data ────────────────────────────────────────────────────────

    ehust_profile_data: Annotation<Record<string, unknown> | null>({
        reducer: (_, y) => y,
        default: () => null,
    }),

    ehust_transcript_data: Annotation<Record<string, unknown> | null>({
        reducer: (_, y) => y,
        default: () => null,
    }),

    teacher_advisor_data: Annotation<Record<string, unknown> | null>({
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
        default: () => ({
            input_tokens: 0,
            output_tokens: 0,
            total_tokens: 0,
        }),
    }),
});

// ─── Runtime Config ─────────────────────────────────────────────────────────

export type AgentRuntimeConfig = {
    thread_id: string;
    student_id: string;
    request_id: string;

    options?: {
        locale?: 'vi' | 'en';
        trace?: boolean;
    };
};

export type AppState = typeof StateAnnotation.State;