# HustVA V3 — Backend

HUST Academic Assistant powered by **NestJS + LangGraph + Gemini + Milvus + Neo4j**.

---

## Prerequisites

| Requirement | Version |
|---|---|
| Node.js | ≥ 20 |
| Docker + Docker Compose | ≥ 24 |
| npm | ≥ 9 |

---

## 1. Cấu trúc Repo

```
d:\Project 2- GR 2\
├── docker-compose.dev.yml          ← Tổng tư lệnh: khởi động toàn bộ 8 services
├── HustVA-V3/                      ← Backend NestJS (repo này)
│   ├── Dockerfile
│   ├── .env                        ← ⚠️ KHÔNG commit — điền thủ công
│   ├── .env.example                ← Mẫu env có comment hướng dẫn
│   ├── docs/
│   │   └── ENV_CONFIGURATION.md    ← Hướng dẫn chi tiết cấu hình env
│   ├── src/
│   │   ├── agent/                  ← LangGraph agent logic
│   │   ├── server/                 ← NestJS controllers, services
│   │   └── common/data/
│   │       ├── credentials.json    ← Demo login (bcrypt hashed)
│   │       └── knowledge_base.json ← ⚠️ KHÔNG commit (2.8MB) — seed thủ công
│   └── scripts/
│       ├── seed-milvus.js          ← Seed knowledge base vào Milvus
│       ├── batch-eval-v3.js        ← Đánh giá RAG hàng loạt (regression test)
│       └── quick-test-rag.js       ← Test nhanh RAG pipeline
└── HUSTVA-V3-FE/                   ← Frontend React Widget
    └── chatbot-livechat-frontend/
        └── Dockerfile
```

---

## 2. Deploy Dev (Docker — Recommended)

> Chạy toàn bộ hệ thống (FE + BE + MongoDB + Redis + Milvus + Neo4j) bằng **1 lệnh duy nhất** từ thư mục gốc:

### Bước 1: Chuẩn bị file môi trường

```bash
cd HustVA-V3
cp .env.example .env
# Điền các biến bắt buộc (xem docs/ENV_CONFIGURATION.md để biết chi tiết)
```

Các biến **bắt buộc** phải điền:

