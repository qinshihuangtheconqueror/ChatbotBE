# AI Chatbot Platform — Backend

An intelligent conversational AI platform powered by **NestJS + LangGraph + Gemini + Milvus + Neo4j**.

---

## Prerequisites

| Requirement | Version |
|---|---|
| Node.js | ≥ 20 |
| Docker + Docker Compose | ≥ 24 |
| npm | ≥ 9 |

---

## 1. Repository Structure

```
.
├── docker-compose.dev.yml          ← Orchestrates all services
├── Backend/                        ← NestJS Backend (this repo)
│   ├── Dockerfile
│   ├── .env                        ← ⚠️ DO NOT commit — manual configuration required
│   ├── .env.example                ← Sample environment variables
│   ├── docs/
│   │   └── ENV_CONFIGURATION.md    ← Detailed environment configuration guide
│   ├── src/
│   │   ├── agent/                  ← LangGraph agent logic
│   │   ├── server/                 ← NestJS controllers, services
│   │   └── common/data/
│   │       ├── credentials.json    ← Demo login (bcrypt hashed)
│   │       └── knowledge_base.json ← ⚠️ DO NOT commit (large file) — manual seed required
│   └── scripts/
│       ├── seed-milvus.js          ← Seeds knowledge base into Milvus
│       ├── batch-eval-v3.js        ← Batch evaluation for RAG pipeline
│       └── quick-test-rag.js       ← Quick RAG pipeline testing script
└── Frontend/                       ← React Chat Widget
    └── Dockerfile
```

---

## 2. Dev Deployment (Docker — Recommended)

> Run the entire system (Frontend + Backend + MongoDB + Redis + Milvus + Neo4j) using **a single command**.

### Step 1: Prepare Environment File

```bash
cp .env.example .env
# Fill in required variables (see docs/ENV_CONFIGURATION.md for details)
```

**Required** variables:

| Variable | Description |
|---|---|
| `GEMINI_API_KEY` | Google Gemini API key |
| `JWT_SECRET` | Random string to sign JWTs (`openssl rand -hex 32`) |
| `MS_CLIENT_ID` | Azure App Client ID |
| `MS_CLIENT_SECRET` | Azure App Secret |

### Step 2: Build and Start

```bash
docker compose -f docker-compose.dev.yml up -d --build
```

### Step 3: Seed Knowledge Base to Milvus (Run Once)

```bash
docker exec -it backend-service npm run seed:milvus
```

> **Note:** Neo4j **does not require manual seeding**. Graph data is dynamically created when users log in.

### Running Services

| Service | Port | Purpose |
|---|---|---|
| **Frontend (Nginx)** | **80** | Chat widget UI |
| **Backend (NestJS)** | **3000** | REST API + SSE |
| MongoDB | 27017 | Conversation threads |
| Redis | 6379 | Cache + Rate limiting |
| Neo4j Browser | 7474 | Graph explorer (debug) |
| Neo4j Bolt | 7687 | Graph queries |
| Milvus | 19530 | Vector search |
| MinIO Console | 9001 | Object storage (debug) |

---

## 3. Local Development (Without Docker)

```bash
cp .env.example .env      # Fill in required variables
npm install
npm run start:dev         # ts-node watch mode
```

Server runs on `http://localhost:3000`.

---

## 4. Demo Login Credentials

See `src/common/data/credentials.json` for testing via `/v1/auth/demo-login`:

| Email | Password | UserID |
|---|---|---|
| demo1@test.com | Demo@2024 | 10001 |
| demo2@test.com | Demo@2024 | 10002 |

> ⚠️ Passwords are saved as **bcrypt hash** in the JSON file. Do not use these in production.

---

## 5. API Endpoints

### Authentication (Public — No JWT required)

| Method | Path | Description |
|---|---|---|
| POST | `/v1/auth/demo-login` | Demo login (email + password) → Returns JWT |
| POST | `/v1/auth/microsoft-login` | OAuth2 Login via Microsoft → Returns JWT |
| GET | `/health` | Health check |

### Chat (Requires JWT — Header: `Authorization: Bearer <token>`)

| Method | Path | Description |
|---|---|---|
| POST | `/v1/chat/respond` | Synchronous chat (full response) |
| POST | `/v1/chat/stream` | SSE streaming chat (progressive response) |
| POST | `/v1/chat/feedback` | Submit feedback (like/dislike) for AI responses |

### History (Requires JWT)

| Method | Path | Description |
|---|---|---|
| GET | `/v1/history/threads` | List conversation threads (sidebar) |
| GET | `/v1/history/threads/:threadId` | Get thread details |
| DELETE | `/v1/history/threads/:threadId` | Delete a thread |

### SSE Chat Stream Example

```bash
curl -X POST http://localhost:3000/v1/chat/stream \
  -H "Authorization: Bearer <jwt>" \
  -H "Content-Type: application/json" \
  -d '{"message": "Hello", "thread_id": "uuid", "student_id": "10001"}'
```

Returns events: `message.delta`, `run.completed`, `run.failed`.

---

## 6. Architecture Overview

```
Request → AuthMiddleware (JWT required) → RateLimitMiddleware
         → IngressNode (privacy guard)
         → LoadContextNode (External API → Neo4j)
         → RewriteNode (LLM query rewrite)
         → RuleRouter (regex, ~0ms)
           ↘ match → ExecuteSkills
           ↘ no match → SignalRouter (kNN BGE-M3 + Milvus)
             ↘ confident → ExecuteSkills
             ↘ low conf → ReAct LLM agent
         → EnrichCheckNode (auto-enrich ≤ 2 iterations)
         → ComposeNode (Gemini final answer)
         → FinalizeNode (save thread to MongoDB)
```

**Tech Stack:**
- **LLM:** Google Gemini 2.5 Flash
- **Embedding:** BAAI/bge-m3 (1024-dim, local via @xenova/transformers)
- **Vector Store:** Milvus Standalone (IVF_FLAT, COSINE)
- **Graph DB:** Neo4j 5.26 
- **Cache:** Redis 7 (rate limiting + 1h TTL cache)
- **Checkpointing:** MongoDB 7 (LangGraph thread persistence)

---

## 7. Security Notes

- **`.env`** — **NEVER commit**. Only transfer securely.
- **Endpoints `/v1/chat/*` and `/v1/history/*`** — JWT strictly required.
- **CORS** — Must be configured securely via `ALLOWED_ORIGINS` in `.env`.
- **JWT_SECRET** — Use a secure random string (≥ 32 chars) in production.
- **`knowledge_base.json`** — Not committed due to size. Must be deployed manually before seeding.
