# [D5] Sequence Diagram — HustVA V3

> Use case: "Em bị cảnh cáo học vụ, quy định xử lý sao? Cần học lại những môn nào?"
> Multi-skill: student + policy_search + course_advisor chạy parallel

```mermaid
sequenceDiagram
    actor SV as Student
    participant GW as NestJS API
    participant AGT as AgentFacade
    participant GRAPH as LangGraph
    participant STU as StudentSkill
    participant POL as PolicySkill
    participant CAD as CourseAdvisorSkill
    participant TEA as TeacherSkill
    participant MG as MongoDB
    participant QD as Qdrant
    participant NEO as Neo4j
    participant REDIS as Redis
    participant HUST as eHUST API
    participant LLM as Gemini API

    SV->>GW: POST /chat/respond {thread_id, studentId, message}
    GW->>AGT: facade.invoke(input, ctx)
    AGT->>GRAPH: graph.invoke({messages: [HumanMessage]}, config)

    Note over GRAPH: NODE ingress
    GRAPH->>GRAPH: Reset transient fields

    Note over GRAPH,MG: NODE load_context
    GRAPH->>MG: Load checkpoint (thread_id)
    MG-->>GRAPH: history (3 turns)

    Note over GRAPH,LLM: NODE route
    GRAPH->>LLM: Classify intent (fast model, structured output)
    LLM-->>GRAPH: selected_skills=[student,policy_search,course_advisor] confidence=0.91

    Note over GRAPH: NODE execute_skills - Promise.allSettled

    par StudentSkill
        GRAPH->>STU: skill.run(state)
        STU->>REDIS: GET student_cache:202416773
        REDIS-->>STU: MISS
        STU->>HUST: POST /student/info?studentId=202416773
        HUST-->>STU: {fullName, programId:IT-E15, school}
        STU->>HUST: POST /grades?studentId=202416773
        HUST-->>STU: grades[] across all semesters
        STU->>HUST: POST /academicresult?studentId=202416773
        HUST-->>STU: [{semester:20242, level:1, gpa:2.1}]
        STU->>REDIS: SET student_cache:202416773 TTL=1800s
        STU-->>GRAPH: student_context {gpa:2.1, warningLevel:1, failedCourses:[...]}
    and PolicySearchSkill
        GRAPH->>POL: skill.run(state)
        POL->>LLM: Embed query (text-embedding-004)
        LLM-->>POL: vector[1024]
        POL->>QD: search hust_knowledge filter={category:DH} top_k=5
        QD-->>POL: score=0.91 Dieu 38 Canh cao hoc vu
        QD-->>POL: score=0.87 Dieu 40 Buoc thoi hoc
        QD-->>POL: score=0.83 Dieu 8 Cai thien hoc luc
        POL-->>GRAPH: skill_result + citations[3]
    and CourseAdvisorSkill
        GRAPH->>CAD: skill.run(state)
        CAD->>NEO: MATCH failed courses prerequisites
        NEO-->>CAD: IT3190 blocks IT4043 IT3120
        CAD->>NEO: MATCH retry schedule per semester
        NEO-->>CAD: MI2020 HK1 IT3190 HK2 IT1003 HK2
        CAD-->>GRAPH: skill_result {prerequisites, blockedCourses, retrySchedule}
    end

    Note over GRAPH,LLM: NODE compose - TeacherSkill
    GRAPH->>TEA: compose(all skill_results)
    TEA->>LLM: ainvoke full context prompt
    LLM-->>TEA: answer with citations
    TEA-->>GRAPH: draft_answer final_text citations

    Note over GRAPH,MG: NODE finalize
    GRAPH->>MG: Save checkpoint
    GRAPH->>MG: Upsert audit_log {trace_id, intent, latency}
    MG-->>GRAPH: saved

    GRAPH-->>AGT: finalState
    AGT-->>GW: FinalResult {status:completed, assistant:{text, citations}}
    GW-->>SV: 200 OK {answer, citations:[Dieu 38, 40...], latency_ms:2300}
```

---

## Event Stream (SSE mode — /chat/stream)

```
run.started       → {run_id, thread_id, ts}
message.delta     → {delta: "Theo Điều 38..."} × N  (streaming tokens)
message.delta     → {delta: "...cần học lại MI2020"}
run.completed     → {status: "completed"}
```

---

## Redis Cache Flow — StudentSkill

```mermaid
flowchart LR
    A[StudentSkill.run] --> B{REDIS GET\nstudent_cache:id}
    B -->|HIT| C[Return cached StudentContext]
    B -->|MISS| D[Call eHUST /student/info\n/grades /academicresult]
    D --> E[REDIS SET TTL=1800s]
    E --> C
```

---

## Error Flow

```mermaid
sequenceDiagram
    participant GRAPH as LangGraph
    participant STU as StudentSkill
    participant HUST as eHUST API
    participant ERR as handle_error

    GRAPH->>STU: skill.run(state)
    STU->>HUST: POST /grades
    HUST-->>STU: 503 Service Unavailable
    STU-->>GRAPH: skill_result {success: false, error: "HUST API unavailable"}
    Note over GRAPH: Partial failure - other skills OK
    GRAPH->>GRAPH: Continue with available skill_results
    GRAPH->>ERR: error state if ALL skills fail
    ERR-->>GRAPH: draft_answer = "Xin lỗi, hiện tại không thể lấy thông tin..."
```