| Biến | Mô tả | Lấy ở đâu |
|---|---|---|
| `GEMINI_API_KEY` | Google Gemini API key | [Google AI Studio](https://aistudio.google.com/apikey) |
| `JWT_SECRET` | Chuỗi random để ký JWT | `openssl rand -hex 32` hoặc tự đặt |
| `HUST_API_TOKEN` | eHUST partner API token | Quản trị viên eHUST |
| `HUST_AUTHORIZATION_TOKEN` | Bearer token eHUST | Cùng nguồn |
| `MS_CLIENT_ID` | Azure App Client ID | [Azure Portal](https://portal.azure.com) |
| `MS_CLIENT_SECRET` | Azure App Secret | Azure Portal → Certificates & secrets |

### Bước 2: Build và khởi động

```bash
# Từ thư mục gốc (d:\Project 2- GR 2\)
docker compose -f docker-compose.dev.yml up -d --build
```

### Bước 3: Seed Knowledge Base vào Milvus (chạy 1 lần)

```bash
docker exec -it hustva-v3-be-1 npm run seed:milvus
```

> **Lưu ý:** Neo4j **không cần seed thủ công**. Dữ liệu đồ thị sinh viên (điểm, môn học) tự động được tạo khi sinh viên đăng nhập lần đầu.

### Services sau khi khởi động

| Service | Port | Mục đích |
|---|---|---|
| **Frontend (Nginx)** | **80** | Chat widget UI |
| **Backend (NestJS)** | **3000** | REST API + SSE |
| MongoDB | 27017 | Conversation threads |
| Redis | 6379 | Cache + Rate limiting |
| Neo4j Browser | 7474 | Course graph (debug) |
| Neo4j Bolt | 7687 | Graph queries |
| Milvus | 19530 | Vector search |
| MinIO Console | 9001 | Object storage (debug) |

---

## 3. Chạy Local (Development — không Docker)

```bash
cd HustVA-V3
cp .env.example .env      # điền các biến cần thiết
npm install
npm run start:dev         # ts-node watch mode
```

Server chạy tại `http://localhost:3000`.

---

## 4. Demo Login Credentials

File `src/common/data/credentials.json` — dùng cho test/demo qua endpoint `/v1/auth/demo-login`:

| Email | Password | MSSV |
|---|---|---|
| sv1@hustva.test | Hustva@2024 | 20225976 |
| sv2@hustva.test | Hustva@2024 | 20220001 |
| sv3@hustva.test | Hustva@2024 | 20220002 |

> ⚠️ Mật khẩu được lưu dưới dạng **bcrypt hash** trong file JSON. Không dùng credentials này trên production.

---

## 5. API Endpoints

### Authentication (Public — không cần JWT)

| Method | Path | Mô tả |
|---|---|---|
| POST | `/v1/auth/login` | Đăng nhập bằng MSSV + mật khẩu eHUST → JWT |
| POST | `/v1/auth/demo-login` | Đăng nhập demo (email + password) → JWT |
| POST | `/v1/auth/microsoft-login` | Đăng nhập bằng Email HUST (OAuth2) → JWT |
| GET | `/health` | Health check |

### Chat (Yêu cầu JWT — Header: `Authorization: Bearer <token>`)

| Method | Path | Mô tả |
|---|---|---|
| POST | `/v1/chat/respond` | Chat đồng bộ (response đầy đủ) |
| POST | `/v1/chat/stream` | Chat SSE streaming (progressive response) |
| POST | `/v1/chat/feedback` | Gửi đánh giá (like/dislike) cho tin nhắn |

### History (Yêu cầu JWT)

| Method | Path | Mô tả |
|---|---|---|
| GET | `/v1/history/threads` | Danh sách cuộc trò chuyện (sidebar) |
| GET | `/v1/history/threads/:threadId` | Chi tiết 1 cuộc trò chuyện |
| DELETE | `/v1/history/threads/:threadId` | Xóa 1 cuộc trò chuyện |

### Ví dụ Chat Stream (SSE)

```bash
curl -X POST http://localhost:3000/v1/chat/stream \
  -H "Authorization: Bearer <jwt>" \
  -H "Content-Type: application/json" \
  -d '{"message": "điểm kỳ này của em", "thread_id": "uuid", "student_id": "20225976"}'
```

Events trả về: `message.delta`, `run.completed`, `run.failed`.

---

## 6. Kiến trúc

```
Request → AuthMiddleware (JWT required) → RateLimitMiddleware
         → IngressNode (privacy guard)
         → LoadContextNode (eHUST API → Neo4j)
         → RewriteNode (LLM query rewrite)
         → RuleRouter (regex, ~0ms)
           ↘ match → ExecuteSkills (10 skills)
           ↘ no match → SignalRouter (kNN BGE-M3 + Milvus)
             ↘ confident → ExecuteSkills
             ↘ low conf → ReAct LLM agent
         → EnrichCheckNode (auto-enrich ≤ 2 iterations)
         → ComposeNode (Gemini final answer)
         → FinalizeNode (save thread to MongoDB)
```

**Stack:**
- **LLM:** Google Gemini 2.5 Flash
- **Embedding:** BAAI/bge-m3 (1024-dim, local via @xenova/transformers)
- **Vector Store:** Milvus Standalone (IVF_FLAT, COSINE)
- **Graph DB:** Neo4j 5.26 (course prerequisites + student data)
- **Cache:** Redis 7 (rate limiting + 1h TTL cache)
- **Checkpoint:** MongoDB 7 (LangGraph thread persistence)

---

## 7. Lưu ý bảo mật

- **`.env`** — **KHÔNG BAO GIỜ commit**. Chỉ truyền tay hoặc qua kênh bảo mật.
- **Mọi endpoint `/v1/chat/*` và `/v1/history/*`** — Bắt buộc JWT. Không có fallback body `student_id`.
- **CORS** — Chỉ cho phép origin trong `ALLOWED_ORIGINS`. Cấu hình trong `.env`.
- **JWT_SECRET** — Dùng chuỗi random ≥ 32 ký tự trên production.
- **`knowledge_base.json`** — Không commit (2.8MB). Copy thủ công lên server trước khi seed.
