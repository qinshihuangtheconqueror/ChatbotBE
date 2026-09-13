# [D3] Skills Design — HustVA V3

> Skills = Executors trong thiết kế Python trước. Giữ nguyên `SkillDefinition` interface từ aivoice-agent-clone.

## SkillRegistry (giữ nguyên)

```typescript
interface SkillDefinition {
  name: string;
  description: string;
  run(state: HustVAState, config?: LangGraphRunnableConfig): Promise<Partial<HustVAState>>;
}
```

---

## 5 Skills của HustVA V3

### 1. StudentSkill

```
name: "student"
Khi nào chạy: intent_flags.needs_student = true
```

**Responsibilities:**
- Gọi eHUST API `/student/info` → lấy profile
- Gọi eHUST API `/grades` (không truyền semester → lấy tất cả kỳ)
- Gọi eHUST API `/academicresult` → GPA, CPA, warning level
- Cache kết quả vào Redis `student_cache:{studentId}` TTL 1800s

**Output vào State:**
```typescript
{
  student_context: StudentContext,
  skill_results: [{ skill: 'student', success: true, data: {...} }]
}
```

**HUST API calls:**
```
POST /student/info?studentId=&token=
POST /grades?studentId=&token=
POST /academicresult?studentId=&token=
```

---

### 2. ScheduleSkill

```
name: "schedule"
Khi nào chạy: intent_flags.needs_schedule = true
```

**Responsibilities:**
- Gọi `/semesters` → lấy danh sách kỳ, xác định kỳ hiện tại
- Gọi `/classes?semester=currentSemester` → TKB
- Gọi `/exams?semester=currentSemester` → lịch thi
- Cache vào Redis `schedule_cache:{studentId}:{semester}` TTL 3600s

**Output vào State:**
```typescript
{
  skill_results: [{ skill: 'schedule', success: true, data: { classes, exams, currentSemester } }]
}
```

---

### 3. PolicySearchSkill

```
name: "policy_search"
Khi nào chạy: intent_flags.needs_policy = true
```

**Responsibilities:**
- Embed câu hỏi cuối bằng Gemini Embedding (hoặc BGE-M3 nếu có)
- Tìm kiếm Qdrant collection `hust_knowledge`, filter `category`
- CrossEncoder rerank top-5 → giữ top-3
- Build citations từ `title`, `section`, `link` payload

**Qdrant Payload fields dùng:**
```
context  → text to embed + display
title    → citation title
section  → citation section
link     → citation URL
category → filter: DH | CTSV | SDH | Quy che | Chung
```

**Output vào State:**
```typescript
{
  skill_results: [{ skill: 'policy_search', success: true, data: { chunks: [...] } }],
  citations: [{ source: 'kb', id: 'kb-0', title, section, link }]
}
```

**Search config:**
```typescript
{
  top_k: 5,
  score_threshold: 0.72,
  filter: { category: { $in: ['DH', 'Chung'] } },  // dynamic per intent
  with_payload: true
}
```

---

### 4. CourseAdvisorSkill

```
name: "course_advisor"
Khi nào chạy: intent_flags.needs_course_graph = true
```

**Responsibilities:**
- Parse course IDs từ câu hỏi hoặc student_context.grades
- Query Neo4j — 3 Cypher patterns:

```cypher
-- 1. Tìm prerequisites (nhiều cấp)
MATCH path=(c {id: $courseId})<-[:PREREQUISITE_OF*]-(p)
RETURN p.name, p.id, length(path) as depth
ORDER BY depth

-- 2. Môn bị block nếu rớt courseId
MATCH (target {id: $courseId})<-[:PREREQUISITE_OF]-(blocked)
RETURN blocked.name, blocked.id

-- 3. Lộ trình chương trình
MATCH (c)-[:BELONGS_TO]->(p {id: $programId})
RETURN c.id, c.name, c.credits, c.semester
ORDER BY c.semester
```

**Output vào State:**
```typescript
{
  skill_results: [{
    skill: 'course_advisor',
    success: true,
    data: {
      prerequisites: [...],
      blockedCourses: [...],
      curriculum: [...]
    }
  }]
}
```

---

### 5. TeacherSkill (Compose node)

```
name: "teacher"  // không đăng ký trong SkillRegistry — đây là compose node
Chạy tại: node.compose.ts
```

**Responsibilities:**
- Nhận tất cả `skill_results[]` từ State
- Build context string từ student_context + policy chunks + course graph
- Gọi Gemini API với system prompt
- Trả về `draft_answer` + append AI message vào `messages`

**Prompt structure:**
```
System: [COMPOSE_PROMPT — từ PromptLoader]
User: 
  Câu hỏi: {messages[-1].content}
  
  Thông tin sinh viên: {student_context summary}
  
  Quy chế/Tài liệu tham khảo:
  {policy chunks từ PolicySearchSkill}
  
  Thông tin môn học:
  {course graph từ CourseAdvisorSkill}
  
  Lịch học/thi:
  {schedule từ ScheduleSkill}
  
  Compose câu trả lời chi tiết, có trích dẫn:
```

---

## Skill Registration (build-agent-facade.ts)

```typescript
const registry = new SkillRegistry();
registry.register(createStudentSkill(hustApiClient, redisClient));
registry.register(createScheduleSkill(hustApiClient, redisClient));
registry.register(createPolicySearchSkill(qdrantClient, llmFactory));
registry.register(createCourseAdvisorSkill(neo4jClient));
// TeacherSkill không register — dùng trong compose node
```

---

## Routing Decision Logic

```typescript
// node.route.ts — output schema
const RouteDecisionSchema = z.object({
  selected_skills: z.array(
    z.enum(['student', 'schedule', 'policy_search', 'course_advisor'])
  ).describe('Danh sách skills cần chạy song song'),
  
  intent_flags: z.object({
    needs_student: z.boolean(),
    needs_schedule: z.boolean(),
    needs_policy: z.boolean(),
    needs_course_graph: z.boolean(),
  }),
  
  intent: z.string(),
  confidence: z.number().min(0).max(1),
  reason: z.string(),
});
```

---

## Parallel Execution (node.execute-skills.ts)

```typescript
const results = await Promise.allSettled(
  state.selected_skills.map(skillName => {
    const skill = registry.get(skillName);
    return skill.run(state, config);
  })
);

// Merge all partial states
const merged = results.reduce((acc, result) => {
  if (result.status === 'fulfilled') {
    return deepMerge(acc, result.value);
  }
  return acc;
}, {});
```
