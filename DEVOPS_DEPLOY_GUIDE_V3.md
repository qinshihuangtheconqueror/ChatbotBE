# Hướng Dẫn Cập Nhật & Deploy HUSTVA V3 (Dành cho DevOps)

Tài liệu này tổng hợp các thay đổi quan trọng và các thao tác bắt buộc DevOps cần thực hiện để đưa bản cập nhật mới nhất của HUSTVA-V3 lên môi trường Production/Staging một cách an toàn.

---

## 1. Cập Nhật Backend (HUSTVA-V3)

### 1.1. Xóa Cache và Rebuild Lại Docker Image (Bắt Buộc)

**Lý do:** `Dockerfile` đã được thay đổi từ `node:20-alpine` sang `node:20-slim`. Hệ thống AI Reranker (BGE-M3/ONNX) không thể khởi chạy trên môi trường `alpine` do thiếu hụt thư viện C tiêu chuẩn (`glibc`). 

**Thao tác:**
Không sử dụng lại cache cũ. Phải bắt buộc build lại từ đầu để hệ thống nhận cấu trúc nhân Debian mới.
```bash
docker-compose build --no-cache hustva-be
docker-compose up -d hustva-be
```

### 1.2. Chạy Lệnh Seed Vector Database (Cực Kỳ Quan Trọng)

**Lý do:** Bản cập nhật này đã fix bug cấu trúc dữ liệu lưu vào Milvus. DB cũ lưu dưới định dạng hiện không tương thích hoặc có `row_count: 0`. Bạn phải nạp lại kho dữ liệu RAG.

**Thao tác:**
Sau khi cụm Docker đi vào trạng thái `Healthy`, thực thi lệnh `seed:milvus` bên trong container của Backend (đợi từ 5-10 phút cho model vectorize dữ liệu).
```bash
docker-compose exec hustva-be npm run seed:milvus
```
*Ghi chú: Lệnh trên sẽ tự động kết nối với Milvus, khởi tạo Collection `hust_knowledge` và embed ~2400 chunks từ file JSON.*

### 1.3. Bổ Sung Các Biến Môi Trường (.env)

DevOps cần đảm bảo file `.env` chạy trên container của Backend phải chứa đầy đủ các khóa mật mã sau:

```env
# 1. JWT và RAG fallback
JWT_SECRET="<chuỗi_bí_mật_sinh_tự_động_để_bảo_mật_đánh_giá>"
GEMINI_API_KEY="<api_key_của_google_gemini>"

# 2. CORS — danh sách domain FE được phép gọi API (phân cách bằng dấu phẩy)
ALLOWED_ORIGINS="https://<your-frontend-domain>.com"

# 3. Hệ sinh thái Đăng nhập Microsoft 365 (eHUST Email)
# Lấy từ Azure Portal -> App Registrations
MS_CLIENT_ID="<Azure_Application_Client_ID>"
MS_CLIENT_SECRET="<Azure_Client_Secret>"
MS_TENANT_ID="common" # (Hoặc tenant id cụ thể nếu chỉ cho phép mail HUST)

# 4. Langfuse (Thu thập tracing các hành động suy nghĩ của agent)
LANGFUSE_PUBLIC_KEY="<langfuse_pk>"
LANGFUSE_SECRET_KEY="<langfuse_sk>"
LANGFUSE_HOST="https://cloud.langfuse.com"
```

> **Lưu ý:** Neo4j **không cần seed thủ công** — dữ liệu đồ thị sinh viên tự động được tạo khi sinh viên đăng nhập lần đầu.

---

## 2. Cập Nhật Frontend (HUSTVA-V3-FE)

**Lý do:** Luồng tính năng Rate (Like/Dislike phản hồi của AI) đã được đấu nối thẳng vào hệ thống V3 mới để ghim theo Thread Context & Cấu trúc MS Login thay đổi.

**Thao tác:** 
Trong quá trình Build (CI/CD) hoặc ở File `.env` chứa biến của Web Server, bắt buộc cấu hình đường dẫn API nối FE vào BE V3:

```env
# URL trỏ sang Backend API của HustVA V3 Production
REACT_APP_HUSTVA_URL=https://<your-backend-v3-domain>.com
```

*Nếu không được gán, ứng dụng sẽ gọi về `http://localhost:3000` dẫn đến lỗi `CORS / Network Error` cho End User.*
