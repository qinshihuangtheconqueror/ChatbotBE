# HustVA V3 — Hướng dẫn cấu hình biến môi trường

Tài liệu này giải thích **tất cả biến môi trường** cần thiết để chạy HustVA V3 Backend.

## Cách sử dụng

```bash
# 1. Copy file mẫu
cp .env.example .env

# 2. Điền giá trị thực vào .env (xem chi tiết bên dưới)

# 3. Khởi động
docker-compose -f docker-compose.dev.yml up -d
```

---

## Bảng tham chiếu nhanh

### 🔴 BẮT BUỘC — Không có sẽ không chạy được

| Biến | Mô tả | Lấy ở đâu |
|------|--------|-----------|
| `GEMINI_API_KEY` | API key cho Google Gemini LLM | [Google AI Studio](https://aistudio.google.com/apikey) → Create API Key |
| `JWT_SECRET` | Chuỗi bất kỳ để ký JWT token | Tự nghĩ ra hoặc generate: `openssl rand -hex 32` |
| `MS_CLIENT_ID` | Azure App Registration Client ID | [Azure Portal](https://portal.azure.com) → App registrations → Overview |
| `MS_CLIENT_SECRET` | Azure App Client Secret | Azure Portal → App registrations → Certificates & secrets |
| `HUST_API_TOKEN` | Token truy cập eHUST Partner API | Liên hệ quản trị viên hệ thống eHUST |
| `HUST_AUTHORIZATION_TOKEN` | Bearer token cho eHUST | Cùng nguồn với HUST_API_TOKEN |

### 🟡 TÙY CHỌN — Có default, thay đổi khi cần

| Biến | Default | Khi nào cần đổi |
|------|---------|-----------------|
| `PORT` | `3000` | Khi port 3000 bị chiếm |
| `NODE_ENV` | `development` | Đặt `production` khi deploy thật |
| `GEMINI_MODEL` | `gemini-2.5-flash` | Đổi sang model khác nếu cần |
| `MONGO_URI` | `mongodb://localhost:27017/hustva_v3` | Khi dùng MongoDB Atlas hoặc Docker internal network |
| `MILVUS_URI` | `http://localhost:19530` | Khi dùng Zilliz Cloud hoặc Docker internal DNS |
| `MILVUS_TOKEN` | _(rỗng)_ | Chỉ cần khi dùng Zilliz Cloud (managed Milvus) |
| `NEO4J_PASSWORD` | _(rỗng)_ | Đặt password cho Neo4j (docker-compose đã set `hustva_dev`) |
| `REDIS_URL` | `redis://localhost:6379` | Khi Redis chạy trên host/port khác |
| `ALLOWED_ORIGINS` | `http://localhost:80,...` | **Bắt buộc đổi khi deploy production** — thêm domain FE thật |
| `MS_TENANT_ID` | `common` | Đặt tenant ID cụ thể của HUST nếu chỉ muốn cho mail @sis |
| `LLM_TEMPERATURE` | `0.1` | Tăng lên 0.3-0.5 nếu muốn câu trả lời đa dạng hơn |
| `LLM_MAX_TOKENS` | `2048` | Tăng nếu câu trả lời bị cắt ngắn |

### 🟢 KHÔNG CẦN THIẾT — Chỉ dùng cho tính năng nâng cao

| Biến | Default | Ghi chú |
|------|---------|---------|
| `LANGFUSE_PUBLIC_KEY` | _(rỗng)_ | Đăng ký tại [cloud.langfuse.com](https://cloud.langfuse.com) để theo dõi AI tracing |
| `LANGFUSE_SECRET_KEY` | _(rỗng)_ | Cùng nguồn với Public Key |
| `TRACING_PROVIDER` | `langfuse` | Đặt `none` để tắt tracing (khi chưa có key Langfuse) |
| `HUST_JSESSIONID` | _(rỗng)_ | Session cookie nâng cao cho một số API eHUST |
| `HUST_DEFAULT_SEMESTER` | _(rỗng)_ | Mã kỳ học mặc định (e.g. `20242`) — auto-detect nếu để rỗng |
| `EMBEDDING_API_URL` | `http://localhost:8080` | Chỉ cần nếu dùng external embedding server (hiện tại BGE-M3 chạy local) |
| `LLM_FALLBACK_MODELS` | _(rỗng)_ | Danh sách model dự phòng, phân cách bằng dấu phẩy |
| `REDIS_TTL_SECONDS` | `3600` | TTL cache mặc định (1 giờ) |

---

## Hướng dẫn theo từng môi trường

### Development (Local)

```env
# Chỉ cần 2 biến bắt buộc, còn lại dùng default
GEMINI_API_KEY=AIzaSy...
JWT_SECRET=any-random-string

# Microsoft login (nếu test)
MS_CLIENT_ID=adcd2204-19d4-4e37-915b-391328dd362c
MS_CLIENT_SECRET=your-secret

# Tắt tracing (chưa có key Langfuse)
TRACING_PROVIDER=none
```

### Production / Staging

```env
NODE_ENV=production

# BẮT BUỘC
GEMINI_API_KEY=AIzaSy...
JWT_SECRET=<chuỗi-dài-random-32-ký-tự-trở-lên>
HUST_API_TOKEN=<token-từ-quản-trị-eHUST>
HUST_AUTHORIZATION_TOKEN=Bearer <token>
MS_CLIENT_ID=<azure-client-id>
MS_CLIENT_SECRET=<azure-secret>

# Infrastructure (Docker internal DNS)
MONGO_URI=mongodb://mongodb:27017/hustva_v3
REDIS_URL=redis://redis:6379
NEO4J_URI=bolt://neo4j:7687
NEO4J_PASSWORD=hustva_dev
MILVUS_URI=http://milvus:19530

# CORS — thêm domain frontend production
ALLOWED_ORIGINS=https://dev-hustva.vbeecore.com,https://hustva.vn

# Langfuse (khuyến khích bật)
TRACING_PROVIDER=langfuse
LANGFUSE_PUBLIC_KEY=pk-lf-...
LANGFUSE_SECRET_KEY=sk-lf-...
```

---

## Lưu ý quan trọng

1. **KHÔNG commit file `.env` lên Git** — file này chứa secrets. Chỉ commit `.env.example`.
2. **Docker Compose** đã tự override một số biến (MONGO_URI, REDIS_URL...) bằng Docker internal DNS. Xem `docker-compose.dev.yml` để biết chi tiết.
3. **Sau lần deploy đầu tiên**, phải chạy seed Milvus:
   ```bash
   docker-compose exec hustva-be npm run seed:milvus
   ```
4. **ALLOWED_ORIGINS** — nếu FE chạy trên domain khác, BẮT BUỘC phải thêm domain đó vào, nếu không FE sẽ bị lỗi CORS.
5. **MS_CLIENT_SECRET** — nếu để rỗng, tính năng đăng nhập bằng Email HUST sẽ không hoạt động.
