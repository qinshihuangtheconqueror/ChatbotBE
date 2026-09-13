# [D1] LangGraph Flow — HustVA V3

> Adapted từ `aivoice-agent-clone`. Thay đổi chính: `execute_skills` chạy song song nhiều skill.

## Graph Flow

```mermaid
flowchart TD
    START([START]) --> ingress

    ingress["🚪 ingress\nReset transient fields\nValidate input kind\nmessage | resume"]

    load_context["📦 load_context\nLoad MongoDB checkpoint\nLoad conversation history\nBuild history_summary"]

    route["🔀 route\nGemini classify intent\nOutput: selected_skills[]\nintent_flags {needs_student, needs_policy, needs_course}"]

    execute_skills["⚡ execute_skills\nPromise.allSettled parallel\nRun all selected skills\nMerge skill_results[]"]

    subgraph SKILLS ["Skills — chạy song song"]
        STU["👤 StudentSkill\neHUST /grades\n/student/info\n/academicresult\n→ Redis cache"]
        SCH["📅 ScheduleSkill\neHUST /classes\n/exams /semesters\n→ Redis cache"]
        POL["📚 PolicySearchSkill\nQdrant vector search\nhust_knowledge collection\nCrossEncoder rerank"]
        CAD["🗺️ CourseAdvisorSkill\nNeo4j Cypher\nPrerequisite paths\nBlocked courses"]
    end

    compose["✍️ compose\nTeacherSkill\nGemini ainvoke\nMerge all skill_results\nGenerate final answer"]

    finalize["✅ finalize\nAppend AI message\nSave MongoDB checkpoint\nUpsert audit_log\nReturn FinalResult"]

    handle_error["❌ handle_error\nLog error\nGenerate error message\n→ finalize"]

    END_NODE([END])

    ingress -->|error?| handle_error
    ingress -->|ok| load_context
    load_context -->|error?| handle_error
    load_context -->|ok| route
    route -->|error?| handle_error
    route -->|ok| execute_skills
    execute_skills --> STU & SCH & POL & CAD
    STU & SCH & POL & CAD --> execute_skills
    execute_skills -->|error?| handle_error
    execute_skills -->|ok| compose
    compose -->|error?| handle_error
    compose -->|ok| finalize
    finalize --> END_NODE
    handle_error --> finalize

    classDef node fill:#1a1a2e,stroke:#4a90d9,color:#c0d8ff
    classDef skill fill:#1a2e1a,stroke:#2ecc71,color:#c0fdc0
    classDef terminal fill:#2d0000,stroke:#e74c3c,color:#ffd0d0

    class ingress,load_context,route,execute_skills,compose,finalize,handle_error node
    class STU,SCH,POL,CAD skill
    class START,END_NODE terminal
```

---

## Node Responsibilities

| Node | Input từ State | Output vào State |
|---|---|---|
| `ingress` | messages[-1] | Reset: selected_skills=[], skill_results=[], error=null |
| `load_context` | thread_id (config) | history_summary, student_context (từ cache) |
| `route` | messages[-1], history_summary | selected_skills[], intent_flags, routing metadata |
| `execute_skills` | selected_skills[], student_id | skill_results[] (1 per skill) |
| `compose` | skill_results[], messages | draft_answer, citations |
| `finalize` | draft_answer, citations | final_text, messages append AI msg |
| `handle_error` | error | draft_answer = error message |

---

## Conditional Edges

```typescript
// Sau mỗi node — nếu có lỗi → handle_error
function globalErrorGuard(state, defaultNext) {
  return state.error ? 'handle_error' : defaultNext;
}

// Route từ execute_skills
function afterExecuteSkills(state) {
  if (state.error) return 'handle_error';
  return 'compose'; // không có interrupt trong HustVA v3
}
```

---

## So sánh với aivoice-agent-clone

| Điểm | aivoice-agent-clone | HustVA V3 |
|---|---|---|
| `route` output | `selected_skill: string` | `selected_skills: string[]` |
| `execute_skill` | Gọi 1 skill | `Promise.allSettled` nhiều skill |
| `wait_external` | Có (interrupt) | **Không có** (HustVA không cần human handoff) |
| `apply_resume` | Có | **Không có** |
| `compose` | Node riêng | Vẫn là node riêng (TeacherSkill) |
